"""Надсилання повідомлень у Telegram із обробкою помилок."""

from __future__ import annotations

import asyncio
import logging

from aiogram import Bot
from aiogram.exceptions import TelegramRetryAfter
from aiogram.types import LinkPreviewOptions

from .config import Settings
from .state import ChatSubscription

logger = logging.getLogger(__name__)

_LINK_PREVIEW_OFF = LinkPreviewOptions(is_disabled=True)


class Notifier:
    def __init__(self, bot: Bot, settings: Settings) -> None:
        self._bot = bot
        self._settings = settings

    async def send(self, chat_id: int, text: str) -> bool:
        """Надсилає текст; повертає True лише за успіху.

        Помилки одного чату не зривають розсилку іншим.
        """
        if self._settings.dry_run:
            logger.info("[DRY-RUN] chat=%s\n%s", chat_id, text)
            return True
        try:
            await self._bot.send_message(chat_id, text, link_preview_options=_LINK_PREVIEW_OFF)
            return True
        except TelegramRetryAfter as exc:
            logger.warning("Flood control: пауза %s с (chat %s)", exc.retry_after, chat_id)
            await asyncio.sleep(exc.retry_after)
            return await self._retry_once(chat_id, text)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — одна невдала відправка не має валити цикл
            logger.error("Не вдалося надіслати (chat %s): %s", chat_id, exc)
            return False

    async def _retry_once(self, chat_id: int, text: str) -> bool:
        try:
            await self._bot.send_message(chat_id, text, link_preview_options=_LINK_PREVIEW_OFF)
            return True
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("Повторна відправка не вдалася (chat %s): %s", chat_id, exc)
            return False

    async def broadcast(self, chats: list[ChatSubscription], text: str) -> set[int]:
        """Надсилає однаковий текст усім чатам; повертає chat_id успішних."""
        sent: set[int] = set()
        for chat in chats:
            if await self.send(chat.chat_id, text):
                sent.add(chat.chat_id)
        return sent
