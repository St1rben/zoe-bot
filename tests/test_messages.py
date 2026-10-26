"""Тести текстів повідомлень."""

from __future__ import annotations

from zoe_bot import messages


def test_format_update_present() -> None:
    text = messages.format_update("Графік на 17 жовтня", "5.1", "present", "08:00 - 10:00")
    assert "⚡" in text
    assert "Графік на 17 жовтня" in text
    assert "Черга 5.1: 08:00 - 10:00" in text
    assert "zoe.com.ua" in text


def test_format_update_no_schedule() -> None:
    text = messages.format_update("Увага", "5.1", "no_schedule", None)
    assert "☀️" in text
    assert "не відключатиметься" in text


def test_format_update_absent() -> None:
    text = messages.format_update("Графік", "5.1", "absent", None)
    assert "відсутня" in text


def test_format_unchanged_update() -> None:
    text = messages.format_unchanged_update("Оновлено ГПВ", "5.1", "present", "08:00 - 10:00")
    assert "🔄" in text
    assert "Оновлено ГПВ" in text
    assert "без змін" in text
    assert "Черга 5.1: 08:00 - 10:00" in text
    assert "zoe.com.ua" in text


def test_format_update_escapes_html() -> None:
    text = messages.format_update('<b>"Тест"</b>', "5.1", "absent", None)
    assert '<b>"Тест"</b>' not in text
    assert "&lt;b&gt;" in text
    assert "&quot;Тест&quot;" in text


def test_format_queue_invalid_escapes() -> None:
    text = messages.format_queue_invalid("<script>")
    assert "<script>" not in text
    assert "&lt;script&gt;" in text


def test_humanize_seconds() -> None:
    assert messages.humanize_seconds(30) == "30 с"
    assert messages.humanize_seconds(90) == "1 хв"
    assert messages.humanize_seconds(3700) == "1 год 1 хв"
    assert messages.humanize_seconds(90000) == "1 д 1 год"


def test_format_status_contains_queue_and_uptime() -> None:
    text = messages.format_status(
        queue="5.1",
        title="Графік",
        last_check_age_sec=42,
        scenario="present",
        times="08:00 - 10:00",
        uptime_sec=3600,
        last_error=None,
    )
    assert "Черга: <b>5.1</b>" in text
    assert "08:00 - 10:00" in text
    assert "1 год 0 хв" in text


def test_format_status_without_data() -> None:
    text = messages.format_status(
        queue="5.1",
        title=None,
        last_check_age_sec=None,
        scenario=None,
        times=None,
        uptime_sec=5,
        last_error="timeout",
    )
    assert "⏳" in text
    assert "timeout" in text
