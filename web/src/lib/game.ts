import { Emulator } from '../emulator/emulator';
import { ONLINE_SLOTS, type GameSymbols, type Ghost, type PlayerPosition } from '../emulator/ram';
import { api } from './api';
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint';
import { loadMeta, symbol, type Meta } from './meta';
import { send, session, toast } from './session';
import { createStore } from './store';

export type SaveStatus = 'none' | 'synced' | 'pending' | 'saving' | 'error';

type GameState = {
  phase: 'idle' | 'loading' | 'running' | 'error';
  message: string;
  progress: string;
  save: SaveStatus;
  savedAt: number | null;
  ram: 'waiting' | 'ok' | 'unavailable';
  pos: PlayerPosition | null;
  paused: boolean;
  volume: number;
  /** Emulation speed chosen in Settings (1 = normal GBA speed). */
  speed: number;
  /** When the last auto checkpoint was stored (epoch seconds). */
  checkpointAt: number | null;
};

// mGBA takes an integer fast-forward multiplier.
export const SPEEDS = [1, 2, 3, 4] as const;
function loadSpeed(): number {
  try {
    const v = Number(localStorage.getItem('hl-speed'));
    return (SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch { return 1; }
}

export const game = createStore<GameState>({
  phase: 'idle', message: '', progress: '', save: 'none', savedAt: null, ram: 'waiting', pos: null,
  paused: false, volume: 0.8, speed: loadSpeed(), checkpointAt: null,
});

let emu: Emulator | null = null;
let meta: Meta | null = null;
let sym: GameSymbols | null = null;
let lastUploadedHash = -1;
let uploading = false;
const SAVE_SYNC_MS = 5000;
let lastPosKey = '';
let lastPartyKey = '';
let lastPartySent = 0;
let failedReads = 0;
let pausedForBattle = false;
let userId = 0;
/** Friend id -> ghost slot in gOnlinePlayers, kept stable so sprites don't swap. */
const ghostSlots = new Map<number, number>();

const localSaveKey = () => `hl-save-at-${userId}`;
function localSavedAt(): number {
  try { return Number(localStorage.getItem(localSaveKey())) || 0; } catch { return 0; }
}
function markLocalSave() {
  try { localStorage.setItem(localSaveKey(), String(Math.floor(Date.now() / 1000))); } catch { /* storage blocked */ }
}

export const getEmulator = () => emu;

// Debug handle for local testing: localStorage.hlDebug = '1'
try {
  if (import.meta.env.DEV || localStorage.getItem('hlDebug') === '1') {
    (window as unknown as Record<string, unknown>).__hlGame = { getEmulator, game, getSymbols: () => sym };
  }
} catch { /* storage blocked */ }

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function hash(bytes: Uint8Array) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return h >>> 0;
}

export async function startGame(canvas: HTMLCanvasElement, forUser: number) {
  userId = forUser;
  if (game.get().phase === 'loading' || game.get().phase === 'running') return;
  game.set({ phase: 'loading', message: '', progress: 'Khởi động mGBA…' });
  try {
    const cfg = await api.config();
    if (!cfg.romAvailable) throw new Error('Máy chủ chưa có ROM. Hãy build image Docker (README, mục Triển khai) rồi tải lại trang.');
    meta = await loadMeta();
    sym = {
      saveBlock1Ptr: symbol(meta, 'gSaveBlock1Ptr'),
      parties: symbol(meta, 'gParties'),
      partiesCount: symbol(meta, 'gPartiesCount'),
      mapHeader: symbol(meta, 'gMapHeader'),
      main: meta.symbols.gMain ? symbol(meta, 'gMain') : undefined,
      overworldCallback: meta.symbols.CB2_Overworld ? symbol(meta, 'CB2_Overworld') : undefined,
      onlineSelf: meta.symbols.gOnlineSelf ? symbol(meta, 'gOnlineSelf') : undefined,
      onlinePlayers: meta.symbols.gOnlinePlayers ? symbol(meta, 'gOnlinePlayers') : undefined,
      onlineMagic: meta.symbols.gOnlinePlayersMagic ? symbol(meta, 'gOnlinePlayersMagic') : undefined,
    };
    emu = await Emulator.create(canvas);
    game.set({ progress: 'Tải ROM…' });
    const [rom, cloud, cloudCheckpoint] = await Promise.all([
      api.rom(meta.romHash), api.getSave(), api.getState().catch(() => null),
    ]);
    game.set({ progress: 'Nạp dữ liệu save…' });
    const { usedLocalSave } = await emu.boot(rom, cloud, userId, localSavedAt());
    emu.setVolume(game.get().volume);
    emu.setFastForward(game.get().speed);
    emu.onSaveChanged(onSaveChanged);
    game.set({ progress: 'Khôi phục tiến trình…' });
    await restoreLatestCheckpoint(cloudCheckpoint);
    if (cloud && !usedLocalSave) lastUploadedHash = hash(cloud.data);
    game.set({ phase: 'running', progress: '', save: cloud ? 'synced' : 'none', paused: false });
    if (usedLocalSave) toast('Đã dùng bản save mới hơn lưu trên trình duyệt này và tải lên máy chủ.');
    window.setInterval(tick, 250);
    // Every player's save is pushed to the server every 5 s whenever it changed.
    window.setInterval(() => void autosave(), SAVE_SYNC_MS);
    void uploadSave();
    window.addEventListener('beforeunload', flushSave);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  } catch (e) {
    console.error(e);
    game.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

async function tick() {
  if (!emu || !sym) return;
  // Keep the speed chosen in Settings (the core can reset it, e.g. after loading a state).
  if (emu.fastForward !== game.get().speed) emu.setFastForward(game.get().speed);
  if (game.get().paused) return;
  const data = await emu.read(sym);
  if (!data) {
    failedReads++;
    if (failedReads > 40 && game.get().ram !== 'unavailable') game.set({ ram: 'unavailable' });
    return;
  }
  failedReads = 0;
  if (game.get().ram !== 'ok') game.set({ ram: 'ok' });
  const { pos, party } = data;
  if (pos) {
    const key = `${pos.group}.${pos.num}.${pos.x}.${pos.y}.${pos.mapsec}.${pos.facing}.${pos.gfx}.${pos.elev}`;
    if (key !== lastPosKey) {
      lastPosKey = key;
      game.set({ pos });
      send({ t: 'pos', ...pos });
    }
  }
  updateGhosts(pos);
  const pkey = `${party.count}:${hash(party.data.subarray(0, party.count * 100))}`;
  const now = Date.now();
  if (party.count && pkey !== lastPartyKey && now - lastPartySent > 1500) {
    lastPartyKey = pkey;
    lastPartySent = now;
    send({ t: 'party', count: party.count, data: toBase64(party.data.subarray(0, party.count * 100)) });
  }
}

/** Copies friends standing on our map into the ROM so it draws them walking around. */
function updateGhosts(myPos: PlayerPosition | null) {
  if (!emu || !sym?.onlinePlayers) return;
  const { players, me } = session.get();
  const here = myPos ?? game.get().pos;
  const friends = here ? players.filter(p => p.id !== me?.id && p.online && !p.inBattle && p.pos
    && p.pos.group === here.group && p.pos.num === here.num && typeof p.pos.gfx === 'number') : [];
  const ids = new Set(friends.map(f => f.id));
  for (const id of [...ghostSlots.keys()]) if (!ids.has(id)) ghostSlots.delete(id);
  const slots: (Ghost | null)[] = Array(ONLINE_SLOTS).fill(null);
  for (const f of friends) {
    let slot = ghostSlots.get(f.id);
    if (slot === undefined) {
      const used = new Set(ghostSlots.values());
      slot = [...Array(ONLINE_SLOTS).keys()].find(i => !used.has(i));
      if (slot === undefined) continue;
      ghostSlots.set(f.id, slot);
    }
    const p = f.pos!;
    slots[slot] = { group: p.group, num: p.num, x: p.x, y: p.y, facing: p.facing ?? 1, elev: p.elev ?? 3, gfx: p.gfx! };
  }
  emu.writeGhosts(sym, slots);
}

/** Re-send position and party after a reconnect. */
export function resendState() {
  lastPosKey = '';
  lastPartyKey = '';
  lastPartySent = 0;
}

/** The game wrote its save (player saved in-game): keep a local copy right away. */
function onSaveChanged() {
  game.set({ save: 'pending' });
  markLocalSave();
  void emu?.persistLocal();
}

let errorShown = false;
async function uploadSave() {
  if (!emu || uploading) return;
  const data = emu.getSave();
  if (!data || !data.length) return;
  const h = hash(data);
  if (h === lastUploadedHash) return;
  uploading = true;
  game.set({ save: 'saving' });
  try {
    const { savedAt } = await api.putSave(data);
    lastUploadedHash = h;
    errorShown = false;
    game.set({ save: 'synced', savedAt });
    void emu.persistLocal();
  } catch (e) {
    game.set({ save: 'error' });
    if (!errorShown) toast(`Không lưu được lên máy chủ: ${e instanceof Error ? e.message : e}`, 'error');
    errorShown = true; // retried automatically every 5 s
  } finally {
    uploading = false;
  }
}

// ------------------------------------------------------------------ checkpoints
let lastCheckpointHash = -1;
let checkpointing = false;
const localCheckpointPath = () => `/data/states/checkpoint-${userId}.hls`;
const localCheckpointKey = () => `hl-ckpt-at-${userId}`;

function localCheckpoint(): { data: Uint8Array; savedAt: number } | null {
  if (!emu) return null;
  try {
    const fs = emu.core.FS;
    if (!fs.analyzePath(localCheckpointPath()).exists) return null;
    return { data: fs.readFile(localCheckpointPath()) as Uint8Array, savedAt: Number(localStorage.getItem(localCheckpointKey())) || 0 };
  } catch { return null; }
}

/** After F5 or a new visit: continue from the newest checkpoint (this browser's or the server's). */
async function restoreLatestCheckpoint(cloud: { data: Uint8Array; savedAt: number } | null) {
  if (!emu || !meta) return;
  const candidates = [localCheckpoint(), cloud].filter(Boolean) as { data: Uint8Array; savedAt: number }[];
  candidates.sort((a, b) => b.savedAt - a.savedAt);
  await new Promise(r => setTimeout(r, 400)); // let the core finish booting the ROM
  for (const c of candidates) {
    const state = await decodeCheckpoint(c.data, meta.romHash ?? '');
    if (!state) continue;
    if (emu.restoreCheckpoint(state)) {
      emu.setFastForward(game.get().speed);
      lastCheckpointHash = hash(c.data);
      game.set({ checkpointAt: c.savedAt });
      const at = c.savedAt ? new Date(c.savedAt * 1000).toLocaleTimeString('vi-VN') : '';
      toast(at ? `Đã khôi phục tiến trình lúc ${at}.` : 'Đã khôi phục tiến trình lần trước.', 'success');
      return;
    }
  }
}

async function captureCheckpoint(): Promise<Uint8Array | null> {
  if (!emu || !meta || game.get().phase !== 'running') return null;
  const state = emu.captureCheckpoint();
  return state ? encodeCheckpoint(state, meta.romHash ?? '') : null;
}

/** Runs every 5 s: pushes the in-game save and a checkpoint of exactly where the player is. */
async function autosave() {
  void uploadSave();
  if (checkpointing || !emu || game.get().paused || session.get().battle) return;
  checkpointing = true;
  try {
    const file = await captureCheckpoint();
    if (!file) return;
    const h = hash(file);
    if (h === lastCheckpointHash) return;
    const now = Math.floor(Date.now() / 1000);
    try {
      emu.core.FS.writeFile(localCheckpointPath(), file);
      localStorage.setItem(localCheckpointKey(), String(now));
      void emu.persistLocal();
    } catch { /* storage full or blocked: the server copy still works */ }
    const { savedAt } = await api.putState(file);
    lastCheckpointHash = h;
    game.set({ checkpointAt: savedAt });
  } catch (e) {
    console.warn('[checkpoint] upload failed', e);
  } finally {
    checkpointing = false;
  }
}

export function setSpeed(speed: number) {
  if (!(SPEEDS as readonly number[]).includes(speed)) return;
  try { localStorage.setItem('hl-speed', String(speed)); } catch { /* storage blocked */ }
  game.set({ speed });
  emu?.setFastForward(speed);
}

function flushSave() {
  if (!emu) return;
  // Tab hidden or closing: store one last checkpoint locally (and on the server if the page lives on).
  void captureCheckpoint().then(file => {
    if (!file) return;
    try {
      emu?.core.FS.writeFile(localCheckpointPath(), file);
      localStorage.setItem(localCheckpointKey(), String(Math.floor(Date.now() / 1000)));
      void emu?.persistLocal();
    } catch { /* ignore */ }
    void fetch('/api/state', { method: 'PUT', body: file as BodyInit, credentials: 'same-origin' }).catch(() => undefined);
  });
  const data = emu.getSave();
  if (data && hash(data) !== lastUploadedHash) {
    // A flash save (128 KB) is over the 64 KB keepalive limit, so this only completes while the page
    // is still alive (tab hidden). On a real close the newer IndexedDB copy wins at the next boot.
    void fetch('/api/save', { method: 'PUT', body: data as BodyInit, credentials: 'same-origin' })
      .then(r => r.ok && game.set({ save: 'synced', savedAt: Math.floor(Date.now() / 1000) }))
      .catch(() => undefined);
  }
}

// ------------------------------------------------------------------ controls
export function togglePause() {
  if (!emu) return;
  if (game.get().paused) emu.resume(); else emu.pause();
  game.set({ paused: !game.get().paused });
}

export function setVolume(volume: number) {
  emu?.setVolume(volume);
  game.set({ volume });
}

/** Keyboard goes to the game only while no popup or text field has focus. */
export function setGameKeyboard(enabled: boolean) {
  emu?.setKeyboard(enabled);
}

/** PvP battles pause the player's own game and resume it afterwards. */
session.subscribe(() => {
  const inBattle = !!session.get().battle;
  if (!emu) return;
  if (inBattle && !game.get().paused) {
    emu.pause();
    pausedForBattle = true;
    game.set({ paused: true });
  } else if (!inBattle && pausedForBattle) {
    emu.resume();
    pausedForBattle = false;
    game.set({ paused: false });
  }
});

let wasConnected = false;
session.subscribe(() => {
  const c = session.get().connected;
  if (c && !wasConnected) resendState();
  wasConnected = c;
});
