"""FastAPI entrypoint: REST API, WebSocket hub and static web app."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict, deque
from urllib.parse import urlparse
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth
from .config import settings
from .db import Database
from .engine import BattleEngine
from .hub import Hub

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

COOKIE = "hl_session"

db = Database(settings.data_dir / "hoenn-link.db")
engine = BattleEngine(settings.node_bin, settings.engine_script, settings.assets_dir)
hub = Hub(db, engine)


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await engine.start(hub.on_engine_event)
    except FileNotFoundError:
        log.error("node not found (%s) - PvP battles disabled", settings.node_bin)
    hub.start()
    yield
    await hub.stop()
    await engine.stop()


app = FastAPI(title="Hoenn Link", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def isolation_headers(request: Request, call_next):
    """mGBA-wasm uses threads (SharedArrayBuffer) and needs cross-origin isolation."""
    response: Response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


# ---------------------------------------------------------------------------- auth helpers
def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    user = db.session_user(token) if token else None
    if not user:
        raise HTTPException(401, "Chưa đăng nhập")
    return user


def user_json(u) -> dict:
    return {"id": u["id"], "username": u["username"], "color": u["color"], "wins": u["wins"], "losses": u["losses"]}


def set_session(response: Response, user_id: int) -> None:
    token = auth.new_token()
    ttl = settings.session_days * 86400
    db.create_session(token, user_id, ttl)
    response.set_cookie(COOKIE, token, max_age=ttl, httponly=True, samesite="strict", secure=settings.cookie_secure)


_attempts: dict[str, deque] = defaultdict(deque)
RATE_WINDOW = 300
RATE_MAX = 10


def rate_limit(request: Request) -> None:
    """At most RATE_MAX login/register attempts per client IP every RATE_WINDOW seconds."""
    ip = request.client.host if request.client else "?"
    now = time.monotonic()
    q = _attempts[ip]
    while q and now - q[0] > RATE_WINDOW:
        q.popleft()
    if len(q) >= RATE_MAX:
        raise HTTPException(429, "Thử quá nhiều lần, hãy đợi vài phút")
    q.append(now)


class Credentials(BaseModel):
    username: str
    password: str
    invite: str | None = None


# ---------------------------------------------------------------------------- REST
@app.get("/api/health")
def health():
    return {"ok": True, "rom": (settings.assets_dir / "rom.gba").exists(), "engine": engine.proc is not None}


@app.get("/api/config")
def public_config():
    return {"inviteRequired": bool(settings.invite_code), "romAvailable": (settings.assets_dir / "rom.gba").exists()}


@app.post("/api/auth/register")
def register(body: Credentials, request: Request, response: Response):
    rate_limit(request)
    if err := auth.validate_credentials(body.username, body.password):
        raise HTTPException(400, err)
    if settings.invite_code and body.invite != settings.invite_code:
        raise HTTPException(403, "Mã mời không đúng")
    if db.user_by_name(body.username):
        raise HTTPException(409, "Tên đăng nhập đã tồn tại")
    count = db.one("SELECT COUNT(*) AS n FROM users")["n"]
    uid = db.create_user(body.username, auth.hash_password(body.password), auth.pick_color(count))
    set_session(response, uid)
    return user_json(db.user_by_id(uid))


@app.post("/api/auth/login")
def login(body: Credentials, request: Request, response: Response):
    rate_limit(request)
    user = db.user_by_name(body.username)
    if not user or not auth.verify_password(body.password, user["pw_hash"]):
        raise HTTPException(401, "Sai tên đăng nhập hoặc mật khẩu")
    set_session(response, user["id"])
    return user_json(user)


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    if token := request.cookies.get(COOKIE):
        db.delete_session(token)
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user=Depends(current_user)):
    save = db.get_save(user["id"])
    return user_json(user) | {
        "saveAt": save["sram_at"] if save else None,
        "stateAt": save["state_at"] if save else None,
    }


_meta_cache: dict = {}


@app.get("/api/meta")
def meta():
    path = settings.assets_dir / "meta.json"
    if not path.exists():
        raise HTTPException(503, "Chưa có meta.json - hãy build assets")
    mtime = path.stat().st_mtime
    if _meta_cache.get("mtime") != mtime:
        _meta_cache.update(mtime=mtime, data=json.loads(path.read_text()))
    return JSONResponse(_meta_cache["data"], headers={"Cache-Control": "public, max-age=300"})


@app.get("/api/rom")
def rom(_=Depends(current_user)):
    path = settings.assets_dir / "rom.gba"
    if not path.exists():
        raise HTTPException(503, "ROM chưa được build")
    return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "private, max-age=3600"})


async def _read_body(request: Request, limit: int) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > limit:
            raise HTTPException(413, "Dữ liệu quá lớn")
    if not data:
        raise HTTPException(400, "Dữ liệu trống")
    return bytes(data)


@app.get("/api/save")
def get_save(user=Depends(current_user)):
    save = db.get_save(user["id"])
    if not save or not save["sram"]:
        raise HTTPException(404, "Chưa có save")
    return Response(save["sram"], media_type="application/octet-stream", headers={"X-Saved-At": str(save["sram_at"])})


@app.put("/api/save")
async def put_save(request: Request, user=Depends(current_user)):
    data = await _read_body(request, settings.max_save_bytes)
    return {"savedAt": db.put_sram(user["id"], data)}


@app.get("/api/state")
def get_state(user=Depends(current_user)):
    save = db.get_save(user["id"])
    if not save or not save["state"]:
        raise HTTPException(404, "Chưa có save state")
    return Response(save["state"], media_type="application/octet-stream", headers={"X-Saved-At": str(save["state_at"])})


@app.put("/api/state")
async def put_state(request: Request, user=Depends(current_user)):
    data = await _read_body(request, settings.max_state_bytes)
    return {"savedAt": db.put_state(user["id"], data)}


@app.get("/api/leaderboard")
def leaderboard(_=Depends(current_user)):
    return [dict(r) for r in db.leaderboard()]


# ---------------------------------------------------------------------------- WebSocket
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=4403)  # cross-site WebSocket hijacking guard
        return
    token = ws.cookies.get(COOKIE)
    user = db.session_user(token) if token else None
    if not user:
        await ws.close(code=4401)
        return
    await ws.accept()
    player = await hub.connect(user, ws)
    try:
        while True:
            msg = await ws.receive_json()
            if isinstance(msg, dict):
                await hub.handle(player, msg)
    except (WebSocketDisconnect, RuntimeError, KeyError, UnicodeDecodeError, json.JSONDecodeError):
        pass
    except asyncio.CancelledError:
        raise
    finally:
        await hub.disconnect(player, ws)


# ---------------------------------------------------------------------------- static
for sub in ("sprites", "icons"):
    (settings.assets_dir / sub).mkdir(parents=True, exist_ok=True)
    app.mount(f"/game/{sub}", StaticFiles(directory=settings.assets_dir / sub), name=sub)


@app.get("/game/region_map.png")
def region_map():
    path = settings.assets_dir / "region_map.png"
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, headers={"Cache-Control": "public, max-age=86400"})


if (settings.web_dir / "assets").exists():
    app.mount("/assets", StaticFiles(directory=settings.web_dir / "assets"), name="web-assets")


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith(("api/", "ws", "game/")):
        raise HTTPException(404)
    candidate = (settings.web_dir / full_path).resolve()
    if full_path and candidate.is_file() and Path(settings.web_dir) in candidate.parents:
        return FileResponse(candidate)
    index = settings.web_dir / "index.html"
    if not index.exists():
        return JSONResponse({"detail": "Web UI chưa được build (cd web && npm run build)"}, status_code=503)
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
