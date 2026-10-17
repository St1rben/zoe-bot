"""Парсинг статті зі сторінки zoe.com.ua/outage."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup
from bs4.element import Tag

OUTAGE_URL = "https://www.zoe.com.ua/outage/"

NO_SCHEDULE_MARKERS = ("НЕ ЗАПЛАНОВАНІ", "НЕ ПЛАНУЮТЬСЯ")

# Пости "до уваги промисловості та бізнесу" не стосуються населення
BUSINESS_TITLE_MARKERS = ("ПРОМИСЛОВОСТ", "БІЗНЕС")
BUSINESS_TEXT_MARKERS = ("НЕ СТОСУЮТЬСЯ НАСЕЛЕННЯ",)

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

    @property
    def for_business(self) -> bool:
        """Пост призначений лише для промисловості/бізнесу, не для населення."""
        title = self.title.upper()
        text = self.text.upper()
        return any(marker in title for marker in BUSINESS_TITLE_MARKERS) or any(
            marker in text for marker in BUSINESS_TEXT_MARKERS
        )

    def schedule_for(self, queue: str) -> str | None:
        return self.queues.get(queue)


def extract_posts(html: str) -> list[OutagePost]:
    """Усі статті сторінки, у яких є id."""
    soup = BeautifulSoup(html, "html.parser")
    posts: list[OutagePost] = []
    for article in soup.find_all("article"):
        post_id = article.get("id")
        if not post_id:
            continue
        posts.append(_parse_article(article, post_id))
    return posts


def _parse_article(article: Tag, post_id: str) -> OutagePost:
    title_el = article.find("h2")
    title = title_el.get_text(strip=True) if title_el is not None else ""

    content_el = article.find(class_="content")
    text = content_el.get_text(separator="\n", strip=True) if content_el is not None else ""

    return OutagePost(post_id=post_id, title=title, text=text, queues=parse_queue_lines(text))


def extract_post(html: str) -> OutagePost | None:
    """Перший пост для населення; пости для промисловості та бізнесу ігноруються.

    Повертає None, якщо статей немає або всі вони — бізнес-пости.
    """
    for post in extract_posts(html):
        if not post.for_business:
            return post
    return None


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
