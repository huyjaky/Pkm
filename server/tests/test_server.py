import base64
import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="hl-test-"))
os.environ.setdefault("ASSETS_DIR", str(ROOT / ".dev-assets"))
os.environ.setdefault("NODE_BIN", str(Path(sys.executable).parent / ("node.exe" if os.name == "nt" else "node")))

from fastapi.testclient import TestClient  # noqa: E402

from app.party import decode_mon, decode_party, encode_mon  # noqa: E402


# ------------------------------------------------------------------------------ party decoding
@pytest.mark.parametrize("personality", [0, 7, 13, 23, 0xDEADBEEF, 0x12345678])
def test_decode_roundtrip_all_substruct_orders(personality):
    raw = encode_mon(personality=personality, ot_id=0xCAFEBABE, species=6, level=36, moves=(52, 53, 17),
                     item=472, ivs=(31, 30, 29, 28, 27, 26), evs=(4, 252, 0, 0, 0, 252), ability_num=2,
                     nickname="Blaze")
    mon = decode_mon(raw)
    assert mon.speciesId == 6
    assert mon.level == 36
    assert mon.moveIds == [52, 53, 17]
    assert mon.heldItemId == 472
    assert mon.abilityNum == 2
    assert mon.nickname == "Blaze"
    assert mon.ivs == {"hp": 31, "atk": 30, "def": 29, "spa": 28, "spd": 27, "spe": 26}
    assert mon.evs["atk"] == 252 and mon.evs["spe"] == 252 and mon.evs["hp"] == 4
    assert mon.nature == personality % 25


def test_decode_party_skips_empty_and_corrupt():
    a = encode_mon(personality=1, ot_id=2, species=25, level=10)
    bad = bytearray(encode_mon(personality=3, ot_id=4, species=1, level=5))
    bad[40] ^= 0xFF  # break checksum
    party = decode_party(a + bytes(bad) + bytes(100), 3)
    assert [m.speciesId for m in party] == [25]


# ------------------------------------------------------------------------------ app
@pytest.fixture(scope="module")
def app_module():
    from app import main
    return main


class UserClient:
    """One shared TestClient (single event loop) with a per-user session cookie."""

    def __init__(self, client, token):
        self.client, self.headers = client, {"cookie": f"hl_session={token}"}

    def get(self, url):
        return self.client.get(url, headers=self.headers)

    def websocket_connect(self, url):
        return self.client.websocket_connect(url, headers=self.headers)


def make_client(client, name):
    from app import main
    main._attempts.clear()  # the test client shares one IP; keep the login rate limit out of the way
    r = client.post("/api/auth/register", json={"username": name, "password": "secret123"})
    assert r.status_code == 200, r.text
    token = r.cookies["hl_session"]
    client.cookies.clear()
    return UserClient(client, token)


def party_payload(*species):
    raw = b"".join(encode_mon(personality=i * 97 + 5, ot_id=999, species=s, level=20, moves=(33, 85))
                   for i, s in enumerate(species))
    return {"t": "party", "count": len(species), "data": base64.b64encode(raw).decode()}


def recv_until(ws, t, limit=200):
    for _ in range(limit):
        msg = ws.receive_json()
        if msg.get("t") == t:
            return msg
    raise AssertionError(f"no {t} message")


def test_login_rate_limit(app_module):
    app_module._attempts.clear()
    with TestClient(app_module.app) as c:
        codes = [c.post("/api/auth/login", json={"username": "nobody", "password": "whatever1"}).status_code for _ in range(12)]
        assert codes[:10] == [401] * 10 and codes[-1] == 429
    app_module._attempts.clear()


def test_auth_and_save_flow(app_module):
    app_module._attempts.clear()
    with TestClient(app_module.app) as c:
        assert c.get("/api/me").status_code == 401
        assert c.post("/api/auth/register", json={"username": "ab", "password": "x"}).status_code == 400
        r = c.post("/api/auth/register", json={"username": "May_01", "password": "hunter22"})
        assert r.status_code == 200
        assert c.post("/api/auth/register", json={"username": "may_01", "password": "hunter22"}).status_code == 409
        assert c.get("/api/me").json()["username"] == "May_01"
        assert c.get("/api/save").status_code == 404
        sram = os.urandom(128 * 1024)
        assert c.put("/api/save", content=sram).status_code == 200
        assert c.get("/api/save").content == sram
        assert c.put("/api/save", content=os.urandom(300 * 1024)).status_code == 413
        assert c.post("/api/auth/logout").status_code == 200
        assert c.get("/api/me").status_code == 401
        assert c.post("/api/auth/login", json={"username": "may_01", "password": "wrong!!"}).status_code == 401
        assert c.post("/api/auth/login", json={"username": "may_01", "password": "hunter22"}).status_code == 200
        r = c.get("/api/health")
        assert r.headers["cross-origin-embedder-policy"] == "require-corp"


