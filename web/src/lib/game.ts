import { Emulator } from '../emulator/emulator';
import type { GameSymbols, PlayerPosition } from '../emulator/ram';
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
  speed: 1 | 2 | 4;
};

export const game = createStore<GameState>({
  phase: 'idle', message: '', progress: '', save: 'none', savedAt: null, ram: 'waiting', pos: null,
  paused: false, volume: 0.8, speed: 1,
});

let emu: Emulator | null = null;
let meta: Meta | null = null;
let sym: GameSymbols | null = null;
let saveTimer: number | undefined;
let lastPosKey = '';
let lastPartyKey = '';
let lastPartySent = 0;
let failedReads = 0;
let pausedForBattle = false;

export const getEmulator = () => emu;

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

export async function startGame(canvas: HTMLCanvasElement) {
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
    };
    emu = await Emulator.create(canvas);
    game.set({ progress: 'Tải ROM…' });
    const [rom, cloud] = await Promise.all([api.rom(), api.getSave()]);
    game.set({ progress: 'Nạp dữ liệu save…' });
    const { usedLocalSave } = await emu.boot(rom, cloud);
    emu.setVolume(game.get().volume);
    emu.onSaveChanged(scheduleUpload);
    game.set({ phase: 'running', progress: '', save: cloud ? 'synced' : 'none', paused: false });
    if (usedLocalSave) {
      toast('Đã dùng bản save lưu trên trình duyệt này và tải lên máy chủ.');
      scheduleUpload();
    }
    window.setInterval(tick, 250);
    window.addEventListener('beforeunload', flushSave);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
  } catch (e) {
    console.error(e);
    game.set({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

async function tick() {
  if (!emu || !sym || game.get().paused) return;
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
    const key = `${pos.group}.${pos.num}.${pos.x}.${pos.y}.${pos.mapsec}`;
    if (key !== lastPosKey) {
      lastPosKey = key;
      game.set({ pos });
      send({ t: 'pos', ...pos });
    }
  }
  const pkey = `${party.count}:${hash(party.data.subarray(0, party.count * 100))}`;
  const now = Date.now();
  if (party.count && pkey !== lastPartyKey && now - lastPartySent > 1500) {
    lastPartyKey = pkey;
    lastPartySent = now;
    send({ t: 'party', count: party.count, data: toBase64(party.data.subarray(0, party.count * 100)) });
  }
}

/** Re-send position and party after a reconnect. */
export function resendState() {
  lastPosKey = '';
  lastPartyKey = '';
  lastPartySent = 0;
}

function scheduleUpload() {
  game.set({ save: 'pending' });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(uploadSave, 1500);
}

async function uploadSave() {
  if (!emu) return;
  const data = emu.getSave();
  if (!data || !data.length) return;
  game.set({ save: 'saving' });
  try {
    const { savedAt } = await api.putSave(data);
    game.set({ save: 'synced', savedAt });
    void emu.persistLocal();
  } catch (e) {
    game.set({ save: 'error' });
    toast(`Không lưu được lên máy chủ: ${e instanceof Error ? e.message : e}`, 'error');
  }
}

function flushSave() {
  if (game.get().save !== 'pending' || !emu) return;
  const data = emu.getSave();
  if (data) {
    // keepalive lets the request finish while the tab closes
    void fetch('/api/save', { method: 'PUT', body: data as BodyInit, keepalive: data.length < 60000, credentials: 'same-origin' });
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

export function cycleSpeed() {
  const next = ({ 1: 2, 2: 4, 4: 1 } as const)[game.get().speed];
  emu?.setFastForward(next);
  game.set({ speed: next });
}

export function saveNow() {
  window.clearTimeout(saveTimer);
  void uploadSave();
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
