"""Точка входу бота: python bot.py."""

import asyncio

from zoe_bot.app import run

if __name__ == "__main__":
    asyncio.run(run())
