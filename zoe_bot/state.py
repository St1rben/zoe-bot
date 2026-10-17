"""Постійний стан бота в SQLite: meta-ключі та підписки чатів."""

from __future__ import annotations

import asyncio
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    queue TEXT,
    created_at REAL NOT NULL
);
"""


@dataclass(frozen=True)
class ChatSubscription:
    chat_id: int
    queue: str | None = None

    def queue_or(self, default: str) -> str:
        return self.queue or default


class StateStore:
    """Асинхронна обгортка над sqlite3 (усі запити — у робочому потоці)."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._conn: sqlite3.Connection | None = None

    async def init(self) -> None:
        def _init() -> sqlite3.Connection:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.executescript(_SCHEMA)
            conn.commit()
            return conn

        self._conn = await asyncio.to_thread(_init)

    async def close(self) -> None:
        if self._conn is not None:
            conn, self._conn = self._conn, None
            await asyncio.to_thread(conn.close)

    async def _execute(
        self,
        sql: str,
        params: tuple[Any, ...] = (),
        *,
        one: bool = False,
        all_: bool = False,
    ) -> Any:
        assert self._conn is not None, "StateStore.init() не викликано"

        async with self._lock:

            def _do() -> Any:
                cursor = self._conn.execute(sql, params)
                self._conn.commit()
                if one:
                    return cursor.fetchone()
                if all_:
                    return cursor.fetchall()
                return cursor.rowcount

            return await asyncio.to_thread(_do)

    # --- meta ---------------------------------------------------------------

    async def get_meta(self, key: str) -> str | None:
        row = await self._execute("SELECT value FROM meta WHERE key = ?", (key,), one=True)
        return row[0] if row else None

    async def set_meta(self, key: str, value: str) -> None:
        await self._execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    async def drop_stale_post_state(self, keep_post_id: str, prefix: str) -> int:
        """Видаляє post_state-ключі, що не належать актуальному посту."""
        rows = await self._execute(
            "SELECT key FROM meta WHERE key LIKE ?", (f"{prefix}:%",), all_=True
        )
        keep_prefix = f"{prefix}:{keep_post_id}:"
        stale = [row[0] for row in rows if not row[0].startswith(keep_prefix)]
        for key in stale:
            await self._execute("DELETE FROM meta WHERE key = ?", (key,))
        return len(stale)

    # --- chats --------------------------------------------------------------

    async def ensure_chat(self, chat_id: int) -> None:
        await self._execute(
            "INSERT OR IGNORE INTO chats (chat_id, queue, created_at) VALUES (?, NULL, ?)",
            (chat_id, time.time()),
        )

    async def set_chat_queue(self, chat_id: int, queue: str) -> None:
        await self._execute(
            "INSERT INTO chats (chat_id, queue, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT(chat_id) DO UPDATE SET queue = excluded.queue",
            (chat_id, queue, time.time()),
        )

    async def get_chat_queue(self, chat_id: int) -> str | None:
        row = await self._execute("SELECT queue FROM chats WHERE chat_id = ?", (chat_id,), one=True)
        return row[0] if row else None

    async def list_chats(self) -> list[ChatSubscription]:
        rows = await self._execute(
            "SELECT chat_id, queue FROM chats ORDER BY created_at", all_=True
        )
        return [ChatSubscription(chat_id=row[0], queue=row[1]) for row in rows]
