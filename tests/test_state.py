"""Тести сховища стану (SQLite)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from zoe_bot.state import StateStore


@pytest.fixture()
async def store(tmp_path: Path) -> AsyncIterator[StateStore]:
    state = StateStore(tmp_path / "state.db")
    await state.init()
    yield state
    await state.close()


async def test_meta_roundtrip(store: StateStore) -> None:
    assert await store.get_meta("missing") is None
    await store.set_meta("key", "value")
    assert await store.get_meta("key") == "value"
    await store.set_meta("key", "value2")
    assert await store.get_meta("key") == "value2"


async def test_ensure_chat_is_idempotent(store: StateStore) -> None:
    await store.ensure_chat(1)
    await store.ensure_chat(1)
    chats = await store.list_chats()
    assert [chat.chat_id for chat in chats] == [1]
    assert chats[0].queue is None


async def test_set_chat_queue(store: StateStore) -> None:
    await store.ensure_chat(10)
    await store.set_chat_queue(10, "4.2")
    assert await store.get_chat_queue(10) == "4.2"
    assert (await store.list_chats())[0].queue == "4.2"
    assert (await store.list_chats())[0].queue_or("5.1") == "4.2"


async def test_set_chat_queue_creates_chat(store: StateStore) -> None:
    await store.set_chat_queue(20, "3.1")
    assert await store.get_chat_queue(20) == "3.1"


async def test_list_chats_order(store: StateStore) -> None:
    for chat_id in (100, 200, 300):
        await store.ensure_chat(chat_id)
    assert [chat.chat_id for chat in await store.list_chats()] == [100, 200, 300]


async def test_drop_stale_post_state(store: StateStore) -> None:
    prefix = "post_state"
    await store.set_meta(f"{prefix}:old:5.1:1", "x")
    await store.set_meta(f"{prefix}:old:5.1:2", "x")
    await store.set_meta(f"{prefix}:new:5.1:1", "y")
    await store.set_meta("last_post_id", "new")

    dropped = await store.drop_stale_post_state("new", prefix)

    assert dropped == 2
    assert await store.get_meta(f"{prefix}:new:5.1:1") == "y"
    assert await store.get_meta(f"{prefix}:old:5.1:1") is None
    assert await store.get_meta("last_post_id") == "new"