def test_rejects_cross_site_websocket(app_module):
    from starlette.websockets import WebSocketDisconnect
    with TestClient(app_module.app) as client:
        u = make_client(client, "Origin_T")
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers=u.headers | {"origin": "https://evil.example"}) as ws:
                ws.receive_json()


def test_presence_chat_and_pvp_battle(app_module):
    with TestClient(app_module.app) as client:
        a = make_client(client, "Brendan")
        b = make_client(client, "Wally")
        with a.websocket_connect("/ws") as wa, b.websocket_connect("/ws") as wb:
            hello_a = recv_until(wa, "hello")
            hello_b = recv_until(wb, "hello")
            a_id, b_id = hello_a["you"]["id"], hello_b["you"]["id"]

            wa.send_json({"t": "challenge", "to": "abc", "level": [1]})  # malformed: error reply, socket stays open
            assert recv_until(wa, "error")["message"]
            wa.send_json({"t": "pos", "group": 0, "num": 9, "x": 5, "y": 7, "mapsec": 0, "facing": 4, "elev": 3, "gfx": 89})
            for _ in range(50):
                msg = recv_until(wb, "presence")
                me = next((p for p in msg["players"] if p["id"] == a_id), None)
                if me and me["pos"]:
                    break
            assert me["pos"]["x"] == 5 and me["pos"]["num"] == 9
            assert me["pos"]["gfx"] == 89 and me["pos"]["facing"] == 4

            wa.send_json({"t": "chat", "text": "xin chào"})
            assert recv_until(wb, "chat")["text"] == "xin chào"

            wa.send_json(party_payload(25, 1))
            assert [m["speciesId"] for m in recv_until(wa, "party")["mons"]] == [25, 1]
            wb.send_json(party_payload(4))
            recv_until(wb, "party")

            wa.send_json({"t": "challenge", "to": b_id, "format": "singles", "level": 50})
            ch = recv_until(wb, "challenge")["challenge"]
            wb.send_json({"t": "challenge_reply", "id": ch["id"], "accept": True})
            start = recv_until(wa, "battle_start")["battle"]
            assert start["mySlot"] == "p1"
            bid = start["id"]

            req = recv_until(wa, "battle_request")["request"]
            assert req.get("teamPreview")
            wa.send_json({"t": "choose", "battle": bid, "choice": "default"})
            recv_until(wb, "battle_request")
            wb.send_json({"t": "choose", "battle": bid, "choice": "default"})
            log = recv_until(wa, "battle_log")
            assert any(line.startswith("|") for line in log["lines"])

            wb.send_json({"t": "forfeit", "battle": bid})
            end_a = recv_until(wa, "battle_end")
            assert end_a["won"] is True
            assert recv_until(wb, "battle_end")["won"] is False
            board = a.get("/api/leaderboard").json()
            top = {r["username"]: r for r in board}
            assert top["Brendan"]["wins"] == 1 and top["Wally"]["losses"] == 1


def test_team_room_requires_four(app_module):
    with TestClient(app_module.app) as client:
        cs = [make_client(client, f"Team{i}") for i in range(4)]
        socks = [c.websocket_connect("/ws") for c in cs]
        ws = [s.__enter__() for s in socks]
        try:
            ids = [recv_until(w, "hello")["you"]["id"] for w in ws]
            for i, w in enumerate(ws):
                w.send_json(party_payload(25 + i))
                recv_until(w, "party")
            ws[0].send_json({"t": "room_create", "level": 50})
            room = recv_until(ws[0], "rooms")["rooms"][0]
            ws[0].send_json({"t": "room_start"})
            assert "2 đội" in recv_until(ws[0], "error")["message"]
            ws[1].send_json({"t": "room_join", "id": room["id"], "team": "B"})
            ws[2].send_json({"t": "room_join", "id": room["id"], "team": "A"})
            ws[3].send_json({"t": "room_join", "id": room["id"], "team": "B"})
            for _ in range(20):
                r = recv_until(ws[0], "rooms")["rooms"]
                if r and len(r[0]["teams"]["A"]) == 2 and len(r[0]["teams"]["B"]) == 2:
                    break
            ws[0].send_json({"t": "room_start"})
            slots = {recv_until(w, "battle_start")["battle"]["mySlot"] for w in ws}
            assert slots == {"p1", "p2", "p3", "p4"}
            assert ids
        finally:
            for s in socks:
                s.__exit__(None, None, None)
