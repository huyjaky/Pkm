"""Real-time hub: presence (minimap), chat, PvP challenges, 2v2 team rooms and battle routing."""
from __future__ import annotations

import asyncio
import base64
import binascii
import itertools
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from .db import Database
from .engine import BattleEngine
from .party import PartyMon, decode_party

log = logging.getLogger("hub")

FORMATS = {"singles", "doubles"}
LEVEL_RULES = {0, 50, 100}
DISCONNECT_FORFEIT_SECONDS = 90
# A player who does not answer a battle request in time loses (AFK).
TURN_SECONDS = int(os.environ.get("BATTLE_TURN_SECONDS", "60"))
CHALLENGE_TTL_SECONDS = 60
PRESENCE_INTERVAL = 0.25
CHAT_MAX = 300
CHAT_HISTORY = 50
SEND_TIMEOUT = 3.0


@dataclass
class Player:
    id: int
    name: str
    color: str
    ws: WebSocket | None = None
    pos: dict | None = None
    party: list[PartyMon] = field(default_factory=list)
    battle_id: str | None = None
    room_id: str | None = None
    last_seen: float = field(default_factory=time.time)
    forfeit_task: asyncio.Task | None = None
    last_chat: float = 0.0

    @property
    def online(self) -> bool:
        return self.ws is not None

    def public(self) -> dict:
        return {
            "id": self.id, "name": self.name, "color": self.color, "online": self.online,
            "pos": self.pos, "inBattle": self.battle_id is not None, "roomId": self.room_id,
            "partySize": len([m for m in self.party if not m.isEgg]),
            "lead": self.party[0].speciesId if self.party else None,
        }


@dataclass
class Challenge:
    id: str
    from_id: int
    to_id: int
    format: str
    level: int
    engine: str = "rom"  # "rom": real in-game link battle; "sim": Showdown simulator
    created: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {"id": self.id, "from": self.from_id, "to": self.to_id, "format": self.format,
                "level": self.level, "engine": self.engine}


# gBattleOutcome values (include/constants/battle.h)
B_OUTCOME_WON, B_OUTCOME_LOST, B_OUTCOME_DREW = 1, 2, 3
B_OUTCOME_LINK_BATTLE_RAN = 0x80


@dataclass
class RomBattle:
    """A real link battle running inside the players' ROMs; the server only relays link commands."""
    id: str
    kind: str                # singles | doubles
    players: list[int]       # index = link multiplayer id (0 is the link master)
    names: list[str]
    ended: bool = False
    started: float = field(default_factory=time.time)
    timers: dict[int, asyncio.Task] = field(default_factory=dict)  # user id -> AFK timer

    def mp_of(self, user_id: int) -> int | None:
        return self.players.index(user_id) if user_id in self.players else None

    def summary(self) -> dict:
        return {"id": self.id, "format": self.kind, "level": 0, "engine": "rom",
                "players": [{"slot": f"p{i + 1}", "userId": u, "name": self.names[i]} for i, u in enumerate(self.players)]}


@dataclass
class Room:
    id: str
    host: int
    level: int
    name: str
    teams: dict[str, list[int]] = field(default_factory=lambda: {"A": [], "B": []})

    def members(self) -> list[int]:
        return self.teams["A"] + self.teams["B"]

    def public(self) -> dict:
        return {"id": self.id, "host": self.host, "level": self.level, "name": self.name, "teams": self.teams}


