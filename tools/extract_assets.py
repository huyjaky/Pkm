#!/usr/bin/env python3
"""Extract everything the web app needs from a built pokeemerald-expansion tree.

Outputs (into --out):
  rom.gba            the built ROM (copied)
  meta.json          RAM symbol addresses, map names, region-map sections,
                     species / move / item / type tables
  region_map.png     composed Hoenn region map (248x152)
  sprites/<id>.png   64x64 front sprite per species id (first frame)
  icons/<id>.png     32x32 party icon per species id (first frame)

Usage:
  python extract_assets.py --repo /src/pokeemerald-expansion --out /assets [--nm arm-none-eabi-nm]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

RAM_SYMBOLS = [
    "gSaveBlock1Ptr",
    "gSaveBlock2Ptr",
    "gParties",
    "gPartiesCount",
    "gMapHeader",
    "gMain",
    "CB2_Overworld",
    # added by rom-patch/ (online players in the overworld); optional
    "gOnlineSelf",
    "gOnlinePlayers",
    "gOnlinePlayersMagic",
]

# Region map is drawn with a 1-tile margin on the left and 2 tiles on top (region_map.c).
REGION_MAP_X_OFFSET = 1
REGION_MAP_Y_OFFSET = 2
REGION_MAP_CROP = (0, 0, 31 * 8, 19 * 8)


# --------------------------------------------------------------------------- symbols
def read_symbols(repo: Path, nm: str) -> dict[str, int]:
    """Prefer `nm` on the ELF, fall back to parsing the linker .map file."""
    elf = repo / "pokeemerald.elf"
    found: dict[str, int] = {}
    if elf.exists() and shutil.which(nm):
        out = subprocess.run([nm, str(elf)], capture_output=True, text=True, check=True).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 3 and parts[2] in RAM_SYMBOLS:
                found[parts[2]] = int(parts[0], 16)
    if len(found) < len(RAM_SYMBOLS):
        map_file = repo / "pokeemerald.map"
        if map_file.exists():
            text = map_file.read_text(errors="ignore")
            for sym in RAM_SYMBOLS:
                if sym in found:
                    continue
                m = re.search(r"0x([0-9a-fA-F]{8,16})\s+" + re.escape(sym) + r"\s*$", text, re.M)
                if m:
                    found[sym] = int(m.group(1), 16)
    missing = [s for s in RAM_SYMBOLS if s not in found]
    if missing:
        print(f"WARNING: missing RAM symbols: {missing}", file=sys.stderr)
    return found


# --------------------------------------------------------------------------- enums
def preprocess(repo: Path, header: str) -> str:
    """Run the C preprocessor so #if blocks inside enums resolve. Falls back to raw text."""
    cpp = shutil.which("cpp")
    if cpp:
        res = subprocess.run(
            [cpp, "-P", "-w", "-DMODERN=1", "-I", str(repo / "include"), "-I", str(repo / "gflib"),
             "-I", str(repo), str(repo / header)],
            capture_output=True, text=True,
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout
        print(f"WARNING: cpp failed for {header}, using raw text: {res.stderr[:300]}", file=sys.stderr)
    raw = (repo / header).read_text(errors="ignore")
    return "\n".join(l for l in raw.splitlines() if not l.lstrip().startswith("#"))


_COMMENT_RE = re.compile(r"//[^\n]*|/\*.*?\*/", re.S)


def parse_enum(text: str, enum_name: str, prefix: str) -> dict[str, int]:
    """Evaluate the members of `enum [attrs] <enum_name> { ... }`."""
    text = _COMMENT_RE.sub("", text)
    m = re.search(r"enum\s+(?:__attribute__\s*\(\(\s*\w+\s*\)\)\s*)?" + re.escape(enum_name) + r"\s*\{(.*?)\}", text, re.S)
    if not m:
        raise ValueError(f"enum {enum_name} not found")
    values: dict[str, int] = {}
    nxt = 0
    for entry in m.group(1).split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" in entry:
            name, expr = (s.strip() for s in entry.split("=", 1))
            expr = re.sub(r"(\d+)[uUlL]+\b", r"\1", expr)
            try:
                val = int(eval(expr, {"__builtins__": {}}, dict(values)))  # noqa: S307 - trusted repo input
            except Exception:
                print(f"WARNING: cannot evaluate {name} = {expr}", file=sys.stderr)
                continue
        else:
            name, val = entry, nxt
        values[name] = val
        nxt = val + 1
    return {k: v for k, v in values.items() if k.startswith(prefix)}


def invert(values: dict[str, int], prefix: str, stop: set[str]) -> dict[int, str]:
    """id -> constant name (without prefix), first name wins (aliases skipped)."""
    out: dict[int, str] = {}
    for name, val in values.items():
        if name in stop or name.endswith("_COUNT") or "COUNT_GEN" in name:
            continue
        out.setdefault(val, name[len(prefix):])
    return out


# --------------------------------------------------------------------------- species info
def species_display_and_gfx(repo: Path) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """Return (SPECIES_X -> display name, SPECIES_X -> front pic symbol, SPECIES_X -> icon symbol)."""
    names: dict[str, str] = {}
    front: dict[str, str] = {}
    icon: dict[str, str] = {}
    for f in sorted((repo / "src/data/pokemon/species_info").glob("*.h")):
        text = f.read_text(errors="ignore")
        blocks = re.split(r"\n\s*\[(SPECIES_\w+)\]\s*=", text)
        for i in range(1, len(blocks) - 1, 2):
            key, body = blocks[i], blocks[i + 1]
            if m := re.search(r'\.speciesName\s*=\s*_\("([^"]*)"\)', body):
                names.setdefault(key, m.group(1))
            if m := re.search(r"\.frontPic\s*=\s*(\w+)", body):
                front.setdefault(key, m.group(1))
            if m := re.search(r"\.iconSprite\s*=\s*(\w+)", body):
                icon.setdefault(key, m.group(1))
    return names, front, icon


def gfx_paths(repo: Path) -> dict[str, str]:
    """gMonFrontPic_X / gMonIcon_X symbol -> png path (first definition = modern style)."""
    out: dict[str, str] = {}
    for f in (repo / "src/data/graphics").glob("pokemon*.h"):
        for m in re.finditer(r"(gMon(?:FrontPic|Icon)_\w+)\[\]\s*=\s*INC\w+\(\s*\"([^\"]+\.png)\"", f.read_text(errors="ignore")):
            out.setdefault(m.group(1), m.group(2))
    return out


def export_sprite(src: Path, dst: Path, size: int) -> bool:
    from PIL import Image

    try:
        im = Image.open(src)
    except Exception:
        return False
    if im.mode == "P":
        im.info["transparency"] = 0
    im = im.convert("RGBA")
    frame = im.crop((0, 0, im.width, min(im.height, im.width)))
    if frame.size != (size, size):
        frame = frame.resize((size, size), Image.NEAREST)
    frame.save(dst, optimize=True)
    return True


# --------------------------------------------------------------------------- region map
def compose_region_map(repo: Path, dst: Path) -> None:
    from PIL import Image

    d = repo / "graphics/pokenav/region_map"
    sheet = Image.open(d / "map.png").convert("RGBA")
    tiles = (d / "map.bin").read_bytes()
    per_row = sheet.width // 8
    out = Image.new("RGBA", (512, 512))
    for ty in range(64):
        for tx in range(64):
            t = tiles[ty * 64 + tx]
            sx, sy = (t % per_row) * 8, (t // per_row) * 8
            out.paste(sheet.crop((sx, sy, sx + 8, sy + 8)), (tx * 8, ty * 8))
    out.crop(REGION_MAP_CROP).save(dst, optimize=True)


# --------------------------------------------------------------------------- maps
def map_names(repo: Path) -> list[list[str]]:
    """[group][num] -> map name, following map_groups.json order (= MAP_GROUP / MAP_NUM)."""
    groups = json.loads((repo / "data/maps/map_groups.json").read_text())
    return [groups[g] for g in groups["group_order"]]


def humanize(name: str) -> str:
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|_", " ", name)
    return re.sub(r"\s+", " ", s).strip()


# --------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--nm", default="arm-none-eabi-nm")
    ap.add_argument("--skip-rom", action="store_true", help="do not require/copy the built ROM")
    args = ap.parse_args()
    repo: Path = args.repo
    out: Path = args.out
    (out / "sprites").mkdir(parents=True, exist_ok=True)
    (out / "icons").mkdir(parents=True, exist_ok=True)

    if not args.skip_rom:
        rom = repo / "pokeemerald.gba"
        if not rom.exists():
            print("ERROR: pokeemerald.gba not found - build the ROM first", file=sys.stderr)
            return 1
        shutil.copyfile(rom, out / "rom.gba")
    rom_hash = hashlib.sha1((out / "rom.gba").read_bytes()).hexdigest() if (out / "rom.gba").exists() else ""

    symbols = read_symbols(repo, args.nm)

    species_vals = parse_enum(preprocess(repo, "include/constants/species.h"), "Species", "SPECIES_")
    move_vals = parse_enum(preprocess(repo, "include/constants/moves.h"), "Move", "MOVE_")
    item_vals = parse_enum(preprocess(repo, "include/constants/items.h"), "Item", "ITEM_")
    type_vals = parse_enum(preprocess(repo, "include/constants/pokemon.h"), "Type", "TYPE_")

    species = invert(species_vals, "SPECIES_", {"NUM_SPECIES"})
    moves = invert(move_vals, "MOVE_", {"MOVES_COUNT", "MOVES_COUNT_ALL"})
    items = invert(item_vals, "ITEM_", {"ITEMS_COUNT"})
    types = invert(type_vals, "TYPE_", {"NUMBER_OF_MON_TYPES"})

    disp, front_sym, icon_sym = species_display_and_gfx(repo)
    paths = gfx_paths(repo)
    sprite_ok = icon_ok = 0
    species_table = {}
    for sid, cname in species.items():
        key = "SPECIES_" + cname
        species_table[sid] = {"const": cname, "name": disp.get(key, humanize(cname.title()))}
        if (sym := front_sym.get(key)) and (p := paths.get(sym)):
            sprite_ok += export_sprite(repo / p, out / "sprites" / f"{sid}.png", 64)
        if (sym := icon_sym.get(key)) and (p := paths.get(sym)):
            icon_ok += export_sprite(repo / p, out / "icons" / f"{sid}.png", 32)

    compose_region_map(repo, out / "region_map.png")
    sections = json.loads((repo / "src/data/region_map/region_map_sections.json").read_text())["map_sections"]
    mapsec_ids = parse_enum(
        "enum Mapsec {" + ",".join(s["id"] for s in sections) + "}", "Mapsec", "MAPSEC_"
    )
    region = [
        {
            "id": mapsec_ids[s["id"]],
            "const": s["id"],
            "name": s.get("name", ""),
            # pixel rectangle on region_map.png
            "rect": [
                (s["x"] + REGION_MAP_X_OFFSET) * 8,
                (s["y"] + REGION_MAP_Y_OFFSET) * 8,
                s.get("width", 1) * 8,
                s.get("height", 1) * 8,
            ] if "x" in s else None,
        }
        for s in sections
    ]

    maps = map_names(repo)
    meta = {
        "version": 1,
        # Clients fetch /api/rom?v=<romHash>, so a rebuilt ROM is never mixed with stale symbols.
        "romHash": rom_hash,
        "symbols": {k: f"0x{v:08X}" for k, v in symbols.items()},
        "layout": {
            "partyMonSize": 100,
            "boxMonSize": 80,
            "saveBlock1": {"pos": 0, "location": 4},
            "mapHeader": {"mapLayout": 0, "regionMapSectionId": 0x14},
            "mapLayout": {"width": 0, "height": 4},
        },
        "maps": [[{"id": m, "name": humanize(m)} for m in g] for g in maps],
        "regionMap": {"image": "region_map.png", "width": REGION_MAP_CROP[2], "height": REGION_MAP_CROP[3], "sections": region},
        "species": species_table,
        "moves": {i: humanize(n.title()) for i, n in moves.items()},
        "moveConsts": moves,
        "items": {i: humanize(n.title()) for i, n in items.items()},
        "itemConsts": items,
        "types": types,
    }
    (out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(
        f"OK: {len(symbols)} symbols, {len(species)} species ({sprite_ok} sprites, {icon_ok} icons), "
        f"{len(moves)} moves, {len(items)} items, {sum(len(g) for g in maps)} maps, {len(region)} map sections"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
