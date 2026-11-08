"""Decode party Pokemon read from emulator RAM (pokeemerald-expansion layout).

struct Pokemon (100 bytes) = struct BoxPokemon (80 bytes) + battle stats (20 bytes).
The 48-byte `secure` block holds four 12-byte substructs, XOR-encrypted with
(personality ^ otId) and shuffled by personality % 24.
"""
from __future__ import annotations

import struct
from dataclasses import asdict, dataclass, field

PARTY_MON_SIZE = 100
BOX_MON_SIZE = 80
SUBSTRUCT_SIZE = 12

# sSubstructOffsets[type][personality % 24] -> slot index inside `secure`
SUBSTRUCT_OFFSETS = (
    (0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3, 1, 1, 2, 3, 2, 3),
    (1, 1, 2, 3, 2, 3, 0, 0, 0, 0, 0, 0, 2, 3, 1, 1, 3, 2, 2, 3, 1, 1, 3, 2),
    (2, 3, 1, 1, 3, 2, 2, 3, 1, 1, 3, 2, 0, 0, 0, 0, 0, 0, 3, 2, 3, 2, 1, 1),
    (3, 2, 3, 2, 1, 1, 3, 2, 3, 2, 1, 1, 3, 2, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0),
)

NUM_NATURES = 25
SHINY_ODDS = 8

# Gen 3 character map (subset that covers names typed on the in-game keyboard).
_CHARMAP: dict[int, str] = {0x00: " "}
_CHARMAP.update({0xA1 + i: str(i) for i in range(10)})
_CHARMAP.update({0xBB + i: chr(ord("A") + i) for i in range(26)})
_CHARMAP.update({0xD5 + i: chr(ord("a") + i) for i in range(26)})
_CHARMAP.update({0xAB: "!", 0xAC: "?", 0xAD: ".", 0xAE: "-", 0xB0: "…", 0xB1: "“", 0xB2: "”",
                 0xB3: "‘", 0xB4: "’", 0xB5: "♂", 0xB6: "♀", 0xB8: ",", 0xBA: "/", 0x1B: "é"})
_EOS = 0xFF


def decode_text(raw: bytes) -> str:
    out = []
    for b in raw:
        if b == _EOS:
            break
        out.append(_CHARMAP.get(b, ""))
    return "".join(out).strip()


def _bits(block: bytes, start: int, length: int) -> int:
    """Read `length` bits starting at bit `start` of a little-endian, LSB-first packed block."""
    return (int.from_bytes(block, "little") >> start) & ((1 << length) - 1)


@dataclass
class PartyMon:
    slot: int
    speciesId: int
    nickname: str
    level: int
    heldItemId: int
    moveIds: list[int]
    abilityNum: int
    nature: int
    ivs: dict[str, int]
    evs: dict[str, int]
    shiny: bool
    teraTypeId: int
    friendship: int
    hp: int
    maxHP: int
    isEgg: bool
    personality: int
    stats: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


class DecodeError(ValueError):
    pass


def decrypt_secure(box: bytes) -> list[bytes]:
    """Return substructs [type0, type1, type2, type3] in logical order (decrypted)."""
    personality, ot_id = struct.unpack_from("<II", box, 0)
    key = personality ^ ot_id
    secure = bytearray(box[32:80])
    for i in range(0, 48, 4):
        (word,) = struct.unpack_from("<I", secure, i)
        struct.pack_into("<I", secure, i, word ^ key)
    order = personality % 24
    return [bytes(secure[SUBSTRUCT_OFFSETS[t][order] * 12:(SUBSTRUCT_OFFSETS[t][order] + 1) * 12]) for t in range(4)]


def checksum(substructs: list[bytes]) -> int:
    """Checksum is the u16 sum of the decrypted secure block in *storage* order; order-independent."""
    total = 0
    for s in substructs:
        for i in range(0, 12, 2):
            total += struct.unpack_from("<H", s, i)[0]
    return total & 0xFFFF


