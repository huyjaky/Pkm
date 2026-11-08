from __future__ import annotations

import re
import secrets

import bcrypt

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,16}$")

# Distinct, readable marker colours for players on the minimap.
PALETTE = [
    "#E5484D", "#3E63DD", "#30A46C", "#F76B15", "#8E4EC6", "#12A594",
    "#D6409F", "#FFC53D", "#0090FF", "#46A758", "#E54666", "#7C66DC",
]


def hash_password(password: str) -> bytes:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))


def verify_password(password: str, pw_hash: bytes) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), pw_hash)
    except ValueError:
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def validate_credentials(username: str, password: str) -> str | None:
    if not USERNAME_RE.match(username or ""):
        return "Tên đăng nhập 3–16 ký tự, chỉ gồm chữ, số và dấu _"
    if not password or len(password) < 6 or len(password) > 128:
        return "Mật khẩu cần 6–128 ký tự"
    return None


def pick_color(user_id: int) -> str:
    return PALETTE[user_id % len(PALETTE)]
