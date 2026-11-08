"""Async client for the Node battle engine (battle-engine/engine.js)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path

log = logging.getLogger("engine")

EventHandler = Callable[[dict], Awaitable[None]]


class BattleEngine:
    def __init__(self, node_bin: str, script: Path, assets_dir: Path):
        self.node_bin = node_bin
        self.script = script
        self.assets_dir = assets_dir
        self.proc: asyncio.subprocess.Process | None = None
        self.handler: EventHandler | None = None
        self._reader: asyncio.Task | None = None
        self._stderr: asyncio.Task | None = None
        self._ready: asyncio.Event | None = None
        self._stopping = False

    async def start(self, handler: EventHandler) -> None:
        self.handler = handler
        self._stopping = False
        await self._spawn()

    async def _spawn(self) -> None:
        self._ready = asyncio.Event()
        env = {**os.environ, "ASSETS_DIR": str(self.assets_dir)}
        self.proc = await asyncio.create_subprocess_exec(
            self.node_bin, str(self.script),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, limit=16 * 1024 * 1024,
        )
        self._reader = asyncio.create_task(self._read_loop())
        self._stderr = asyncio.create_task(self._stderr_loop())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=30)
        except TimeoutError:
            log.error("battle engine did not report ready")

    async def _read_loop(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                log.warning("bad engine line: %r", line[:200])
                continue
            if evt.get("evt") == "ready":
                self._ready.set()
                continue
            if self.handler:
                try:
                    await self.handler(evt)
                except Exception:  # noqa: BLE001 - never let one battle kill the loop
                    log.exception("engine event handler failed")
        if not self._stopping:
            log.error("battle engine exited (code %s); restarting", self.proc.returncode if self.proc else "?")
            if self.handler:
                await self.handler({"evt": "engine_restart"})
            await asyncio.sleep(1)
            await self._spawn()

    async def _stderr_loop(self) -> None:
        assert self.proc and self.proc.stderr
        while line := await self.proc.stderr.readline():
            log.warning("[engine] %s", line.decode(errors="replace").rstrip())

    async def send(self, cmd: dict) -> None:
        if not self.proc or not self.proc.stdin or self.proc.returncode is not None:
            raise RuntimeError("battle engine not running")
        self.proc.stdin.write((json.dumps(cmd) + "\n").encode())
        await self.proc.stdin.drain()

    async def stop(self) -> None:
        self._stopping = True
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except TimeoutError:
                self.proc.kill()
