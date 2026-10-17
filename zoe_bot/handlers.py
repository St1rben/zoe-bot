"""Команди Telegram: /start, /status, /queue, /help."""

from __future__ import annotations

import json
import logging
import time

from aiogram import Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import Message

from . import messages
from .config import QUEUE_RE, Settings
from .monitor import (
    META_LAST_POST_ID,
    META_LAST_POST_TITLE,
    Monitor,
    post_state_key,
)
from .state import StateStore

logger = logging.getLogger(__name__)


def build_router(settings: Settings, state: StateStore, monitor: Monitor) -> Router:
    router = Router()

    async def _current_queue(chat_id: int) -> tuple[str, bool]:
        stored = await state.get_chat_queue(chat_id)
        return (stored, False) if stored else (settings.queue, True)

    @router.message(CommandStart())
    async def cmd_start(message: Message) -> None:
        await state.ensure_chat(message.chat.id)
        queue, _ = await _current_queue(message.chat.id)
        await message.answer(messages.format_welcome(queue))

    @router.message(Command("help"))
    async def cmd_help(message: Message) -> None:
        await message.answer(messages.format_help())

    @router.message(Command("queue"))
    async def cmd_queue(message: Message, command: CommandObject) -> None:
        chat_id = message.chat.id
        await state.ensure_chat(chat_id)

        raw = (command.args or "").strip()
        if not raw:
            queue, is_default = await _current_queue(chat_id)
            await message.answer(messages.format_queue_current(queue, is_default=is_default))
            return

        if not QUEUE_RE.fullmatch(raw):
            await message.answer(messages.format_queue_invalid(raw))
            return

        await state.set_chat_queue(chat_id, raw)
        await message.answer(messages.format_queue_set(raw))
        logger.info("Чергу чату %s змінено на %s", chat_id, raw)

    @router.message(Command("status"))
    async def cmd_status(message: Message) -> None:
        chat_id = message.chat.id
        await state.ensure_chat(chat_id)
        queue, _ = await _current_queue(chat_id)

        title = await state.get_meta(META_LAST_POST_TITLE)
        post_id = await state.get_meta(META_LAST_POST_ID)

        scenario: str | None = None
        times: str | None = None
        if post_id:
            raw_state = await state.get_meta(post_state_key(post_id, queue, chat_id))
            if raw_state:
                data = json.loads(raw_state)
                scenario, times = data.get("state"), data.get("times")

        last_check = monitor.last_check_at
        await message.answer(
            messages.format_status(
                queue=queue,
                title=title,
                last_check_age_sec=(time.time() - last_check) if last_check else None,
                scenario=scenario,
                times=times,
                uptime_sec=monitor.uptime_sec,
                last_error=monitor.last_error,
            )
        )

    return router
