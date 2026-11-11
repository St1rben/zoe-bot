#!/usr/bin/env python3
"""
Генератор рядка TELEGRAM_SESSION (Telethon StringSession) для GitHub Actions Secrets.

Запуск локально один раз:
    pip install telethon
    python cloudflare/scripts/gen-tg-session.py

Дізнатися свої TELEGRAM_API_ID та TELEGRAM_API_HASH можна на https://my.telegram.org (API development tools).
Отриманий рядок TELEGRAM_SESSION додайте у GitHub → Settings → Secrets and variables → Actions.
"""

import asyncio


async def main() -> None:
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
    except ImportError:
        print("Встановіть telethon:  pip install telethon")
        return

    print("=== Генерація TELEGRAM_SESSION для @zoe_alarm ===")
    api_id_str = input("Введіть TELEGRAM_API_ID (з https://my.telegram.org): ").strip()
    api_hash = input("Введіть TELEGRAM_API_HASH: ").strip()
    bot_token = input("Введіть BOT_TOKEN бота (або Enter для входу за номером телефону): ").strip()

    client = TelegramClient(StringSession(), int(api_id_str), api_hash)
    if bot_token:
        await client.start(bot_token=bot_token)
    else:
        await client.start()
    session_str = client.session.save()
    await client.disconnect()

    print("\n✅ Успішно! Додайте ці 3 секрети в GitHub Actions Secrets:\n")
    print(f"TELEGRAM_API_ID   = {api_id_str}")
    print(f"TELEGRAM_API_HASH = {api_hash}")
    print(f"TELEGRAM_SESSION  = {session_str}\n")


if __name__ == "__main__":
    asyncio.run(main())
