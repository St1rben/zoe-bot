"""Збирання та запуск застосунку."""

from __future__ import annotations

import asyncio
import logging
import signal

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from . import __version__, messages, web
from .config import load_settings
from .handlers import build_router
from .monitor import Monitor
from .notifier import Notifier
from .state import StateStore

logger = logging.getLogger(__name__)


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    for noisy in ("aiogram", "aiohttp"):  # ERROR/WARNING залишаємо видимими
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _install_signal_handlers(stop_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()

    def request_shutdown(name: str) -> None:
        logger.info("Отримано %s — завершую роботу", name)
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_shutdown, sig.name)
        except (NotImplementedError, ValueError):
            # Windows: add_signal_handler недоступний, використовуємо signal.signal
            try:
                signal.signal(
                    sig,
                    lambda signum, _frame: loop.call_soon_threadsafe(
                        request_shutdown, signal.Signals(signum).name
                    ),
                )
            except (ValueError, OSError):
                logger.debug("Не вдалося встановити обробник %s", sig.name)


async def _wait_for_shutdown(stop_event: asyncio.Event, tasks: list[asyncio.Task[None]]) -> None:
    waiter = asyncio.create_task(stop_event.wait(), name="stop-waiter")
    try:
        done, _pending = await asyncio.wait([*tasks, waiter], return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if task is waiter:
                continue
            exc = task.exception()
            if exc is not None:
                raise RuntimeError(f"Служба «{task.get_name()}» впала") from exc
            logger.warning("Служба «%s» завершилася неочікувано", task.get_name())
    finally:
        waiter.cancel()


async def run() -> None:
    settings = load_settings()
    setup_logging(settings.log_level)
    logger.info(
        "ZOE outage bot v%s | черга %s | інтервал %ss",
        __version__,
        settings.queue,
        settings.check_interval,
    )

    state = StateStore(settings.state_db)
    await state.init()
    await state.ensure_chat(settings.chat_id)

    bot = Bot(settings.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    notifier = Notifier(bot, settings)
    monitor = Monitor(settings, state, notifier)

    dispatcher = Dispatcher()
    dispatcher.include_router(build_router(settings, state, monitor))

    stop_event = asyncio.Event()
    _install_signal_handlers(stop_event)

    tasks: list[asyncio.Task[None]] = [
        asyncio.create_task(monitor.run(), name="monitor"),
        asyncio.create_task(
            dispatcher.start_polling(bot, handle_signals=False), name="telegram-polling"
        ),
        asyncio.create_task(web.run_web_server(settings.port, monitor), name="health-server"),
    ]

    await notifier.broadcast(await state.list_chats(), messages.format_startup(settings.queue))

    try:
        await _wait_for_shutdown(stop_event, tasks)
    finally:
        monitor.request_stop()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await state.close()
        await bot.session.close()
        logger.info("Бот зупинено")


def main() -> None:
    asyncio.run(run())