@dataclass
class BattleState:
    id: str
    format: str
    level: int
    slots: dict[str, int]  # slot -> user id
    names: dict[str, str]
    logs: dict[str, list[str]] = field(default_factory=dict)  # slot or "spectator" -> lines
    requests: dict[str, Any] = field(default_factory=dict)
    answered: dict[str, Any] = field(default_factory=dict)  # last request a choice was sent for
    deadlines: dict[str, float] = field(default_factory=dict)  # slot -> epoch seconds
    timers: dict[str, asyncio.Task] = field(default_factory=dict)
    afk: str = ""  # name of the player who timed out
    teams: dict[str, Any] = field(default_factory=dict)
    ended: bool = False
    started: float = field(default_factory=time.time)

    def slot_of(self, user_id: int) -> str | None:
        return next((s for s, u in self.slots.items() if u == user_id), None)

    def side_of(self, slot: str) -> str:
        return "A" if slot in ("p1", "p3") else "B"

    def summary(self) -> dict:
        return {"id": self.id, "format": self.format, "level": self.level,
                "players": [{"slot": s, "userId": u, "name": self.names[s]} for s, u in sorted(self.slots.items())]}


class Hub:
    def __init__(self, db: Database, engine: BattleEngine):
        self.db = db
        self.engine = engine
        self.players: dict[int, Player] = {}
        self.challenges: dict[str, Challenge] = {}
        self.rooms: dict[str, Room] = {}
        self.battles: dict[str, BattleState] = {}
        self.rom_battles: dict[str, RomBattle] = {}
        self.chat: list[dict] = []
        self._ids = itertools.count(1)
        self._presence_dirty = False
        self._presence_task: asyncio.Task | None = None

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._presence_task = asyncio.create_task(self._presence_loop())

    async def stop(self) -> None:
        if self._presence_task:
            self._presence_task.cancel()

    def _new_id(self, prefix: str) -> str:
        return f"{prefix}{next(self._ids)}-{int(time.time() * 1000) % 100000}"

    async def _presence_loop(self) -> None:
        while True:
            await asyncio.sleep(PRESENCE_INTERVAL)
            now = time.time()
            for cid, ch in list(self.challenges.items()):
                if now - ch.created > CHALLENGE_TTL_SECONDS:
                    await self._close_challenge(cid, "expired")
            if self._presence_dirty:
                self._presence_dirty = False
                await self.broadcast({"t": "presence", "players": self._player_list()})

    def _player_list(self) -> list[dict]:
        return [p.public() for p in self.players.values() if p.online or p.battle_id]

    # ------------------------------------------------------------------ sending
    async def send(self, user_id: int, msg: dict) -> None:
        p = self.players.get(user_id)
        if not p or not p.ws:
            return
        ws = p.ws
        try:
            await asyncio.wait_for(ws.send_json(msg), timeout=SEND_TIMEOUT)
        except TimeoutError:
            log.warning("send to %s timed out; closing socket", p.name)
            try:
                await ws.close(code=4008)
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001 - socket closing races
            pass

    async def broadcast(self, msg: dict, exclude: int | None = None) -> None:
        await asyncio.gather(*(self.send(uid, msg) for uid, p in self.players.items() if p.online and uid != exclude))

    async def error(self, user_id: int, message: str) -> None:
        await self.send(user_id, {"t": "error", "message": message})

    # ------------------------------------------------------------------ connections
    async def connect(self, user: Any, ws: WebSocket) -> Player:
        p = self.players.get(user["id"])
        if p is None:
            p = Player(id=user["id"], name=user["username"], color=user["color"])
            self.players[p.id] = p
        elif p.ws is not None:
            old = p.ws
            p.ws = None
            try:
                await old.close(code=4000, reason="Đăng nhập từ tab khác")
            except Exception:  # noqa: BLE001
                pass
        p.ws = ws
        p.last_seen = time.time()
        if p.forfeit_task:
            p.forfeit_task.cancel()
            p.forfeit_task = None
        await self.send(p.id, {
            "t": "hello",
            "you": p.public(),
            "players": self._player_list(),
            "rooms": [r.public() for r in self.rooms.values()],
            "battles": self._battle_list(),
            "challenges": [c.public() for c in self.challenges.values() if p.id in (c.from_id, c.to_id)],
            "chat": self.chat[-CHAT_HISTORY:],
            "party": [m.to_dict() for m in p.party],
        })
        if p.battle_id and (b := self.battles.get(p.battle_id)):
            await self._send_battle_snapshot(p.id, b)
        if p.battle_id and (rb := self.rom_battles.get(p.battle_id)) and not rb.ended:
            # A reloaded page cannot rejoin a link battle that lived in the old emulator: it counts as leaving.
            await self._finish_rom_battle(rb, loser_mp=rb.mp_of(p.id), reason="left")
        self._presence_dirty = True
        return p

    async def disconnect(self, p: Player, ws: WebSocket) -> None:
        if p.ws is not ws:
            return  # replaced by a newer connection
        p.ws = None
        p.last_seen = time.time()
        for cid, ch in list(self.challenges.items()):
            if p.id in (ch.from_id, ch.to_id):
                await self._close_challenge(cid, "offline")
        if p.room_id:
            await self._leave_room(p)
        if p.battle_id:
            p.forfeit_task = asyncio.create_task(self._forfeit_later(p))
        self._presence_dirty = True

    async def _forfeit_later(self, p: Player) -> None:
        await asyncio.sleep(DISCONNECT_FORFEIT_SECONDS)
        if not p.online and p.battle_id and (rb := self.rom_battles.get(p.battle_id)) and not rb.ended:
            await self._finish_rom_battle(rb, loser_mp=rb.mp_of(p.id), reason="left")
            return
        if not p.online and p.battle_id and (b := self.battles.get(p.battle_id)) and not b.ended:
            slot = b.slot_of(p.id)
            if slot:
                await self.engine.send({"cmd": "forfeit", "id": b.id, "slot": slot})

    # ------------------------------------------------------------------ dispatch
    async def handle(self, p: Player, msg: dict) -> None:
        t = msg.get("t")
        handler = getattr(self, f"on_{t}", None) if isinstance(t, str) and t.isidentifier() else None
        if handler is None:
            await self.error(p.id, f"Unknown message {t!r}")
            return
        try:
            await handler(p, msg)
        except RuntimeError as e:  # battle engine down
            await self.error(p.id, f"Máy chủ trận đấu chưa sẵn sàng: {e}")
        except (KeyError, TypeError, ValueError, OverflowError):
            await self.error(p.id, "Dữ liệu gửi lên không hợp lệ")

    # presence ----------------------------------------------------------------
    async def on_pos(self, p: Player, m: dict) -> None:
        try:
            pos = {
                "group": int(m["group"]), "num": int(m["num"]),
                "x": int(m["x"]), "y": int(m["y"]),
                "mapsec": int(m.get("mapsec", -1)),
                "w": int(m.get("w", 0)), "h": int(m.get("h", 0)),
                "facing": int(m.get("facing", 1)), "elev": int(m.get("elev", 3)), "gfx": int(m.get("gfx", 0)),
            }
        except (KeyError, TypeError, ValueError):
            return
        if not all(-32768 <= v <= 32767 for v in pos.values()):
            return
        if pos != p.pos:
            p.pos = pos
            self._presence_dirty = True

    async def on_party(self, p: Player, m: dict) -> None:
        try:
            raw = base64.b64decode(m.get("data", ""), validate=True)
            count = int(m.get("count", 0))
        except (binascii.Error, TypeError, ValueError):
            await self.error(p.id, "Dữ liệu đội hình không hợp lệ")
            return
        mons = decode_party(raw[:600], count)
        if not mons and count:
            return  # mid-write / garbage read, keep previous
        p.party = mons
        self._presence_dirty = True
        await self.send(p.id, {"t": "party", "mons": [x.to_dict() for x in mons]})

    async def on_chat(self, p: Player, m: dict) -> None:
        text = str(m.get("text", "")).strip()[:CHAT_MAX]
        now = time.time()
        if not text or now - p.last_chat < 0.5:
            return
        p.last_chat = now
        entry = {"from": p.id, "name": p.name, "color": p.color, "text": text, "at": int(now * 1000)}
        self.chat.append(entry)
        del self.chat[:-CHAT_HISTORY]
        await self.broadcast({"t": "chat", **entry})

    # 1v1 challenges ----------------------------------------------------------
    def _battle_ready(self, p: Player) -> str | None:
        if p.battle_id:
            return f"{p.name} đang trong trận"
        if not any(not m.isEgg for m in p.party):
            return f"{p.name} chưa có Pokémon nào trong đội"
        return None

    async def on_challenge(self, p: Player, m: dict) -> None:
        fmt = m.get("format", "singles")
        level = int(m.get("level", 50)) if str(m.get("level", 50)).lstrip("-").isdigit() else 50
        target = self.players.get(int(m.get("to", 0) or 0))
        if fmt not in FORMATS or level not in LEVEL_RULES:
            return await self.error(p.id, "Luật thi đấu không hợp lệ")
        if not target or not target.online or target.id == p.id:
            return await self.error(p.id, "Người chơi không trực tuyến")
        for who in (p, target):
            if reason := self._battle_ready(who):
                return await self.error(p.id, reason)
        if any(c.from_id == p.id and c.to_id == target.id for c in self.challenges.values()):
            return await self.error(p.id, "Bạn đã gửi lời thách đấu rồi")
        engine = "sim" if m.get("engine") == "sim" else "rom"
        ch = Challenge(id=self._new_id("c"), from_id=p.id, to_id=target.id, format=fmt, level=level, engine=engine)
        self.challenges[ch.id] = ch
        await self.send(p.id, {"t": "challenge", "challenge": ch.public()})
        await self.send(target.id, {"t": "challenge", "challenge": ch.public()})

    async def _close_challenge(self, cid: str, reason: str) -> None:
        ch = self.challenges.pop(cid, None)
        if ch:
            for uid in (ch.from_id, ch.to_id):
                await self.send(uid, {"t": "challenge_closed", "id": cid, "reason": reason})

    async def on_challenge_cancel(self, p: Player, m: dict) -> None:
        ch = self.challenges.get(str(m.get("id")))
        if ch and p.id in (ch.from_id, ch.to_id):
            await self._close_challenge(ch.id, "cancelled" if p.id == ch.from_id else "declined")

    async def on_challenge_reply(self, p: Player, m: dict) -> None:
        ch = self.challenges.get(str(m.get("id")))
        if not ch or ch.to_id != p.id:
            return
        if not m.get("accept"):
            return await self._close_challenge(ch.id, "declined")
        a, b = self.players.get(ch.from_id), self.players.get(ch.to_id)
        for who in (a, b):
            if not who or not who.online:
                return await self._close_challenge(ch.id, "offline")
            if reason := self._battle_ready(who):
                await self.error(p.id, reason)
                return await self._close_challenge(ch.id, "unavailable")
        await self._close_challenge(ch.id, "accepted")
        if ch.engine == "rom":
            await self._start_rom_battle(ch.format, [a, b])
        else:
            await self._start_battle(ch.format, ch.level, {"p1": a, "p2": b})

    # 2v2 team rooms ----------------------------------------------------------
    async def _rooms_changed(self) -> None:
        await self.broadcast({"t": "rooms", "rooms": [r.public() for r in self.rooms.values()]})
        self._presence_dirty = True

    async def on_room_create(self, p: Player, m: dict) -> None:
        if p.room_id or p.battle_id:
            return await self.error(p.id, "Bạn đang ở phòng hoặc trận khác")
        level = m.get("level", 50)
        level = level if level in LEVEL_RULES else 50
        name = str(m.get("name") or f"Phòng của {p.name}")[:40]
        room = Room(id=self._new_id("r"), host=p.id, level=level, name=name)
        room.teams["A"].append(p.id)
        self.rooms[room.id] = room
        p.room_id = room.id
        await self._rooms_changed()

    async def on_room_join(self, p: Player, m: dict) -> None:
        room = self.rooms.get(str(m.get("id")))
        team = m.get("team")
        if not room or team not in ("A", "B"):
            return await self.error(p.id, "Phòng không tồn tại")
        if p.battle_id:
            return await self.error(p.id, "Bạn đang trong trận")
        if p.id in room.teams[team]:
            return
        if len(room.teams[team]) >= 2:
            return await self.error(p.id, "Đội này đã đủ 2 người")
        if p.room_id and p.room_id != room.id:
            await self._leave_room(p, notify=False)
        for side in ("A", "B"):
            if p.id in room.teams[side]:
                room.teams[side].remove(p.id)
        room.teams[team].append(p.id)
        p.room_id = room.id
        await self._rooms_changed()

    async def on_room_leave(self, p: Player, m: dict) -> None:
        if p.room_id:
            await self._leave_room(p)

    async def _leave_room(self, p: Player, notify: bool = True) -> None:
        room = self.rooms.get(p.room_id or "")
        p.room_id = None
        if room:
            for side in ("A", "B"):
                if p.id in room.teams[side]:
                    room.teams[side].remove(p.id)
            if not room.members():
                self.rooms.pop(room.id, None)
            elif room.host == p.id:
                room.host = room.members()[0]
        if notify:
            await self._rooms_changed()

    async def on_room_start(self, p: Player, m: dict) -> None:
        room = self.rooms.get(p.room_id or "")
        if not room or room.host != p.id:
            return await self.error(p.id, "Chỉ chủ phòng mới bắt đầu được")
        if len(room.teams["A"]) != 2 or len(room.teams["B"]) != 2:
            return await self.error(p.id, "Cần đủ 2 đội × 2 người")
        members = [self.players[u] for u in room.members()]
        for who in members:
            if not who.online:
                return await self.error(p.id, f"{who.name} đã offline")
            if reason := self._battle_ready(who):
                return await self.error(p.id, reason)
        slots = {"p1": self.players[room.teams["A"][0]], "p2": self.players[room.teams["B"][0]],
                 "p3": self.players[room.teams["A"][1]], "p4": self.players[room.teams["B"][1]]}
        self.rooms.pop(room.id, None)
        for who in members:
            who.room_id = None
        await self._rooms_changed()
        await self._start_battle("multi", room.level, slots)

    # battles -----------------------------------------------------------------
    async def _start_battle(self, fmt: str, level: int, slots: dict[str, Player]) -> None:
        bid = self._new_id("b")
        state = BattleState(id=bid, format=fmt, level=level,
                            slots={s: pl.id for s, pl in slots.items()},
                            names={s: pl.name for s, pl in slots.items()})
        state.logs = {s: [] for s in slots} | {"spectator": []}
        self.battles[bid] = state
        for pl in slots.values():
            pl.battle_id = bid
        players = [
            {"slot": s, "name": pl.name, "team": [m.to_dict() for m in pl.party if not m.isEgg]}
            for s, pl in slots.items()
        ]
        # Everyone must know about the battle before the engine starts streaming logs and requests.
        info = state.summary() | {"colors": {s: pl.color for s, pl in slots.items()}}
        for s, pl in slots.items():
            await self.send(pl.id, {"t": "battle_start", "battle": info | {"mySlot": s}})
        try:
            await self.engine.send({"cmd": "create", "id": bid, "format": fmt, "level": level, "players": players})
        except RuntimeError as e:
            await self._abort_battle(state, str(e))
            return
        await self.broadcast({"t": "battles", "battles": self._battle_list()})
        self._presence_dirty = True

    # in-ROM link battles -----------------------------------------------------------
    def _battle_list(self) -> list[dict]:
        return [b.summary() for b in self.battles.values() if not b.ended] +                [r.summary() for r in self.rom_battles.values() if not r.ended]

    async def _start_rom_battle(self, kind: str, players: list[Player]) -> None:
        rb = RomBattle(id=self._new_id("v"), kind=kind, players=[pl.id for pl in players], names=[pl.name for pl in players])
        self.rom_battles[rb.id] = rb
        roster = [{"mpId": i, "userId": pl.id, "name": pl.name, "color": pl.color} for i, pl in enumerate(players)]
        for i, pl in enumerate(players):
            pl.battle_id = rb.id
            await self.send(pl.id, {"t": "vlink_start", "battle": {
                "id": rb.id, "kind": kind, "mpId": i, "count": len(players), "players": roster}})
        await self.broadcast({"t": "battles", "battles": self._battle_list()})
        self._presence_dirty = True

    async def on_vlink_cmds(self, p: Player, m: dict) -> None:
        rb = self.rom_battles.get(str(m.get("battle")))
        mp = rb.mp_of(p.id) if rb else None
        data = m.get("data")
        if not rb or rb.ended or mp is None or not isinstance(data, str) or len(data) > 65536:
            return
        for uid in rb.players:
            if uid != p.id:
                await self.send(uid, {"t": "vlink_cmds", "battle": rb.id, "from": mp, "data": data})

    async def on_vlink_input(self, p: Player, m: dict) -> None:
        """The player's ROM started (waiting=True) or stopped waiting for their battle choice."""
        rb = self.rom_battles.get(str(m.get("battle")))
        mp = rb.mp_of(p.id) if rb else None
        if not rb or rb.ended or mp is None:
            return
        old = rb.timers.pop(p.id, None)
        if old:
            old.cancel()
        deadline = None
        if m.get("waiting"):
            deadline = time.time() + TURN_SECONDS
            rb.timers[p.id] = asyncio.create_task(self._rom_turn_timeout(rb, p.id, TURN_SECONDS))
        await self.send(p.id, {"t": "vlink_deadline", "battle": rb.id, "deadline": int(deadline * 1000) if deadline else None})

    async def _rom_turn_timeout(self, rb: RomBattle, user_id: int, seconds: float) -> None:
        await asyncio.sleep(seconds)
        if not rb.ended:
            log.info("rom battle %s: %s timed out (AFK)", rb.id, rb.names[rb.mp_of(user_id) or 0])
            await self._finish_rom_battle(rb, loser_mp=rb.mp_of(user_id), reason="afk")

    async def on_vlink_end(self, p: Player, m: dict) -> None:
        """A player's ROM finished the battle and reports gBattleOutcome from its own point of view."""
        rb = self.rom_battles.get(str(m.get("battle")))
        mp = rb.mp_of(p.id) if rb else None
        if not rb or mp is None:
            return
        if rb.ended:
            if p.battle_id == rb.id:
                p.battle_id = None
                self._presence_dirty = True
            return
        outcome = int(m.get("outcome", 0))
        base = outcome & 0x7F
        if base == B_OUTCOME_WON:
            await self._finish_rom_battle(rb, loser_mp=mp ^ 1)
        elif base == B_OUTCOME_DREW:
            await self._finish_rom_battle(rb, loser_mp=None)
        else:  # lost, ran away (forfeit) or anything else counts as a loss for the reporter
            await self._finish_rom_battle(rb, loser_mp=mp)

    async def _finish_rom_battle(self, rb: RomBattle, loser_mp: int | None, reason: str = "") -> None:
        rb.ended = True
        for task in rb.timers.values():
            if task is not asyncio.current_task():
                task.cancel()
        rb.timers.clear()
        if loser_mp is not None:
            winners = [u for i, u in enumerate(rb.players) if (i & 1) != (loser_mp & 1)]
            losers = [u for i, u in enumerate(rb.players) if (i & 1) == (loser_mp & 1)]
            self.db.record_result(winners, losers)
        for i, uid in enumerate(rb.players):
            won = loser_mp is not None and (i & 1) != (loser_mp & 1)
            await self.send(uid, {"t": "vlink_end", "battle": rb.id, "won": won, "reason": reason,
                                  "winner": rb.names[loser_mp ^ 1] if loser_mp is not None and len(rb.names) > 1 else ""})
            if (pl := self.players.get(uid)) and pl.battle_id == rb.id and (reason or not pl.online):
                pl.battle_id = None
        self.rom_battles.pop(rb.id, None)
        await self.broadcast({"t": "battles", "battles": self._battle_list()})
        self._presence_dirty = True

    async def _abort_battle(self, b: BattleState, reason: str) -> None:
        b.ended = True
        self._cancel_all_timers(b)
        try:
            await self.engine.send({"cmd": "destroy", "id": b.id})
        except RuntimeError:
            pass
        for s, uid in b.slots.items():
            if (pl := self.players.get(uid)) and pl.battle_id == b.id:
                pl.battle_id = None
            await self.send(uid, {"t": "battle_end", "battle": b.id, "winner": "", "aborted": reason})
        self.battles.pop(b.id, None)
        self._presence_dirty = True

    async def _send_battle_snapshot(self, user_id: int, b: BattleState) -> None:
        slot = b.slot_of(user_id)
        if not slot:
            return
        pl = {s: self.players.get(u) for s, u in b.slots.items()}
        info = b.summary() | {"mySlot": slot, "colors": {s: (x.color if x else "#888") for s, x in pl.items()}}
        await self.send(user_id, {
            "t": "battle_resume", "battle": info, "lines": b.logs.get(slot, []),
            "request": b.requests.get(slot), "teams": b.teams.get(slot),
            "deadline": self._deadline_ms(b, slot),
        })

    # turn timer ------------------------------------------------------------------
    @staticmethod
    def _deadline_ms(b: BattleState, slot: str) -> int | None:
        d = b.deadlines.get(slot)
        return int(d * 1000) if d and slot in b.requests else None

    def _arm_timer(self, b: BattleState, slot: str, seconds: float | None = None) -> None:
        seconds = TURN_SECONDS if seconds is None else seconds
        self._cancel_timer(b, slot)
        b.deadlines[slot] = time.time() + seconds
        b.timers[slot] = asyncio.create_task(self._turn_timeout(b, slot, seconds))

    def _cancel_timer(self, b: BattleState, slot: str) -> None:
        task = b.timers.pop(slot, None)
        if task and task is not asyncio.current_task():
            task.cancel()
        b.deadlines.pop(slot, None)

    def _cancel_all_timers(self, b: BattleState) -> None:
        for slot in list(b.timers):
            self._cancel_timer(b, slot)

    async def _turn_timeout(self, b: BattleState, slot: str, seconds: float) -> None:
        await asyncio.sleep(seconds)
        if b.ended or slot not in b.requests:
            return  # answered in time
        b.afk = b.names.get(slot, slot)
        log.info("battle %s: %s timed out (AFK)", b.id, b.afk)
        for uid in b.slots.values():
            await self.send(uid, {"t": "battle_log", "battle": b.id,
                                  "lines": [f"|message|{b.afk} không chọn trong {TURN_SECONDS} giây (AFK) và bị xử thua."]})
        try:
            await self.engine.send({"cmd": "forfeit", "id": b.id, "slot": slot})
        except RuntimeError:
            await self._abort_battle(b, "Máy chủ trận đấu chưa sẵn sàng")

    async def on_choose(self, p: Player, m: dict) -> None:
        b = self.battles.get(str(m.get("battle")))
        slot = b.slot_of(p.id) if b else None
        if not b or not slot or b.ended:
            return
        choice = str(m.get("choice", ""))[:100]
        if slot in b.requests:
            b.answered[slot] = b.requests.pop(slot)
        await self.engine.send({"cmd": "choose", "id": b.id, "slot": slot, "choice": choice})

    async def on_forfeit(self, p: Player, m: dict) -> None:
        b = self.battles.get(str(m.get("battle")))
        slot = b.slot_of(p.id) if b else None
        if b and slot and not b.ended:
            await self.engine.send({"cmd": "forfeit", "id": b.id, "slot": slot})

    async def on_battle_leave(self, p: Player, m: dict) -> None:
        """Close the result screen after a battle ended."""
        b = self.battles.get(str(m.get("battle")))
        if b and b.ended and p.battle_id == b.id:
            p.battle_id = None
            self._presence_dirty = True

    async def on_ping(self, p: Player, m: dict) -> None:
        await self.send(p.id, {"t": "pong", "at": m.get("at")})

    # engine events -------------------------------------------------------------
    async def on_engine_event(self, evt: dict) -> None:
        kind = evt.get("evt")
        if kind == "engine_restart":
            for b in list(self.battles.values()):
                if not b.ended:
                    await self._abort_battle(b, "Máy chủ trận đấu khởi động lại")
            return
        b = self.battles.get(evt.get("id") or "")
        if not b:
            return
        if kind == "log":
            views: dict[str, list[str]] = evt.get("views", {})
            for key, lines in views.items():
                b.logs.setdefault(key, []).extend(lines)
            for s, uid in b.slots.items():
                await self.send(uid, {"t": "battle_log", "battle": b.id, "lines": views.get(s, [])})
        elif kind == "request":
            slot = evt["slot"]
            req = evt["request"]
            b.answered.pop(slot, None)
            if req.get("wait"):
                b.requests.pop(slot, None)
                self._cancel_timer(b, slot)
            else:
                b.requests[slot] = req
                self._arm_timer(b, slot)
            await self.send(b.slots[slot], {"t": "battle_request", "battle": b.id, "request": req,
                                            "deadline": self._deadline_ms(b, slot)})
        elif kind == "teams":
            b.teams = evt.get("teams", {})
            for s, uid in b.slots.items():
                await self.send(uid, {"t": "battle_teams", "battle": b.id, "team": b.teams.get(s)})
        elif kind == "error":
            slot = evt.get("slot")
            if slot:
                if slot in b.answered:  # choice rejected: the request is still open
                    b.requests[slot] = b.answered.pop(slot)
                    remaining = b.deadlines.get(slot, 0) - time.time()
                    if slot not in b.timers or b.timers[slot].done():
                        self._arm_timer(b, slot, max(remaining, 15))
                await self.send(b.slots[slot], {"t": "battle_error", "battle": b.id, "message": evt.get("message", "")})
            elif not b.ended:
                await self._abort_battle(b, evt.get("message", "Lỗi trận đấu"))
        elif kind == "end":
            await self._finish_battle(b, evt.get("winner", ""))

    async def _finish_battle(self, b: BattleState, winner_name: str) -> None:
        b.ended = True
        self._cancel_all_timers(b)
        win_slot = next((s for s, n in b.names.items() if n == winner_name), None)
        win_side = b.side_of(win_slot) if win_slot else None
        if win_side:
            winners = [u for s, u in b.slots.items() if b.side_of(s) == win_side]
            losers = [u for s, u in b.slots.items() if b.side_of(s) != win_side]
            self.db.record_result(winners, losers)
        for s, uid in b.slots.items():
            await self.send(uid, {"t": "battle_end", "battle": b.id, "winner": winner_name,
                                  "won": bool(win_side and b.side_of(s) == win_side), "afk": b.afk or None})
            if (pl := self.players.get(uid)) and pl.battle_id == b.id:
                pl.battle_id = None
        try:
            await self.engine.send({"cmd": "destroy", "id": b.id})
        except RuntimeError:
            pass
        self.battles.pop(b.id, None)
        await self.broadcast({"t": "battles", "battles": self._battle_list()})
        self._presence_dirty = True
