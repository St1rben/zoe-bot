"""Основний цикл моніторингу: завантаження, планування, сповіщення, дайджест."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import aiohttp

from . import messages
from .config import Settings
from .notifier import Notifier
from .parser import OUTAGE_URL, OutagePost, extract_post, scenario_for
from .state import ChatSubscription, StateStore

logger = logging.getLogger(__name__)

META_LAST_POST_ID = "last_post_id"
META_LAST_POST_TITLE = "last_post_title"
META_LAST_CHECK_AT = "last_check_at"
META_DIGEST_DATE = "digest_sent_date"
POST_STATE_PREFIX = "post_state"


def post_state_key(post_id: str, queue: str, chat_id: int) -> str:
    return f"{POST_STATE_PREFIX}:{post_id}:{queue}:{chat_id}"


@dataclass(frozen=True)
class PlannedMessage:
    """Готове до відправки повідомлення та стан, який воно фіксує."""

    chat_id: int
    text: str
    state_key: str
    state_value: str


def _plan_for_chat(post: OutagePost, chat: ChatSubscription, default_queue: str) -> PlannedMessage:
    queue = chat.queue_or(default_queue)
    scenario, times = scenario_for(post, queue)
    return PlannedMessage(
        chat_id=chat.chat_id,
        text=messages.format_update(post.title, queue, scenario, times),
        state_key=post_state_key(post.post_id, queue, chat.chat_id),
        state_value=json.dumps({"state": scenario, "times": times}),
    )


async def plan_notifications(
    post: OutagePost,
    chats: list[ChatSubscription],
    default_queue: str,
    state: StateStore,
) -> list[PlannedMessage]:
    """Повертає лише ті повідомлення, стан яких ще не надсилався."""
    planned: list[PlannedMessage] = []
    for chat in chats:
        message = _plan_for_chat(post, chat, default_queue)
        if await state.get_meta(message.state_key) != message.state_value:
            planned.append(message)
    return planned


class Monitor:
    def __init__(self, settings: Settings, state: StateStore, notifier: Notifier) -> None:
        self._settings = settings
        self._state = state
        self._notifier = notifier
        self.started_at = time.time()
        self.last_check_at: float | None = None
        self.last_post_id: str | None = None
        self.last_error: str | None = None
        self.check_count = 0
        self.tls_verified: bool | None = None
        self._stop = asyncio.Event()

    @property
    def uptime_sec(self) -> float:
        return time.time() - self.started_at

    def request_stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        headers = {"User-Agent": "ZoeOutageBot/2.0 (+https://github.com/St1rben/zoe-bot)"}
        timeout = aiohttp.ClientTimeout(total=self._settings.request_timeout)
        async with aiohttp.ClientSession(headers=headers, timeout=timeout) as session:
            while not self._stop.is_set():
                try:
                    await self.check_once(session)
                    self.last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — цикл має пережити будь-яку помилку
                    self.last_error = str(exc)
                    logger.exception("Помилка під час перевірки")
                await self._interruptible_sleep(self._settings.check_interval)

    async def _interruptible_sleep(self, seconds: float) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)

    async def check_once(self, session: aiohttp.ClientSession) -> None:
        html = await self._fetch_html(session)
        self.last_check_at = time.time()
        self.check_count += 1
        await self._state.set_meta(META_LAST_CHECK_AT, str(self.last_check_at))

        post = extract_post(html)
        if post is None:
            logger.warning("На сторінці не знайдено жодного поста з id")
            return

        self.last_post_id = post.post_id
        await self._state.set_meta(META_LAST_POST_ID, post.post_id)
        await self._state.set_meta(META_LAST_POST_TITLE, post.title)
        logger.info("Пост %s | %s", post.post_id, post.title or "-")

        chats = await self._state.list_chats()
        planned = await plan_notifications(post, chats, self._settings.queue, self._state)
        for message in planned:
            if await self._notifier.send(message.chat_id, message.text):
                await self._state.set_meta(message.state_key, message.state_value)
                logger.info("Надіслано (chat %s): %s", message.chat_id, message.state_key)

        dropped = await self._state.drop_stale_post_state(post.post_id, POST_STATE_PREFIX)
        if dropped:
            logger.debug("Прибрано застарілих станів: %d", dropped)

        await self._maybe_send_digest(post)

    async def _fetch_html(self, session: aiohttp.ClientSession) -> str:
        attempts = self._settings.retry_attempts
        last_exc: Exception | None = None

        for attempt in range(1, attempts + 1):
            try:
                return await self._request_once(session)
            except RuntimeError:
                raise
            except (aiohttp.ClientError, TimeoutError) as exc:
                last_exc = exc
                if attempt < attempts:
                    delay = min(2.0**attempt, 30.0) * (0.5 + random.random())
                    logger.warning(
                        "Спроба %d/%d невдала (%s), пауза %.1f с", attempt, attempts, exc, delay
                    )
                    await asyncio.sleep(delay)
        raise RuntimeError(f"не вдалося отримати {OUTAGE_URL}: {last_exc}") from last_exc

    async def _get_text(self, session: aiohttp.ClientSession, ssl_arg: bool) -> str:
        async with session.get(OUTAGE_URL, ssl=ssl_arg) as resp:
            if 400 <= resp.status < 500:
                raise RuntimeError(f"сайт відповів HTTP {resp.status}")
            resp.raise_for_status()
            return await resp.text()

    async def _request_once(self, session: aiohttp.ClientSession) -> str:
        """Один запит: TLS перевіряється, доки це можливо.

        zoe.com.ua віддає неповний ланцюжок сертифікатів, тож якщо перевірку
        виконати неможливо — читаємо загальнодоступну сторінку без неї
        (з попередженням у лог; стан видно в /health як tls_verified).
        """
        if self.tls_verified is False:
            return await self._get_text(session, ssl_arg=False)
        try:
            text = await self._get_text(session, ssl_arg=True)
        except aiohttp.ClientConnectorCertificateError as exc:
            self.tls_verified = False
            detail = getattr(exc, "os_error", None) or exc
            logger.warning(
                "TLS-сертифікат zoe.com.ua не проходить перевірку (%s); продовжую без перевірки",
                detail,
            )
            return await self._get_text(session, ssl_arg=False)
        if self.tls_verified is None:
            self.tls_verified = True
        return text

    async def _maybe_send_digest(self, post: OutagePost) -> None:
        digest_time = self._settings.digest_time
        if not digest_time:
            return
        try:
            tz = ZoneInfo(self._settings.digest_tz)
        except ZoneInfoNotFoundError:
            logger.error("Невідомий часовий пояс DIGEST_TZ=%s", self._settings.digest_tz)
            return

        now = datetime.now(tz)
        today = now.date().isoformat()
        if now.strftime("%H:%M") != digest_time:
            return
        if await self._state.get_meta(META_DIGEST_DATE) == today:
            return

        chats = await self._state.list_chats()
        for chat in chats:
            queue = chat.queue_or(self._settings.queue)
            scenario, times = scenario_for(post, queue)
            text = messages.format_digest(post.title, queue, scenario, times)
            await self._notifier.send(chat.chat_id, text)
        await self._state.set_meta(META_DIGEST_DATE, today)
        logger.info("Надіслано нагадування про графік (%s)", digest_time)
