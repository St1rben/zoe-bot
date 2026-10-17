"""Тести конфігурації."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from zoe_bot.config import Settings


def _settings(**env: str) -> Settings:
    return Settings(_env_file=None, **env)  # type: ignore[arg-type]


def test_required_fields() -> None:
    with pytest.raises(ValidationError):
        _settings()


def test_defaults() -> None:
    settings = _settings(BOT_TOKEN="123:abc", CHAT_ID="-100500")
    assert settings.bot_token == "123:abc"
    assert settings.chat_id == -100500
    assert settings.queue == "5.1"
    assert settings.check_interval == 60
    assert settings.digest_time is None


def test_queue_validation() -> None:
    assert _settings(BOT_TOKEN="t", CHAT_ID="1", QUEUE=" 4.2 ").queue == "4.2"
    with pytest.raises(ValidationError):
        _settings(BOT_TOKEN="t", CHAT_ID="1", QUEUE="abc")


def test_digest_time_normalization() -> None:
    assert _settings(BOT_TOKEN="t", CHAT_ID="1", DIGEST_TIME="").digest_time is None
    assert _settings(BOT_TOKEN="t", CHAT_ID="1", DIGEST_TIME="7:05").digest_time == "07:05"
    assert _settings(BOT_TOKEN="t", CHAT_ID="1", DIGEST_TIME="20:00").digest_time == "20:00"
    with pytest.raises(ValidationError):
        _settings(BOT_TOKEN="t", CHAT_ID="1", DIGEST_TIME="25:00")


def test_log_level_normalization() -> None:
    assert _settings(BOT_TOKEN="t", CHAT_ID="1", LOG_LEVEL="debug").log_level == "DEBUG"


def test_check_interval_lower_bound() -> None:
    with pytest.raises(ValidationError):
        _settings(BOT_TOKEN="t", CHAT_ID="1", CHECK_INTERVAL="1")
