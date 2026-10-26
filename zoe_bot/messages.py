"""Формування текстів повідомлень (HTML)."""

from __future__ import annotations

from html import escape

from .parser import (
    OUTAGE_URL,
    SCENARIO_ABSENT,
    SCENARIO_NO_SCHEDULE,
    SCENARIO_PRESENT,
)

COMMANDS_HELP = (
    "/status — поточний стан\n/queue 5.1 — змінити чергу для цього чату\n/help — ця довідка"
)

SOURCE_LINE = f'<a href="{OUTAGE_URL}">Джерело: zoe.com.ua</a>'


def humanize_seconds(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds} с"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} хв"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours} год {minutes} хв"
    days, hours = divmod(hours, 24)
    return f"{days} д {hours} год"


def format_startup(queue: str) -> str:
    return f"🟢 <b>Бот запущено!</b>\n\nМоніторинг черги <b>{escape(queue)}</b> активний."


def format_welcome(queue: str) -> str:
    return (
        "👋 <b>ZOE Outage Bot</b>\n\n"
        "Слідкую за графіками погодинних відключень на zoe.com.ua "
        "і пишу сюди, коли вони з'являються або змінюються.\n\n"
        f"Ваша черга: <b>{escape(queue)}</b>\n\n"
        f"{COMMANDS_HELP}"
    )


def format_help() -> str:
    return f"📖 <b>Команди</b>\n\n{COMMANDS_HELP}"


def format_queue_current(queue: str, *, is_default: bool) -> str:
    source = "значення за замовчуванням" if is_default else "обрано для цього чату"
    return (
        f"⚙️ Поточна черга: <b>{escape(queue)}</b> ({source}).\n\nЗмінити: <code>/queue 4.2</code>"
    )


def format_queue_set(queue: str) -> str:
    return f"✅ Чергу змінено на <b>{escape(queue)}</b>. Наступні оновлення — для неї."


def format_queue_invalid(raw: str) -> str:
    return (
        f"⚠️ «{escape(raw)}» не схоже на номер черги.\n"
        "Приклади: <code>/queue 5.1</code>, <code>/queue 3</code>"
    )


def _scenario_line(queue: str, scenario: str, times: str | None) -> str:
    if scenario == SCENARIO_NO_SCHEDULE:
        return (
            "Графіки погодинних відключень не заплановані.\n"
            f"Черга {escape(queue)} сьогодні не відключатиметься 🎉"
        )
    if scenario == SCENARIO_PRESENT:
        return f"🔴 Черга {escape(queue)}: {escape(times or '')}"
    return f"Черга {escape(queue)} у графіку відсутня — світло не відключатимуть 🎉"


def format_update(title: str, queue: str, scenario: str, times: str | None) -> str:
    icon = {
        SCENARIO_NO_SCHEDULE: "☀️",
        SCENARIO_PRESENT: "⚡",
        SCENARIO_ABSENT: "✅",
    }.get(scenario, "ℹ️")
    return (
        f"{icon} <b>{escape(title)}</b>\n\n"
        f"{_scenario_line(queue, scenario, times)}\n\n"
        f"{SOURCE_LINE}"
    )


def format_unchanged_update(title: str, queue: str, scenario: str, times: str | None) -> str:
    return (
        f"🔄 <b>{escape(title)}</b>\n\n"
        "Графіки було оновлено, але для нашої черги все так само без змін 👌\n\n"
        f"{_scenario_line(queue, scenario, times)}\n\n"
        f"{SOURCE_LINE}"
    )


def format_digest(title: str, queue: str, scenario: str, times: str | None) -> str:
    return (
        "🌙 <b>Нагадування про графік</b>\n\n"
        f"{escape(title)}\n"
        f"{_scenario_line(queue, scenario, times)}"
    )


def format_status(
    *,
    queue: str,
    title: str | None,
    last_check_age_sec: float | None,
    scenario: str | None,
    times: str | None,
    uptime_sec: float,
    last_error: str | None,
) -> str:
    lines = ["📊 <b>Статус бота</b>", "", f"Черга: <b>{escape(queue)}</b>"]
    if title:
        lines.append(f"Останній пост: {escape(title)}")
    if last_check_age_sec is not None:
        lines.append(f"Остання перевірка: {humanize_seconds(last_check_age_sec)} тому")
    if scenario is None:
        lines.append("Стан черги: ⏳ даних ще немає")
    else:
        lines.append(f"Стан черги: {_scenario_line(queue, scenario, times)}")
    lines.append(f"Аптайм: {humanize_seconds(uptime_sec)}")
    if last_error:
        lines.append(f"⚠️ Остання помилка: {escape(last_error)}")
    return "\n".join(lines)
