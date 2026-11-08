import mGBA, { type mGBAEmulator } from '@thenick775/mgba-wasm';
import {
  EWRAM_SIZE, GbaMemory, IWRAM_SIZE, STATE_EWRAM_OFFSET, STATE_IWRAM_OFFSET,
  extractState, findBlocks, pickLive, readParty, readPosition, writeGhosts,
  type GameSymbols, type Ghost, type PlayerPosition,
} from './ram';

const ROM_PATH = '/data/games/hoenn-link.gba';
const CALIBRATION_SLOT = 9;
const CHECKPOINT_SLOT = 1;
// mGBA SAVESTATE_* flags: SAVEDATA (2) keeps the flash save consistent with the state, RTC (8) the clock.
const CHECKPOINT_FLAGS = 2 | 8;

export type GbaButton = 'a' | 'b' | 'l' | 'r' | 'start' | 'select' | 'up' | 'down' | 'left' | 'right';

/** Members the build exports but its .d.ts does not declare. */
type Core = mGBAEmulator & {
  HEAPU8: Uint8Array;
  saveStateSlot(slot: number, flags?: number): boolean;
  loadStateSlot(slot: number, flags?: number): boolean;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class Emulator {
  private mod: Core;
  private rom = new Uint8Array();
  private memory: GbaMemory | null = null;
  private calibrating: Promise<boolean> | null = null;
  private lastCalibration = 0;
  private saveListeners = new Set<() => void>();
  paused = false;

  /** Raw mGBA module, for debugging only. */
  get core() { return this.mod; }

  private constructor(mod: mGBAEmulator) {
    this.mod = mod as Core;
  }

  static async create(canvas: HTMLCanvasElement): Promise<Emulator> {
    if (!crossOriginIsolated) {
      throw new Error('Trình duyệt chưa bật cross-origin isolation (cần HTTPS hoặc localhost).');
    }
    const mod = await mGBA({ canvas });
    await mod.FSInit();
    const emu = new Emulator(mod);
    mod.addCoreCallbacks({
      saveDataUpdatedCallback: () => emu.saveListeners.forEach(l => l()),
    });
    return emu;
  }

  /**
   * Writes the ROM into the emulator FS and starts the game. The save on this browser (one file per
   * account) is kept when it is newer than the cloud copy, e.g. after an upload that never finished.
   */
  async boot(rom: ArrayBuffer, cloud: { data: Uint8Array; savedAt: number } | null, userId: number, localSavedAt: number):
    Promise<{ usedLocalSave: boolean }> {
    this.rom = new Uint8Array(rom);
    const fs = this.mod.FS;
    const savePath = `/data/saves/hoenn-link-${userId}.sav`;
    fs.writeFile(ROM_PATH, this.rom);
    const localExists = fs.analyzePath(savePath).exists;
    let usedLocalSave = false;
    if (cloud && cloud.data.length && !(localExists && localSavedAt > cloud.savedAt)) {
      fs.writeFile(savePath, cloud.data);
    } else {
      usedLocalSave = localExists;
    }
    if (!this.mod.loadGame(ROM_PATH, savePath)) throw new Error('mGBA không nạp được ROM');
    this.mod.setCoreSettings({ autoSaveStateEnable: false, restoreAutoSaveStateOnLoad: false });
    this.memory = null;
    this.paused = false;
    return { usedLocalSave };
  }

  onSaveChanged(cb: () => void) {
    this.saveListeners.add(cb);
    return () => this.saveListeners.delete(cb);
  }

  getSave(): Uint8Array | null {
    return this.mod.getSave();
  }

  async persistLocal() {
    try { await this.mod.FSSync(); } catch { /* IndexedDB unavailable (private mode) */ }
  }

  // ------------------------------------------------------------------ controls
  pause() { this.mod.pauseGame(); this.paused = true; }
  resume() { this.mod.resumeGame(); this.paused = false; }
  setVolume(v: number) { this.mod.setVolume(Math.max(0, Math.min(1, v))); }
  setFastForward(mult: number) { this.mod.setFastForwardMultiplier(mult); }
  get fastForward() { return this.mod.getFastForwardMultiplier(); }
  setKeyboard(enabled: boolean) { this.mod.toggleInput(enabled); }
  press(b: GbaButton) { this.mod.buttonPress(b); }
  release(b: GbaButton) { this.mod.buttonUnpress(b); }
  reset() { this.mod.quickReload(); this.memory = null; }

  // ------------------------------------------------------------------ RAM access
  private async calibrate(): Promise<boolean> {
    this.lastCalibration = Date.now();
    const fs = this.mod.FS;
    const dir = this.mod.filePaths().saveStatePath;
    let pausedHere = false;
    try {
      if (!this.paused) { this.mod.pauseGame(); pausedHere = true; }
      await sleep(120);
      if (!this.mod.saveStateSlot(CALIBRATION_SLOT, 0)) return false;
      const name = (fs.readdir(dir) as string[]).find(f => f.endsWith(`.ss${CALIBRATION_SLOT}`));
      if (!name) return false;
      const state = await extractState(fs.readFile(`${dir}/${name}`) as Uint8Array);
      try { fs.unlink(`${dir}/${name}`); } catch { /* ignore */ }
      const heap = this.mod.HEAPU8;
      const iwram = state.subarray(STATE_IWRAM_OFFSET, STATE_IWRAM_OFFSET + IWRAM_SIZE);
      const ewram = state.subarray(STATE_EWRAM_OFFSET, STATE_EWRAM_OFFSET + EWRAM_SIZE);
      const iwramCandidates = findBlocks(heap, iwram);
      const ewramCandidates = findBlocks(heap, ewram);
      if (!iwramCandidates.length || !ewramCandidates.length) return false;
      if (iwramCandidates.length > 1 || ewramCandidates.length > 1) {
        // Let the game run briefly: live RAM changes, the leftover serialisation copy does not.
        if (pausedHere) { this.mod.resumeGame(); pausedHere = false; }
        if (this.paused) return false;
        await sleep(250);
      }
      const iwramAt = pickLive(this.mod.HEAPU8, iwramCandidates, iwram);
      const ewramAt = pickLive(this.mod.HEAPU8, ewramCandidates, ewram);
      if (iwramAt < 0 || ewramAt < 0) return false;
      this.memory = new GbaMemory(() => this.mod.HEAPU8, iwramAt, ewramAt, this.rom);
      return true;
    } catch (e) {
      console.warn('[ram] calibration failed', e);
      return false;
    } finally {
      // Resume only what we paused, and never behind a pause started meanwhile (e.g. a PvP battle).
      if (pausedHere && !this.paused) this.mod.resumeGame();
    }
  }

  /** Ensures RAM offsets are known; recalibrates at most every 15 s. */
  async ensureMemory(sym: GameSymbols): Promise<GbaMemory | null> {
    if (this.memory && this.memory.isRam(this.memory.u32(sym.saveBlock1Ptr))) return this.memory;
    if (this.calibrating) return (await this.calibrating) ? this.memory : null;
    if (Date.now() - this.lastCalibration < 15000) return null;
    this.calibrating = this.calibrate().finally(() => { this.calibrating = null; });
    return (await this.calibrating) ? this.memory : null;
  }

  // ------------------------------------------------------------------ checkpoints
  private statePath(slot: number) {
    const base = ROM_PATH.split('/').pop()!.replace(/\.gba$/, '');
    return `${this.mod.filePaths().saveStatePath}/${base}.ss${slot}`;
  }

  /** Full emulator snapshot (raw mGBA save state) of the running game. */
  captureCheckpoint(): Uint8Array | null {
    const wasPaused = this.paused;
    try {
      if (!wasPaused) this.mod.pauseGame();
      if (!this.mod.saveStateSlot(CHECKPOINT_SLOT, CHECKPOINT_FLAGS)) return null;
      return this.mod.FS.readFile(this.statePath(CHECKPOINT_SLOT)) as Uint8Array;
    } catch (e) {
      console.warn('[checkpoint] capture failed', e);
      return null;
    } finally {
      if (!wasPaused && !this.paused) this.mod.resumeGame();
    }
  }

  /** Resumes exactly where a checkpoint was taken. */
  restoreCheckpoint(state: Uint8Array): boolean {
    try {
      this.mod.FS.writeFile(this.statePath(CHECKPOINT_SLOT), state);
      const ok = this.mod.loadStateSlot(CHECKPOINT_SLOT, CHECKPOINT_FLAGS);
      this.memory = null; // RAM contents changed; re-verify the offsets
      return ok;
    } catch (e) {
      console.warn('[checkpoint] restore failed', e);
      return false;
    }
  }

  /** Shows friends in the overworld (needs the rom-patch symbols). */
  writeGhosts(sym: GameSymbols, slots: (Ghost | null)[]): boolean {
    return this.memory ? writeGhosts(this.memory, sym, slots) : false;
  }

  async read(sym: GameSymbols): Promise<{ pos: PlayerPosition | null; party: { count: number; data: Uint8Array } } | null> {
    const mem = await this.ensureMemory(sym);
    if (!mem) return null;
    return { pos: readPosition(mem, sym), party: readParty(mem, sym) };
  }
}