def decode_mon(raw: bytes, slot: int = 0) -> PartyMon | None:
    if len(raw) < PARTY_MON_SIZE:
        raise DecodeError("party mon must be 100 bytes")
    box = raw[:BOX_MON_SIZE]
    personality, ot_id = struct.unpack_from("<II", box, 0)
    flags19 = box[19]
    has_species = bool(flags19 & 0x02)
    if personality == 0 and ot_id == 0 and not has_species:
        return None
    s0, s1, s2, s3 = decrypt_secure(box)
    (stored_checksum,) = struct.unpack_from("<H", box, 28)
    if checksum([s0, s1, s2, s3]) != stored_checksum:
        raise DecodeError(f"bad checksum in party slot {slot}")

    species = _bits(s0, 0, 11)
    if species == 0:
        return None
    tera = _bits(s0, 11, 5)
    item = _bits(s0, 16, 10)
    friendship = s0[9]
    nick11 = _bits(s0, 53, 8)
    nick12 = _bits(s0, 86, 8)

    moves = [_bits(s1, 0, 11), _bits(s1, 16, 11), _bits(s1, 32, 11), _bits(s1, 48, 11)]
    evs = dict(zip(("hp", "atk", "def", "spe", "spa", "spd"), s2[0:6]))
    ivs = {
        "hp": _bits(s3, 32, 5), "atk": _bits(s3, 37, 5), "def": _bits(s3, 42, 5),
        "spe": _bits(s3, 47, 5), "spa": _bits(s3, 52, 5), "spd": _bits(s3, 57, 5),
    }
    is_egg = bool(_bits(s3, 62, 1)) or bool(flags19 & 0x04)
    ability_num = _bits(s3, 93, 2)

    hidden_nature_mod = box[18] >> 3
    nature = (personality % NUM_NATURES) ^ hidden_nature_mod
    if nature >= NUM_NATURES:
        nature = personality % NUM_NATURES
    shiny_value = (ot_id >> 16) ^ (ot_id & 0xFFFF) ^ (personality >> 16) ^ (personality & 0xFFFF)
    shiny_mod = (struct.unpack_from("<H", box, 30)[0] >> 14) & 1
    shiny = (shiny_value < SHINY_ODDS) ^ bool(shiny_mod)

    nickname = decode_text(box[8:18] + bytes([nick11, nick12]))
    level = raw[84]
    hp, max_hp, atk, def_, spe, spa, spd = struct.unpack_from("<7H", raw, 86)
    return PartyMon(
        slot=slot, speciesId=species, nickname=nickname, level=level, heldItemId=item,
        moveIds=[m for m in moves if m], abilityNum=ability_num, nature=nature, ivs=ivs, evs=evs,
        shiny=bool(shiny), teraTypeId=tera, friendship=friendship, hp=hp, maxHP=max_hp,
        isEgg=is_egg, personality=personality,
        stats={"atk": atk, "def": def_, "spe": spe, "spa": spa, "spd": spd},
    )


def decode_party(raw: bytes, count: int) -> list[PartyMon]:
    count = max(0, min(6, count))
    mons: list[PartyMon] = []
    for i in range(count):
        chunk = raw[i * PARTY_MON_SIZE:(i + 1) * PARTY_MON_SIZE]
        if len(chunk) < PARTY_MON_SIZE:
            break
        try:
            mon = decode_mon(chunk, i)
        except DecodeError:
            continue
        if mon:
            mons.append(mon)
    return mons


# ----------------------------------------------------------------------------- test helper
def encode_mon(*, personality: int, ot_id: int, species: int, level: int, moves=(1,), item: int = 0,
               ivs=(31, 31, 31, 31, 31, 31), evs=(0, 0, 0, 0, 0, 0), ability_num: int = 0,
               nickname: str = "", is_egg: bool = False, friendship: int = 70) -> bytes:
    """Build an encrypted 100-byte party mon (used by tests and dev tooling)."""
    def pack_bits(fields: list[tuple[int, int, int]]) -> bytes:
        v = 0
        for start, length, value in fields:
            v |= (value & ((1 << length) - 1)) << start
        return v.to_bytes(12, "little")

    m = list(moves) + [0] * (4 - len(moves))
    s0 = pack_bits([(0, 11, species), (16, 10, item)])
    s0 = s0[:9] + bytes([friendship]) + s0[10:]
    s1 = pack_bits([(0, 11, m[0]), (16, 11, m[1]), (32, 11, m[2]), (48, 11, m[3])])
    s2 = bytes([evs[0], evs[1], evs[2], evs[5], evs[3], evs[4]]) + bytes(6)  # input order hp,atk,def,spa,spd,spe
    hp_iv, atk_iv, def_iv, spa_iv, spd_iv, spe_iv = ivs
    s3 = pack_bits([(16, 7, level), (32, 5, hp_iv), (37, 5, atk_iv), (42, 5, def_iv), (47, 5, spe_iv),
                    (52, 5, spa_iv), (57, 5, spd_iv), (62, 1, int(is_egg)), (93, 2, ability_num)])
    logical = [s0, s1, s2, s3]
    order = personality % 24
    storage = [b""] * 4
    for t in range(4):
        storage[SUBSTRUCT_OFFSETS[t][order]] = logical[t]
    secure = bytearray(b"".join(storage))
    csum = checksum(logical)
    key = personality ^ ot_id
    for i in range(0, 48, 4):
        (w,) = struct.unpack_from("<I", secure, i)
        struct.pack_into("<I", secure, i, w ^ key)
    inv = {v: k for k, v in _CHARMAP.items() if k != 0x00}
    name = bytes(inv.get(c, 0x00) for c in nickname[:10]).ljust(10, bytes([_EOS]))
    box = bytearray(80)
    struct.pack_into("<II", box, 0, personality, ot_id)
    box[8:18] = name
    box[19] = 0x02 | (0x04 if is_egg else 0)
    struct.pack_into("<H", box, 28, csum)
    box[32:80] = secure
    tail = bytearray(20)
    tail[4] = level
    struct.pack_into("<7H", tail, 6, 50, 50, 40, 40, 40, 40, 40)
    return bytes(box) + bytes(tail)
