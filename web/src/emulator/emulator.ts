import mGBA, { type mGBAEmulator } from '@thenick775/mgba-wasm';
import {
  EWRAM_SIZE, GbaMemory, IWRAM_SIZE, STATE_EWRAM_OFFSET, STATE_IWRAM_OFFSET,
  extractState, findBlock, readParty, readPosition, type GameSymbols, type PlayerPosition,
} from './ram';

const ROM_PATH = '/data/games/hoenn-link.gba';
const SAVE_PATH = '/data/saves/hoenn-link.sav';
const CALIBRATION_SLOT = 9;

export type GbaButton = 'a' | 'b' | 'l' | 'r' | 'start' | 'select' | 'up' | 'down' | 'left' | 'right';

/** Members the build exports but its .d.ts does not declare. */
type Core = mGBAEmulator & {
  HEAPU8: Uint8Array;
  saveStateSlot(slot: number, flags?: number): boolean;
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

  /** Writes the ROM (and the cloud save, when given) into the emulator FS and starts the game. */
  async boot(rom: ArrayBuffer, cloudSave: Uint8Array | null): Promise<{ usedLocalSave: boolean }> {
    this.rom = new Uint8Array(rom);
    const fs = this.mod.FS;
    fs.writeFile(ROM_PATH, this.rom);
    let usedLocalSave = false;
    if (cloudSave && cloudSave.length) {
      fs.writeFile(SAVE_PATH, cloudSave);
    } else {
      usedLocalSave = fs.analyzePath(SAVE_PATH).exists;
    }
    if (!this.mod.loadGame(ROM_PATH, SAVE_PATH)) throw new Error('mGBA không nạp được ROM');
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
  setKeyboard(enabled: boolean) { this.mod.toggleInput(enabled); }
  press(b: GbaButton) { this.mod.buttonPress(b); }
  release(b: GbaButton) { this.mod.buttonUnpress(b); }
  reset() { this.mod.quickReload(); this.memory = null; }

  // ------------------------------------------------------------------ RAM access
  private async calibrate(): Promise<boolean> {
    this.lastCalibration = Date.now();
    const wasPaused = this.paused;
    const fs = this.mod.FS;
    const dir = this.mod.filePaths().saveStatePath;
    try {
      if (!wasPaused) this.mod.pauseGame();
      await sleep(120);
      if (!this.mod.saveStateSlot(CALIBRATION_SLOT, 0)) return false;
      const name = (fs.readdir(dir) as string[]).find(f => f.endsWith(`.ss${CALIBRATION_SLOT}`));
      if (!name) return false;
      const state = await extractState(fs.readFile(`${dir}/${name}`) as Uint8Array);
      try { fs.unlink(`${dir}/${name}`); } catch { /* ignore */ }
      const heap = this.mod.HEAPU8;
      const iwramAt = findBlock(heap, state.subarray(STATE_IWRAM_OFFSET, STATE_IWRAM_OFFSET + IWRAM_SIZE));
      const ewramAt = findBlock(heap, state.subarray(STATE_EWRAM_OFFSET, STATE_EWRAM_OFFSET + EWRAM_SIZE));
      if (iwramAt < 0 || ewramAt < 0) return false;
      this.memory = new GbaMemory(() => this.mod.HEAPU8, iwramAt, ewramAt, this.rom);
      return true;
    } catch (e) {
      console.warn('[ram] calibration failed', e);
      return false;
    } finally {
      if (!wasPaused) this.mod.resumeGame();
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

  async read(sym: GameSymbols): Promise<{ pos: PlayerPosition | null; party: { count: number; data: Uint8Array } } | null> {
    const mem = await this.ensureMemory(sym);
    if (!mem) return null;
    return { pos: readPosition(mem, sym), party: readParty(mem, sym) };
  }
}
