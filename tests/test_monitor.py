"""Тести планування сповіщень (дедуплікація та черги різних чатів)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import aiohttp
import pytest
from aiohttp.client_reqrep import ConnectionKey

from zoe_bot.config import Settings
from zoe_bot.monitor import Monitor, plan_notifications, post_state_key
from zoe_bot.parser import extract_post
from zoe_bot.state import ChatSubscription, StateStore

from .conftest import SAMPLE_HTML


@pytest.fixture()
async def store(tmp_path: Path) -> AsyncIterator[StateStore]:
    state = StateStore(tmp_path / "state.db")
    await state.init()
    yield state
    await state.close()


def _post():
    post = extract_post(SAMPLE_HTML)
    assert post is not None
    return post


async def test_plan_for_two_chats_with_different_queues(store: StateStore) -> None:
    post = _post()
    chats = [ChatSubscription(1, None), ChatSubscription(2, "9.9")]

    planned = await plan_notifications(post, chats, "5.1", store)

    assert len(planned) == 2
    by_chat = {message.chat_id: message for message in planned}
    assert "Черга 5.1: 08:00 - 10:00, 16:00 - 20:00" in by_chat[1].text
    assert "відсутня" in by_chat[2].text
    assert by_chat[1].state_key == post_state_key(post.post_id, "5.1", 1)


async def test_plan_deduplicates_after_send(store: StateStore) -> None:
    post = _post()
    chats = [ChatSubscription(1, None)]

    first = await plan_notifications(post, chats, "5.1", store)
    assert len(first) == 1
    for message in first:
        await store.set_meta(message.state_key, message.state_value)

    second = await plan_notifications(post, chats, "5.1", store)
    assert second == []


async def test_plan_resends_when_state_changes(store: StateStore) -> None:
    post = _post()
    chats = [ChatSubscription(1, None)]

    for message in await plan_notifications(post, chats, "5.1", store):
        await store.set_meta(message.state_key, message.state_value)

    # той самий пост, але чат перейшов на чергу, якої немає в графіку
    changed = await plan_notifications(post, [ChatSubscription(1, "9.9")], "5.1", store)
    assert len(changed) == 1
    assert "відсутня" in changed[0].text


async def test_plan_resends_for_new_post(store: StateStore) -> None:
    post = _post()
    chats = [ChatSubscription(1, None)]
    for message in await plan_notifications(post, chats, "5.1", store):
        await store.set_meta(message.state_key, message.state_value)

    assert await plan_notifications(post, chats, "5.1", store) == []


def test_post_state_key_format() -> None:
    assert post_state_key("post-1", "5.1", 42) == "post_state:post-1:5.1:42"


class _FakeResponse:
    status = 200

    async def __aenter__(self) -> _FakeResponse:
        return self

    async def __aexit__(self, *args: object) -> bool:
        return False

    def raise_for_status(self) -> None:
        pass

    async def text(self) -> str:
        return "<html>ok</html>"


class _FailingResponse(_FakeResponse):
    async def __aenter__(self) -> _FailingResponse:
        key = ConnectionKey("www.zoe.com.ua", 443, True, None, None, None, None)
        raise aiohttp.ClientConnectorCertificateError(key, ValueError("bad chain"))


class _FakeSession:
    def __init__(self) -> None:
        self.ssl_args: list[bool] = []

    def get(self, url: str, ssl: bool = True) -> _FakeResponse:
        self.ssl_args.append(ssl)
        return _FailingResponse() if ssl is not False else _FakeResponse()


def _monitor(store: StateStore) -> Monitor:
    settings = Settings(_env_file=None, BOT_TOKEN="t", CHAT_ID="1")  # type: ignore[arg-type]
    return Monitor(settings, store, None)  # type: ignore[arg-type]


async def test_tls_fallback_on_certificate_error(store: StateStore) -> None:
    monitor = _monitor(store)
    session = _FakeSession()

    assert await monitor._fetch_html(session) == "<html>ok</html>"  # type: ignore[arg-type]
    assert monitor.tls_verified is False
    assert session.ssl_args == [True, False]

    # наступні запити одразу йдуть без перевірки TLS
    assert await monitor._fetch_html(session) == "<html>ok</html>"  # type: ignore[arg-type]
    assert session.ssl_args == [True, False, False]


async def test_tls_verified_on_success(store: StateStore) -> None:
    monitor = _monitor(store)

    class _OkSession(_FakeSession):
        def get(self, url: str, ssl: bool = True) -> _FakeResponse:
            self.ssl_args.append(ssl)
            return _FakeResponse()

    session = _OkSession()
    await monitor._fetch_html(session)  # type: ignore[arg-type]
    assert monitor.tls_verified is True
    assert session.ssl_args == [True]
