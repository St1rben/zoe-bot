"""HTTP-сервер: health-check для хостингу."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

from aiohttp import web

from . import __version__
from .monitor import Monitor

logger = logging.getLogger(__name__)


def create_app(monitor: Monitor) -> web.Application:
    app = web.Application()
    app["monitor"] = monitor
    app.router.add_get("/", _root)
    app.router.add_get("/health", _health)
    return app


async def _root(request: web.Request) -> web.Response:
    return web.Response(text="ZOE outage bot is running")


async def _health(request: web.Request) -> web.Response:
    monitor: Monitor = request.app["monitor"]
    last_check = monitor.last_check_at
    return web.json_response(
        {
            "status": "ok" if monitor.last_error is None else "degraded",
            "version": __version__,
            "uptime_sec": round(monitor.uptime_sec),
            "last_check_at": (
                datetime.fromtimestamp(last_check, tz=UTC).isoformat() if last_check else None
            ),
            "last_check_age_sec": round(time.time() - last_check) if last_check else None,
            "last_post_id": monitor.last_post_id,
            "checks": monitor.check_count,
            "tls_verified": monitor.tls_verified,
            "last_error": monitor.last_error,
        }
    )


async def run_web_server(port: int, monitor: Monitor) -> None:
    """Запускає сервер і працює до скасування задачі."""
    runner = web.AppRunner(create_app(monitor))
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info("Health-сервер слухає порт %d", port)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()
        logger.info("Health-сервер зупинено")
