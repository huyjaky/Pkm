import { applyLines, newBattle, type BattleView, type ShowdownRequest } from './battle';
import { createStore } from './store';

export type Pos = { group: number; num: number; x: number; y: number; mapsec: number; w: number; h: number };
export type OnlinePlayer = {
  id: number; name: string; color: string; online: boolean; pos: Pos | null;
  inBattle: boolean; roomId: string | null; partySize: number; lead: number | null;
};
export type Challenge = { id: string; from: number; to: number; format: 'singles' | 'doubles'; level: number };
export type Room = { id: string; host: number; level: number; name: string; teams: { A: number[]; B: number[] } };
export type BattleSummary = { id: string; format: string; level: number; players: { slot: string; userId: number; name: string }[] };
export type ChatEntry = { from: number; name: string; color: string; text: string; at: number };
export type PartyMon = {
  slot: number; speciesId: number; nickname: string; level: number; heldItemId: number; moveIds: number[];
  abilityNum: number; nature: number; shiny: boolean; hp: number; maxHP: number; isEgg: boolean;
};
export type Toast = { id: number; tone: 'info' | 'error' | 'success'; text: string };

type State = {
  connected: boolean;
  me: OnlinePlayer | null;
  players: OnlinePlayer[];
  challenges: Challenge[];
  rooms: Room[];
  battles: BattleSummary[];
  chat: ChatEntry[];
  unread: number;
  party: PartyMon[];
  battle: BattleView | null;
  toasts: Toast[];
};

export const session = createStore<State>({
  connected: false, me: null, players: [], challenges: [], rooms: [], battles: [], chat: [], unread: 0,
  party: [], battle: null, toasts: [],
});

let ws: WebSocket | null = null;
let retry = 0;
let closedByUser = false;
let toastSeq = 1;
/** Last request we answered, restored if the server rejects the choice. */
let lastRequest: ShowdownRequest | null = null;

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = toastSeq++;
  session.set(s => ({ toasts: [...s.toasts, { id, tone, text }].slice(-4) }));
  setTimeout(() => session.set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), tone === 'error' ? 6000 : 4000);
}

export function send(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function connect() {
  closedByUser = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { retry = 0; session.set({ connected: true }); };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = e => {
    session.set({ connected: false });
    if (closedByUser || e.code === 4401) return;
    if (e.code === 4000) { toast('Tài khoản vừa đăng nhập ở tab khác.', 'error'); return; }
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  };
}

export function disconnect() {
  closedByUser = true;
  ws?.close();
}

const CLOSE_REASON: Record<string, string> = {
  declined: 'Lời thách đấu bị từ chối.', expired: 'Lời thách đấu đã hết hạn.', offline: 'Người chơi đã offline.',
  cancelled: 'Lời thách đấu đã bị huỷ.', unavailable: 'Không thể bắt đầu trận.',
};

function handle(m: any) {
  const s = session.get();
  const b = s.battle && s.battle.id === m.battle ? s.battle : null;
  switch (m.t) {
  case 'hello':
    session.set({ me: m.you, players: m.players, rooms: m.rooms, battles: m.battles, challenges: m.challenges, chat: m.chat, party: m.party ?? [] });
    break;
  case 'presence':
    session.set({ players: m.players, me: m.players.find((p: OnlinePlayer) => p.id === s.me?.id) ?? s.me });
    break;
  case 'chat':
    session.set({ chat: [...s.chat, m].slice(-100), unread: m.from === s.me?.id ? s.unread : s.unread + 1 });
    break;
  case 'party':
    session.set({ party: m.mons });
    break;
  case 'challenge':
    session.set({ challenges: [...s.challenges.filter(c => c.id !== m.challenge.id), m.challenge] });
    break;
  case 'challenge_closed':
    if (m.reason !== 'accepted' && CLOSE_REASON[m.reason]) {
      const ch = s.challenges.find(c => c.id === m.id);
      if (ch && (ch.from === s.me?.id || m.reason === 'expired')) toast(CLOSE_REASON[m.reason]);
    }
    session.set({ challenges: s.challenges.filter(c => c.id !== m.id) });
    break;
  case 'rooms':
    session.set({ rooms: m.rooms });
    break;
  case 'battles':
    session.set({ battles: m.battles });
    break;
  case 'battle_start':
    session.set({ battle: newBattle(m.battle) });
    break;
  case 'battle_resume': {
    const b = applyLines(newBattle(m.battle), m.lines);
    session.set({ battle: { ...b, request: m.request ?? null, waiting: !m.request } });
    break;
  }
  case 'battle_log':
    if (b) session.set({ battle: applyLines(b, m.lines) });
    break;
  case 'battle_request':
    if (b) {
      const req = m.request as ShowdownRequest;
      session.set({ battle: { ...b, request: req.wait ? null : req, waiting: !!req.wait, error: '' } });
    }
    break;
  case 'battle_error':
    if (b) {
      session.set({ battle: { ...b, error: m.message, waiting: false, request: b.request ?? lastRequest } });
    }
    break;
  case 'battle_end':
    if (b) {
      session.set({ battle: { ...b, ended: true, won: m.won ?? null, winner: m.winner, aborted: m.aborted, request: null } });
      if (m.aborted) toast(`Trận đấu bị huỷ: ${m.aborted}`, 'error');
    }
    break;
  case 'error':
    toast(m.message, 'error');
    break;
  default:
    break;
  }
}

export function choose(choice: string) {
  const b = session.get().battle;
  if (!b) return;
  lastRequest = b.request;
  send({ t: 'choose', battle: b.id, choice });
  session.set({ battle: { ...b, request: null, waiting: true, error: '' } });
}

export function closeBattle() {
  const b = session.get().battle;
  if (b) send({ t: 'battle_leave', battle: b.id });
  session.set({ battle: null });
}

// Debug handle for local testing: localStorage.hlDebug = '1'
try {
  if (import.meta.env.DEV || localStorage.getItem('hlDebug') === '1') {
    (window as unknown as Record<string, unknown>).__hl = { send, session };
  }
} catch { /* storage blocked */ }
