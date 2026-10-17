"""Спільні фікстури тестів."""

from __future__ import annotations

import pytest

CONSUMER_ARTICLE_HTML = """
<article id="post-1234">
  <h2>Графік відключень на 17 жовтня</h2>
  <div class="content">
    <p>Сьогодні будуть застосовані графіки погодинних відключень:</p>
    1.1: 08:00 - 12:00
    5.1: 08:00 - 10:00, 16:00 - 20:00
    5.2: 10:00 - 12:00
    <p>Дякуємо за розуміння</p>
  </div>
</article>
"""

BUSINESS_ARTICLE_HTML = """
<article id="post-2000">
  <h2>ДО УВАГИ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ 18 ЖОВТНЯ</h2>
  <div class="content">
    <p>18 жовтня для промисловості та бізнесу діють графіки обмеження потужності.</p>
    <p>Дані обмеження НЕ СТОСУЮТЬСЯ НАСЕЛЕННЯ.</p>
  </div>
</article>
"""

SAMPLE_HTML = f"<html><body>{CONSUMER_ARTICLE_HTML}</body></html>"

MIXED_PAGE_HTML = f"<html><body>{BUSINESS_ARTICLE_HTML}{CONSUMER_ARTICLE_HTML}</body></html>"

NO_SCHEDULE_HTML = """
<html><body>
<article id="post-9999">
  <h2>УВАГА! Відключення</h2>
  <div class="content">
    <p>Графіки погодинних відключень НЕ ЗАПЛАНОВАНІ.</p>
  </div>
</article>
</body></html>
"""

NO_ARTICLE_HTML = "<html><body><div>Нічого немає</div></body></html>"


@pytest.fixture()
def sample_html() -> str:
    return SAMPLE_HTML


@pytest.fixture()
def no_schedule_html() -> str:
    return NO_SCHEDULE_HTML


@pytest.fixture()
def mixed_page_html() -> str:
    return MIXED_PAGE_HTML
