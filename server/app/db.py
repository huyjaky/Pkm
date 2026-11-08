"""Tiny SQLite persistence layer (users, sessions, cloud saves)."""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash     BLOB NOT NULL,
    color       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    wins        INTEGER NOT NULL DEFAULT 0,
    losses      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saves (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sram        BLOB,
    sram_at     INTEGER,
    state       BLOB,
    state_at    INTEGER
);
"""


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)

    def query(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        rows = self.query(sql, args)
        return rows[0] if rows else None

    def execute(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            cur = self._conn.execute(sql, args)
            return cur.lastrowid or cur.rowcount

    # ----------------------------------------------------------------- users
    def create_user(self, username: str, pw_hash: bytes, color: str) -> int:
        return self.execute(
            "INSERT INTO users (username, pw_hash, color, created_at) VALUES (?, ?, ?, ?)",
            (username, pw_hash, color, int(time.time())),
        )

    def user_by_name(self, username: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM users WHERE username = ?", (username,))

    def user_by_id(self, user_id: int) -> sqlite3.Row | None:
        return self.one("SELECT * FROM users WHERE id = ?", (user_id,))

    def record_result(self, winner_ids: list[int], loser_ids: list[int]) -> None:
        for uid in winner_ids:
            self.execute("UPDATE users SET wins = wins + 1 WHERE id = ?", (uid,))
        for uid in loser_ids:
            self.execute("UPDATE users SET losses = losses + 1 WHERE id = ?", (uid,))

    def leaderboard(self, limit: int = 20) -> list[sqlite3.Row]:
        return self.query(
            "SELECT id, username, color, wins, losses FROM users ORDER BY wins DESC, losses ASC LIMIT ?",
            (limit,),
        )

    # ----------------------------------------------------------------- sessions
    def create_session(self, token: str, user_id: int, ttl_seconds: int) -> None:
        self.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        self.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, int(time.time()) + ttl_seconds),
        )

    def session_user(self, token: str) -> sqlite3.Row | None:
        return self.one(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
            (token, int(time.time())),
        )

    def delete_session(self, token: str) -> None:
        self.execute("DELETE FROM sessions WHERE token = ?", (token,))

    # ----------------------------------------------------------------- saves
    def put_sram(self, user_id: int, data: bytes) -> int:
        now = int(time.time())
        self.execute(
            "INSERT INTO saves (user_id, sram, sram_at) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET sram = excluded.sram, sram_at = excluded.sram_at",
            (user_id, data, now),
        )
        return now

    def put_state(self, user_id: int, data: bytes) -> int:
        now = int(time.time())
        self.execute(
            "INSERT INTO saves (user_id, state, state_at) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, state_at = excluded.state_at",
            (user_id, data, now),
        )
        return now

    def get_save(self, user_id: int) -> sqlite3.Row | None:
        return self.one("SELECT * FROM saves WHERE user_id = ?", (user_id,))
