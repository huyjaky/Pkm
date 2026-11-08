#!/usr/bin/env python3
"""Apply the Hoenn Link online-players patch to a pokeemerald-expansion checkout.

Copies the new source files and inserts two small hooks:
  * overworld.c              - call OnlinePlayers_Update() every overworld frame
  * event_object_movement.c  - ghosts of other players never block movement

Every insertion is anchored on exact upstream text and the script fails loudly if an anchor
is missing, so an upstream refactor breaks the Docker build instead of silently dropping the
feature. Running it twice is a no-op.

Usage: python3 apply.py /path/to/pokeemerald-expansion
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARK = "Hoenn Link"


def patch(path: Path, edits: list[tuple[str, str]]) -> None:
    text = path.read_text()
    if MARK in text:
        print(f"  {path.name}: already patched")
        return
    for anchor, replacement in edits:
        if text.count(anchor) != 1:
            sys.exit(f"ERROR: anchor not found exactly once in {path}:\n{anchor}")
        text = text.replace(anchor, replacement)
    path.write_text(text)
    print(f"  {path.name}: patched")


def main() -> None:
    repo = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    print(f"Applying online-players patch to {repo}")
    shutil.copyfile(HERE / "include/online_players.h", repo / "include/online_players.h")
    shutil.copyfile(HERE / "src/online_players.c", repo / "src/online_players.c")

    patch(repo / "src/overworld.c", [
        ('#include "overworld.h"\n',
         '#include "overworld.h"\n#include "online_players.h" // Hoenn Link\n'),
        ("static void OverworldBasic(void)\n{\n    ScriptContext_RunScript();\n    RunTasks();\n",
         "static void OverworldBasic(void)\n{\n    ScriptContext_RunScript();\n    RunTasks();\n"
         "    OnlinePlayers_Update(); // Hoenn Link\n"),
    ])

    patch(repo / "src/event_object_movement.c", [
        ('#include "overworld.h"\n',
         '#include "overworld.h"\n#include "online_players.h" // Hoenn Link\n'),
        ("    if (objectEvent->localId == OBJ_EVENT_ID_FOLLOWER)\n"
         "        return OBJECT_EVENTS_COUNT; // follower cannot collide with other objects, but they can collide with it\n",
         "    if (objectEvent->localId == OBJ_EVENT_ID_FOLLOWER)\n"
         "        return OBJECT_EVENTS_COUNT; // follower cannot collide with other objects, but they can collide with it\n"
         "    if (IS_LOCALID_ONLINE_PLAYER(objectEvent->localId))\n"
         "        return OBJECT_EVENTS_COUNT; // Hoenn Link: other players' ghosts walk through everything\n"),
        ("         && !FollowerNPC_IsCollisionExempt(curObject, objectEvent)\n",
         "         && !FollowerNPC_IsCollisionExempt(curObject, objectEvent)\n"
         "         && !IS_LOCALID_ONLINE_PLAYER(curObject->localId) // Hoenn Link: nobody bumps into ghosts\n"),
    ])
    print("Done.")


if __name__ == "__main__":
    main()
