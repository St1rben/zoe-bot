#!/usr/bin/env python3
"""
Синхронізація планових та аварійних відключень із каналу https://t.me/zoe_alarm
у Cloudflare Worker (GET /alarm/state, POST /ingest-alarm).

Працює у два етапи:
1) Швидка перевірка веб-прев'ю https://t.me/s/zoe_alarm (без авторизації, ~0.5 с):
   - знаходить усі реплаї «Електропостачання відновлено.»
   - знаходить нові пости з файлами міських РЕМ («Перерви_в_ел_постач_ЗМЕМ_*.xlsx»)
2) Якщо є нові невідновлені файли ЗМЕМ_*.xlsx і задані TELEGRAM_API_ID,
   TELEGRAM_API_HASH, TELEGRAM_SESSION — завантажує ці .xlsx через Telethon,
   розбирає таблицю (із протягуванням об'єднаних комірок груп) і відправляє у воркер.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from typing import Any

CHANNEL_USERNAME = "zoe_alarm"
WEB_PREVIEW_URL = f"https://t.me/s/{CHANNEL_USERNAME}"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def extract_file_date(file_name: str | None) -> str | None:
    """Витягує дату DD.MM.20YY з назви файлу (напр. '..._12_11_26.xlsx' -> '12.11.2026')."""
    if not file_name:
        return None
    m = re.search(r"_(\d{2})_(\d{2})_(\d{2})\.xlsx$", file_name.strip(), re.I)
    if not m:
        return None
    return f"{m.group(1)}.{m.group(2)}.20{m.group(3)}"


def parse_xlsx_bytes(data: bytes, file_name: str | None = None) -> list[dict[str, str]]:
    """
    Розбирає .xlsx файл ЗОЕ у список рядків AlarmRow, протягуючи згруповані
    комірки (№ з/п, Населений пункт, Причина, Дата/Час початку та відновлення).
    """
    file_date = extract_file_date(file_name)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall(f"{NS_MAIN}si"):
                texts = [t.text or "" for t in si.iter(f"{NS_MAIN}t")]
                shared.append("".join(texts))

        sheet_name = next(
            (n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")),
            None,
        )
        if sheet_name is None:
            return []

        sheet = ET.fromstring(zf.read(sheet_name))
        raw_rows: list[dict[str, str]] = []
        for row_el in sheet.iter(f"{NS_MAIN}row"):
            cells: dict[str, str] = {}
            for cell_el in row_el.findall(f"{NS_MAIN}c"):
                ref = cell_el.attrib.get("r", "")
                col = "".join(ch for ch in ref if ch.isalpha())
                cell_type = cell_el.attrib.get("t")
                val_el = cell_el.find(f"{NS_MAIN}v")
                val = val_el.text if val_el is not None and val_el.text is not None else ""
                if cell_type == "s" and val != "":
                    idx = int(val)
                    val = shared[idx] if 0 <= idx < len(shared) else ""
                elif cell_type == "inlineStr":
                    val = "".join(t.text or "" for t in cell_el.iter(f"{NS_MAIN}t"))
                cells[col] = val.strip()
            raw_rows.append(cells)

    # Поточні значення згрупованої шапки блоку
    cur_group = ""
    cur_settlement = ""
    cur_street = ""
    cur_reason = ""
    cur_start_date = ""
    cur_start_time = ""
    cur_end_date = ""
    cur_end_time = ""

    parsed: list[dict[str, str]] = []
    header_passed = False

    for r in raw_rows:
        a = r.get("A", "")
        b = r.get("B", "")
        c = r.get("C", "")
        d = r.get("D", "")
        e = r.get("E", "")
        f = r.get("F", "")
        g = r.get("G", "")
        h = r.get("H", "")
        col_i = r.get("I", "")

        # Пропускаємо шапку таблиці
        if "Вулиця" in c or (f == "Дата" and g == "Час"):
            header_passed = True
            continue
        if not header_passed:
            # На випадок якщо перші рядки без слова "Вулиця", перевіряємо чи схоже F на дату DD.MM.YYYY
            if re.match(r"^\d{2}\.\d{2}\.\d{4}$", f):
                header_passed = True
            else:
                continue

        if not c and not d:
            continue

        # Якщо починається нова група (заповнено A або F/H)
        if a:
            cur_group = a
        if b:
            cur_settlement = b
        if e:
            cur_reason = e
        if f:
            cur_start_date = f
        if g:
            cur_start_time = g
        if h:
            cur_end_date = h
        if col_i:
            cur_end_time = col_i

        # Іноді оператор (напр. ЗМЕМ_ПБ) вписує і вулицю, і будинки в колонку C ("вул. Сорочинська  28|28а"), а D лишає порожньою
        if c and not d:
            m_inline = re.match(r"^(.+?)\s+(\d[\dа-яіїєґa-zA-Z|/,\s\-]*)$", c)
            if m_inline:
                c = m_inline.group(1).strip()
                d = m_inline.group(2).strip()

        if c:
            cur_street = c

        if not cur_street or not d:
            continue

        start_date = cur_start_date
        end_date = cur_end_date
        # Іноді оператор (напр. ЗМЕМ_ПБ у анонсах на завтра) забуває змінити вчорашню дату
        # всередині таблиці, хоча в назві файлу стоїть актуальна дата (_12_11_26.xlsx)
        if file_date and start_date and start_date == end_date and start_date != file_date:
            start_date = file_date
            end_date = file_date

        parsed.append(
            {
                "groupId": cur_group,
                "settlement": cur_settlement or "м.Запоріжжя",
                "street": cur_street,
                "houses": d,
                "reason": cur_reason or "аварійні",
                "startDate": start_date,
                "startTime": cur_start_time,
                "endDate": end_date,
                "endTime": cur_end_time,
            }
        )

    return parsed


def fetch_channel_html(before: str | None = None) -> str:
    url = WEB_PREVIEW_URL + (f"?before={before}" if before else "")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_web_preview_posts(html_text: str) -> list[dict[str, Any]]:
    blocks = html_text.split(f'data-post="{CHANNEL_USERNAME}/')[1:]
    posts: list[dict[str, Any]] = []
    seen: set[str] = set()

    for block in blocks:
        post_id = block.split('"', 1)[0].strip()
        if not post_id.isdigit() or post_id in seen:
            continue
        seen.add(post_id)

        reply_m = re.search(
            rf'tgme_widget_message_reply.*?href="https://t\.me/{CHANNEL_USERNAME}/(\d+)"',
            block,
            re.S,
        )
        reply_to = reply_m.group(1) if reply_m else None

        doc_m = re.search(r"tgme_widget_message_document_title[^>]*>([^<]+)<", block)
        doc_title = html_lib.unescape(doc_m.group(1)).strip() if doc_m else None

        text_m = re.search(r"js-message_text[^>]*>(.*?)</div>", block, re.S)
        raw_text = re.sub(r"<[^>]+>", " ", text_m.group(1)) if text_m else ""
        text = re.sub(r"\s+", " ", html_lib.unescape(raw_text)).strip()

        dt_m = re.search(r'datetime="([^"]+)"', block)
        published_at = dt_m.group(1) if dt_m else ""

        posts.append(
            {
                "postId": post_id,
                "replyToPostId": reply_to,
                "fileName": doc_title,
                "text": text,
                "publishedAt": published_at,
            }
        )

    posts.sort(key=lambda p: int(p["postId"]))
    return posts


def get_worker_alarm_state(worker_url: str, ingest_token: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{worker_url.rstrip('/')}/alarm/state",
        headers={
            "X-Ingest-Token": ingest_token,
            "User-Agent": USER_AGENT,
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_worker_alarm_ingest(
    worker_url: str, ingest_token: str, payload: dict[str, Any]
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{worker_url.rstrip('/')}/ingest-alarm",
        data=body,
        headers={
            "X-Ingest-Token": ingest_token,
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def download_xlsx_via_telethon(
    api_id: int,
    api_hash: str,
    session_str: str,
    post_ids: list[int],
) -> dict[int, bytes]:
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    result: dict[int, bytes] = {}
    async with TelegramClient(StringSession(session_str), api_id, api_hash) as client:
        messages = await client.get_messages(CHANNEL_USERNAME, ids=post_ids)
        if not isinstance(messages, list):
            messages = [messages]
        for msg in messages:
            if msg is None or not getattr(msg, "document", None):
                continue
            buf = io.BytesIO()
            await client.download_media(msg, file=buf)
            result[int(msg.id)] = buf.getvalue()
    return result


def is_zmem_xlsx(file_name: str | None) -> bool:
    if not file_name:
        return False
    lower = file_name.lower()
    return lower.endswith(".xlsx") and "змем" in lower


def is_restored_reply(post: dict[str, Any]) -> bool:
    if not post.get("replyToPostId"):
        return False
    if post.get("fileName"):
        return False
    text = (post.get("text") or "").lower()
    return "відновлено" in text and "частково" not in text


def main() -> int:
    worker_url = os.environ.get("WORKER_URL", "https://zoe-outage-bot.kir245314.workers.dev")
    ingest_token = os.environ.get("INGEST_TOKEN", "").strip()
    check_only = "--check-only" in sys.argv

    if not ingest_token:
        print("::error::INGEST_TOKEN is not set", file=sys.stderr)
        return 1

    state = get_worker_alarm_state(worker_url, ingest_token)
    processed_ids = set(str(x) for x in state.get("processedPostIds", []))

    # Завантажуємо останні 2 сторінки веб-прев'ю (~40 постів), щоб нічого не пропустити
    html_latest = fetch_channel_html()
    first_m = re.search(rf'data-post="{CHANNEL_USERNAME}/(\d+)"', html_latest)
    html_prev = fetch_channel_html(first_m.group(1)) if first_m else ""
    posts = parse_web_preview_posts(html_prev + html_latest)

    # Які пости вже відновлені прямо у цій вибірці
    restored_target_ids = {
        str(p["replyToPostId"]) for p in posts if is_restored_reply(p)
    }

    new_restored_replies: list[dict[str, Any]] = []
    candidate_xlsx_posts: list[dict[str, Any]] = []

    for p in posts:
        pid = str(p["postId"])
        if pid in processed_ids:
            continue

        if is_restored_reply(p):
            new_restored_replies.append(
                {
                    "postId": pid,
                    "replyToPostId": str(p["replyToPostId"]),
                    "text": p["text"],
                    "publishedAt": p["publishedAt"],
                }
            )
        elif is_zmem_xlsx(p.get("fileName")):
            # Якщо цей пост уже відновлено реплаєм на цій же сторінці і це перший запуск —
            # можна не качати вже закритий архівний файл
            if pid in restored_target_ids and len(processed_ids) == 0:
                continue
            candidate_xlsx_posts.append(p)

    print(
        f"Web preview checked: total_posts={len(posts)}, "
        f"new_restored={len(new_restored_replies)}, "
        f"new_zmem_xlsx={len(candidate_xlsx_posts)}"
    )

    if check_only:
        gh_out = os.environ.get("GITHUB_OUTPUT")
        needs_xlsx = "true" if len(candidate_xlsx_posts) > 0 else "false"
        if gh_out:
            with open(gh_out, "a", encoding="utf-8") as f:
                f.write(f"needs_xlsx={needs_xlsx}\n")
        if len(candidate_xlsx_posts) == 0:
            # Відправляємо реплаї про відновлення (або оновлюємо lastCheckAt) одразу без Telethon
            summary = post_worker_alarm_ingest(
                worker_url,
                ingest_token,
                {"newPosts": [], "restoredReplies": new_restored_replies},
            )
            print("Worker ingest-alarm summary:", json.dumps(summary, ensure_ascii=False))
        return 0

    api_id_raw = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()
    session_str = os.environ.get("TELEGRAM_SESSION", "").strip()

    new_posts_payload: list[dict[str, Any]] = []
    if candidate_xlsx_posts and api_id_raw and api_hash and session_str:
        ids_to_fetch = [int(p["postId"]) for p in candidate_xlsx_posts]
        print(f"Downloading {len(ids_to_fetch)} .xlsx files via Telethon: {ids_to_fetch}")
        xlsx_map = asyncio.run(
            download_xlsx_via_telethon(int(api_id_raw), api_hash, session_str, ids_to_fetch)
        )
        for p in candidate_xlsx_posts:
            pid_int = int(p["postId"])
            raw_bytes = xlsx_map.get(pid_int)
            if not raw_bytes:
                print(f"Warning: could not download .xlsx for post {pid_int}", file=sys.stderr)
                continue
            rows = parse_xlsx_bytes(raw_bytes, p.get("fileName"))
            print(f"Parsed {p['fileName']} (post #{pid_int}): {len(rows)} rows")
            new_posts_payload.append(
                {
                    "postId": str(p["postId"]),
                    "fileName": p["fileName"] or "",
                    "caption": p["text"] or "",
                    "replyToPostId": p["replyToPostId"],
                    "publishedAt": p["publishedAt"],
                    "rows": rows,
                }
            )
    elif candidate_xlsx_posts:
        print(
            "::notice::Виявлено нові файли ЗМЕМ .xlsx, але секрети TELEGRAM_API_ID / "
            "TELEGRAM_API_HASH / TELEGRAM_SESSION ще не налаштовані. Оновлюємо лише реплаї відновлення."
        )

    summary = post_worker_alarm_ingest(
        worker_url,
        ingest_token,
        {"newPosts": new_posts_payload, "restoredReplies": new_restored_replies},
    )
    print("Worker ingest-alarm summary:", json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
