"""Тести парсера статті та визначення сценарію для черги."""

from __future__ import annotations

from zoe_bot.parser import (
    SCENARIO_ABSENT,
    SCENARIO_NO_SCHEDULE,
    SCENARIO_PRESENT,
    extract_post,
    parse_queue_lines,
    scenario_for,
)

from .conftest import NO_ARTICLE_HTML


def test_extract_post_fields(sample_html: str) -> None:
    post = extract_post(sample_html)
    assert post is not None
    assert post.post_id == "post-1234"
    assert post.title == "Графік відключень на 17 жовтня"
    assert "5.1: 08:00 - 10:00, 16:00 - 20:00" in post.text


def test_extract_post_queues(sample_html: str) -> None:
    post = extract_post(sample_html)
    assert post is not None
    assert post.queues == {
        "1.1": "08:00 - 12:00",
        "5.1": "08:00 - 10:00, 16:00 - 20:00",
        "5.2": "10:00 - 12:00",
    }


def test_extract_post_without_article() -> None:
    assert extract_post(NO_ARTICLE_HTML) is None


def test_extract_post_without_id() -> None:
    html = '<article><h2>Без id</h2><div class="content">5.1: 08:00 - 10:00</div></article>'
    assert extract_post(html) is None


def test_no_schedule_marker(no_schedule_html: str) -> None:
    post = extract_post(no_schedule_html)
    assert post is not None
    assert post.no_schedule is True


def test_no_schedule_false(sample_html: str) -> None:
    post = extract_post(sample_html)
    assert post is not None
    assert post.no_schedule is False


def test_parse_queue_lines_exact_match() -> None:
    text = "15.1: 10:00 - 12:00\n5.1 : 08:00 - 10:00\n5.10: 12:00 - 14:00"
    assert parse_queue_lines(text) == {
        "15.1": "10:00 - 12:00",
        "5.1": "08:00 - 10:00",
        "5.10": "12:00 - 14:00",
    }


def test_parse_queue_lines_ignores_noise() -> None:
    text = "Черга 5.1: 08:00 - 10:00\nДякуємо"
    assert parse_queue_lines(text) == {}


def test_scenario_no_schedule(no_schedule_html: str) -> None:
    post = extract_post(no_schedule_html)
    assert post is not None
    assert scenario_for(post, "5.1") == (SCENARIO_NO_SCHEDULE, None)


def test_scenario_present(sample_html: str) -> None:
    post = extract_post(sample_html)
    assert post is not None
    assert scenario_for(post, "5.1") == (SCENARIO_PRESENT, "08:00 - 10:00, 16:00 - 20:00")


def test_scenario_absent(sample_html: str) -> None:
    post = extract_post(sample_html)
    assert post is not None
    assert scenario_for(post, "9.9") == (SCENARIO_ABSENT, None)
