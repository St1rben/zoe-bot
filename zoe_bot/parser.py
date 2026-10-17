"""Парсинг статті зі сторінки zoe.com.ua/outage."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup

OUTAGE_URL = "https://www.zoe.com.ua/outage/"

NO_SCHEDULE_MARKERS = ("НЕ ЗАПЛАНОВАНІ", "НЕ ПЛАНУЮТЬСЯ")

SCENARIO_NO_SCHEDULE = "no_schedule"
SCENARIO_PRESENT = "present"
SCENARIO_ABSENT = "absent"

_QUEUE_LINE_RE = re.compile(r"^(?P<queue>\d+(?:\.\d+)?)\s*:\s*(?P<times>.+)$")


@dataclass(frozen=True)
class OutagePost:
    """Перша (актуальна) стаття зі сторінки відключень."""

    post_id: str
    title: str
    text: str
    queues: dict[str, str] = field(default_factory=dict)

    @property
    def no_schedule(self) -> bool:
        text = self.text.upper()
        return any(marker in text for marker in NO_SCHEDULE_MARKERS)

    def schedule_for(self, queue: str) -> str | None:
        return self.queues.get(queue)


def extract_post(html: str) -> OutagePost | None:
    """Витягує першу статтю. Повертає None, якщо статті або її id немає."""
    soup = BeautifulSoup(html, "html.parser")
    article = soup.find("article")
    if article is None:
        return None

    post_id = article.get("id")
    if not post_id:
        return None

    title_el = article.find("h2")
    title = title_el.get_text(strip=True) if title_el is not None else ""

    content_el = article.find(class_="content")
    text = content_el.get_text(separator="\n", strip=True) if content_el is not None else ""

    return OutagePost(post_id=post_id, title=title, text=text, queues=parse_queue_lines(text))


def parse_queue_lines(text: str) -> dict[str, str]:
    """Рядки виду «5.1: 08:00 - 12:00» → {"5.1": "08:00 - 12:00"}."""
    queues: dict[str, str] = {}
    for raw_line in text.splitlines():
        match = _QUEUE_LINE_RE.match(raw_line.strip())
        if match is None:
            continue
        times = re.sub(r"\s+", " ", match.group("times")).strip()
        queues.setdefault(match.group("queue"), times)
    return queues


def scenario_for(post: OutagePost, queue: str) -> tuple[str, str | None]:
    """Поточний сценарій для черги: (сценарій, час відключень)."""
    if post.no_schedule:
        return SCENARIO_NO_SCHEDULE, None
    times = post.schedule_for(queue)
    if times is not None:
        return SCENARIO_PRESENT, times
    return SCENARIO_ABSENT, None
