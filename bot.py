import asyncio
import os
import re
from pathlib import Path

from dotenv import load_dotenv
import aiohttp
from aiogram import Bot
from bs4 import BeautifulSoup

load_dotenv(Path(__file__).parent / ".env")

BOT_TOKEN = os.environ["BOT_TOKEN"]
CHAT_ID = os.environ["CHAT_ID"]
QUEUE = os.environ.get("QUEUE", "5.1")
CHECK_INTERVAL = int(os.environ.get("CHECK_INTERVAL", "60"))
URL = "https://www.zoe.com.ua/outage/"

bot = Bot(token=BOT_TOKEN)
last_post_id: str | None = None
queue_was_present: bool | None = None


def extract_first_post(html: str) -> tuple[str, str, str] | tuple[None, None, None]:
    soup = BeautifulSoup(html, "html.parser")
    article = soup.find("article")
    if not article:
        return None, None, None

    post_id = article.get("id", "")
    title = article.find("h2")
    title = title.get_text(strip=True) if title else ""
    content = article.find(class_="content")
    text = content.get_text(separator="\n", strip=True) if content else ""

    return post_id, title, text


def is_no_schedule(text: str) -> bool:
    """Пост содержит сообщение что графиков нет вообще."""
    return "НЕ ЗАПЛАНОВАНІ" in text.upper() or "НЕ ПЛАНУЮТЬСЯ" in text.upper()


def find_queue_line(text: str, queue: str) -> str | None:
    lines = text.splitlines()
    return next(
        (l.strip() for l in lines if re.match(rf"^{re.escape(queue)}\s*:", l.strip())),
        None
    )


def format_no_schedule_msg(title: str) -> str:
    return (
        f"☀️ {title}\n\n"
        f"Графіки погодинних відключень не заплановані.\n"
        f"Черга {QUEUE} сьогодні не відключатиметься 🎉"
    )


def format_queue_msg(title: str, queue: str, queue_line: str) -> str:
    time_range = queue_line.split(":", 1)[1].strip()
    return (
        f"⚡ {title}\n\n"
        f"🔴 Черга {queue}: {time_range}"
    )


def format_queue_absent_msg(title: str, queue: str) -> str:
    return (
        f"✅ {title}\n\n"
        f"Черга {queue} у графіку відсутня — світло не відключатимуть 🎉"
    )


async def send_post(title: str, text: str):
    """Определяет тип поста и отправляет нужное сообщение."""
    if is_no_schedule(text):
        await bot.send_message(CHAT_ID, format_no_schedule_msg(title))
        print("[SENT] Графіки не заплановані")
        return

    queue_line = find_queue_line(text, QUEUE)
    if queue_line:
        await bot.send_message(CHAT_ID, format_queue_msg(title, QUEUE, queue_line))
        print(f"[SENT] Черга знайдена: {queue_line}")
    else:
        await bot.send_message(CHAT_ID, format_queue_absent_msg(title, QUEUE))
        print(f"[SENT] Черга {QUEUE} відсутня в пості")


async def check_updates():
    global last_post_id, queue_was_present
    headers = {"User-Agent": "Mozilla/5.0 (ZOE-Bot/1.0)"}

    async with aiohttp.ClientSession(headers=headers) as session:
        while True:
            try:
                async with session.get(URL, ssl=False, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    html = await resp.text()

                post_id, title, text = extract_first_post(html)

                if not post_id:
                    print("[WARN] Пост не знайдено")
                    await asyncio.sleep(CHECK_INTERVAL)
                    continue

                print(f"[CHECK] {post_id} | {title}")

                no_schedule = is_no_schedule(text)
                queue_line = find_queue_line(text, QUEUE)
                queue_is_present = queue_line is not None

                # Новый пост
                if post_id != last_post_id:
                    if last_post_id is not None:
                        await send_post(title, text)
                    last_post_id = post_id
                    queue_was_present = queue_is_present if not no_schedule else False

                # Тот же пост — черга появилась или пропала
                elif not no_schedule and queue_was_present != queue_is_present:
                    await send_post(title, text)
                    queue_was_present = queue_is_present

            except Exception as e:
                print(f"[ERROR] {e}")

            await asyncio.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    print(f"[START] Моніторинг черги {QUEUE}, інтервал {CHECK_INTERVAL}s")
    asyncio.run(check_updates())