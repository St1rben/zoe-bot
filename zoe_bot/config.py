"""Конфігурація застосунку: змінні середовища та .env."""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import Field, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
QUEUE_RE = re.compile(r"^\d+(?:\.\d+)?$")
_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


class Settings(BaseSettings):
    """Налаштування бота.

    Значення читаються зі змінних середовища (регістр не важливий)
    та файлу .env поруч із проєктом.
    """

    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    bot_token: str
    chat_id: int

    queue: str = "5.1"
    check_interval: int = Field(default=60, ge=5)

    port: int = Field(default=8080, ge=1, le=65535)
    log_level: str = "INFO"
    state_db: Path = BASE_DIR / "state.db"

    request_timeout: float = Field(default=15.0, gt=0)
    retry_attempts: int = Field(default=3, ge=1, le=10)

    digest_time: str | None = None
    digest_tz: str = "Europe/Kyiv"

    dry_run: bool = False

    @field_validator("queue")
    @classmethod
    def _validate_queue(cls, value: str) -> str:
        value = value.strip()
        if not QUEUE_RE.fullmatch(value):
            raise ValueError("номер черги має вигляд «5.1» або «3»")
        return value

    @field_validator("digest_time", mode="before")
    @classmethod
    def _validate_digest_time(cls, value: object) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        match = _TIME_RE.fullmatch(text)
        if match is None:
            raise ValueError("час має вигляд «20:00»")
        hours, minutes = int(match.group(1)), int(match.group(2))
        if hours > 23 or minutes > 59:
            raise ValueError("некоректний час")
        return f"{hours:02d}:{minutes:02d}"

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, value: str) -> str:
        return value.strip().upper()


def load_settings() -> Settings:
    """Створює Settings або завершує процес із зрозумілим повідомленням."""
    try:
        return Settings()
    except ValidationError as exc:
        raise SystemExit(f"Помилка конфігурації:\n{exc}") from exc
