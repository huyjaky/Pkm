from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _path(name: str, default: Path) -> Path:
    return Path(os.environ.get(name, str(default))).resolve()


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: _path("DATA_DIR", ROOT / ".data"))
    assets_dir: Path = field(default_factory=lambda: _path("ASSETS_DIR", ROOT / ".dev-assets"))
    web_dir: Path = field(default_factory=lambda: _path("WEB_DIR", ROOT / "web" / "dist"))
    engine_script: Path = field(default_factory=lambda: _path("ENGINE_SCRIPT", ROOT / "battle-engine" / "engine.js"))
    node_bin: str = field(default_factory=lambda: os.environ.get("NODE_BIN", "node"))
    # Empty = open registration. Otherwise new accounts must supply this code.
    invite_code: str = field(default_factory=lambda: os.environ.get("INVITE_CODE", ""))
    session_days: int = field(default_factory=lambda: int(os.environ.get("SESSION_DAYS", "30")))
    cookie_secure: bool = field(default_factory=lambda: os.environ.get("COOKIE_SECURE", "0") == "1")
    max_save_bytes: int = 256 * 1024
    max_state_bytes: int = 2 * 1024 * 1024


settings = Settings()
