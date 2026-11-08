import { Emulator } from '../emulator/emulator';
import { ONLINE_SLOTS, type GameSymbols, type Ghost, type PlayerPosition } from '../emulator/ram';
import { api } from './api';
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
};

export const game = createStore<GameState>({
  phase: 'idle', message: '', progress: '', save: 'none', savedAt: null, ram: 'waiting', pos: null,
  paused: false, volume: 0.8,
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
    const [rom, cloud] = await Promise.all([api.rom(meta.romHash), api.getSave()]);
    game.set({ progress: 'Nạp dữ liệu save…' });
    const { usedLocalSave } = await emu.boot(rom, cloud, userId, localSavedAt());
    emu.setVolume(game.get().volume);
    emu.setFastForward(1);
    emu.onSaveChanged(onSaveChanged);
    if (cloud && !usedLocalSave) lastUploadedHash = hash(cloud.data);
    game.set({ phase: 'running', progress: '', save: cloud ? 'synced' : 'none', paused: false });
    if (usedLocalSave) toast('Đã dùng bản save mới hơn lưu trên trình duyệt này và tải lên máy chủ.');
    window.setInterval(tick, 250);
    // Every player's save is pushed to the server every 5 s whenever it changed.
    window.setInterval(() => void uploadSave(), SAVE_SYNC_MS);
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
  // The game always runs at normal GBA speed; players cannot fast-forward.
  if (emu.fastForward !== 1) emu.setFastForward(1);
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

function flushSave() {
  if (!emu) return;
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
