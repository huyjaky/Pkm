/**
 * Turns Pokemon Showdown protocol lines into a small view model for the battle screen.
 * Only the messages the UI shows are handled; the rest are ignored.
 */
export type Slot = 'p1' | 'p2' | 'p3' | 'p4';

export type BattleMon = {
  position: string; // p1a, p2b ...
  side: Slot;
  name: string;
  species: string;
  level: number;
  shiny: boolean;
  hp: number; // current (exact for own side, % for others)
  maxhp: number;
  status: string;
  fainted: boolean;
  tera?: string;
  boosts: Record<string, number>;
};

export type LogKind = 'turn' | 'move' | 'damage' | 'heal' | 'faint' | 'switch' | 'info' | 'win' | 'effect';
export type LogEntry = { kind: LogKind; text: string };

export type BattlePlayer = { slot: Slot; userId: number; name: string };

export type BattleView = {
  id: string;
  format: 'singles' | 'doubles' | 'multi';
  level: number;
  mySlot: Slot;
  players: BattlePlayer[];
  colors: Record<string, string>;
  active: Record<string, BattleMon>;
  turn: number;
  weather: string;
  log: LogEntry[];
  request: ShowdownRequest | null;
  waiting: boolean;
  error: string;
  ended: boolean;
  won: boolean | null;
  winner: string;
  aborted?: string;
  /** Epoch ms by which the current request must be answered, or the player loses (AFK). */
  deadline: number | null;
  afk?: string | null;
};

export type RequestMove = { move: string; id: string; pp: number; maxpp: number; target: string; disabled?: boolean };
export type RequestMon = {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  moves: string[];
  item: string;
  ability?: string;
  baseAbility?: string;
  teraType?: string;
  terastallized?: string;
  stats: Record<string, number>;
};
export type ShowdownRequest = {
  rqid?: number;
  teamPreview?: boolean;
  wait?: boolean;
  forceSwitch?: boolean[];
  active?: { moves: RequestMove[]; trapped?: boolean; canTerastallize?: string; canMegaEvo?: boolean }[];
  side: { name: string; id: Slot; pokemon: RequestMon[] };
  maxChosenTeamSize?: number;
};

const STATUS_VI: Record<string, string> = {
  brn: 'bỏng', par: 'tê liệt', slp: 'ngủ', frz: 'đóng băng', psn: 'trúng độc', tox: 'trúng kịch độc',
};
const STAT_VI: Record<string, string> = {
  atk: 'Tấn công', def: 'Phòng thủ', spa: 'Tấn công ĐB', spd: 'Phòng thủ ĐB', spe: 'Tốc độ',
  accuracy: 'Độ chính xác', evasion: 'Né tránh',
};
const WEATHER_VI: Record<string, string> = {
  RainDance: 'Trời mưa', SunnyDay: 'Nắng gắt', Sandstorm: 'Bão cát', Hail: 'Mưa đá', Snowscape: 'Tuyết rơi',
  Snow: 'Tuyết rơi', DesolateLand: 'Nắng cực hạn', PrimordialSea: 'Mưa cực hạn', DeltaStream: 'Gió xoáy',
};

export function parseDetails(details: string) {
  const parts = details.split(', ');
  let level = 100;
  let shiny = false;
  for (const p of parts.slice(1)) {
    if (/^L\d+$/.test(p)) level = Number(p.slice(1));
    if (p === 'shiny') shiny = true;
  }
  return { species: parts[0], level, shiny };
}

export function parseCondition(cond: string) {
  const [hpPart, status = ''] = cond.split(' ');
  if (hpPart === '0' || status === 'fnt') return { hp: 0, maxhp: 100, status: '', fainted: true };
  const [cur, max] = hpPart.split('/').map(Number);
  return { hp: cur || 0, maxhp: max || 100, status, fainted: false };
}

export const hpPercent = (m: Pick<BattleMon, 'hp' | 'maxhp'>) => (m.maxhp ? Math.max(0, Math.min(100, (m.hp / m.maxhp) * 100)) : 0);

/** "p2a: Pikachu" -> { position: "p2a", side: "p2", name: "Pikachu" } */
function ident(id: string) {
  const [pos, ...rest] = id.split(': ');
  return { position: pos.slice(0, 3), side: pos.slice(0, 2) as Slot, name: rest.join(': ') };
}

export function newBattle(info: Pick<BattleView, 'id' | 'format' | 'level' | 'mySlot' | 'players' | 'colors'>): BattleView {
  return {
    ...info, active: {}, turn: 0, weather: '', log: [], request: null, waiting: false,
    error: '', ended: false, won: null, winner: '', deadline: null,
  };
}

export function applyLines(view: BattleView, lines: string[]): BattleView {
  const v: BattleView = { ...view, active: { ...view.active }, log: view.log.slice() };
  const owner = (side: string) => v.players.find(p => p.slot === side)?.name ?? side;
  const label = (id: string) => {
    const { side, name } = ident(id);
    return side === v.mySlot ? name : `${name} (${owner(side)})`;
  };
  const push = (kind: LogKind, text: string) => v.log.push({ kind, text });

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const [, cmd, ...args] = line.split('|');
    switch (cmd) {
    case 'switch':
    case 'drag':
    case 'replace': {
      const id = ident(args[0]);
      const d = parseDetails(args[1]);
      const c = parseCondition(args[2] ?? '100/100');
      v.active[id.position] = {
        position: id.position, side: id.side, name: id.name, species: d.species, level: d.level, shiny: d.shiny,
        hp: c.hp, maxhp: c.maxhp, status: c.status, fainted: c.fainted, boosts: {},
      };
      if (cmd !== 'replace') push('switch', `${owner(id.side)} tung ra ${id.name}!`);
      break;
    }
    case 'detailschange':
    case '-formechange': {
      const id = ident(args[0]);
      const mon = v.active[id.position];
      if (mon) v.active[id.position] = { ...mon, species: parseDetails(args[1]).species };
      break;
    }
    case '-damage':
    case '-heal':
    case '-sethp': {
      const id = ident(args[0]);
      const mon = v.active[id.position];
      const c = parseCondition(args[1]);
      if (mon) {
        const before = hpPercent(mon);
        const next = { ...mon, hp: c.hp, maxhp: c.fainted ? mon.maxhp : c.maxhp, status: c.fainted ? mon.status : c.status, fainted: c.fainted };
        v.active[id.position] = next;
        const delta = Math.round(Math.abs(hpPercent(next) - before));
        const from = args.find(a => a.startsWith('[from]'))?.slice(7).replace(/^item: |^ability: /, '');
        if (cmd === '-damage') push('damage', `${label(args[0])} mất ${delta}% HP${from ? ` (${from})` : ''}.`);
        else if (cmd === '-heal') push('heal', `${label(args[0])} hồi ${delta}% HP${from ? ` (${from})` : ''}.`);
      }
      break;
    }
    case 'faint': {
      const id = ident(args[0]);
      const mon = v.active[id.position];
      if (mon) v.active[id.position] = { ...mon, hp: 0, fainted: true };
      push('faint', `${label(args[0])} đã gục!`);
      break;
    }
    case 'move':
      push('move', `${label(args[0])} dùng ${args[1]}!`);
      break;
    case 'cant':
      push('info', `${label(args[0])} không thể hành động${STATUS_VI[args[1]] ? ` vì ${STATUS_VI[args[1]]}` : ''}.`);
      break;
    case '-status': {
      const id = ident(args[0]);
      const mon = v.active[id.position];
      if (mon) v.active[id.position] = { ...mon, status: args[1] };
      push('effect', `${label(args[0])} bị ${STATUS_VI[args[1]] ?? args[1]}.`);
      break;
    }
    case '-curestatus': {
      const id = ident(args[0]);
      const mon = v.active[id.position];
      if (mon) v.active[id.position] = { ...mon, status: '' };
      push('effect', `${label(args[0])} hết ${STATUS_VI[args[1]] ?? args[1]}.`);
      break;
    }
    case '-boost':
    case '-unboost': {
      const id = ident(args[0]);
      const n = Number(args[2]) * (cmd === '-boost' ? 1 : -1);
      const mon = v.active[id.position];
      if (mon) v.active[id.position] = { ...mon, boosts: { ...mon.boosts, [args[1]]: (mon.boosts[args[1]] ?? 0) + n } };
      push('effect', `${STAT_VI[args[1]] ?? args[1]} của ${label(args[0])} ${n > 0 ? 'tăng' : 'giảm'}${Math.abs(n) > 1 ? ' mạnh' : ''}.`);
      break;
    }
    case '-supereffective': push('effect', 'Rất hiệu quả!'); break;
    case '-resisted': push('effect', 'Không hiệu quả lắm…'); break;
    case '-immune': push('effect', `${label(args[0])} không bị ảnh hưởng.`); break;
    case '-crit': push('effect', 'Đòn chí mạng!'); break;
    case '-miss': push('effect', `${label(args[0])} đánh trượt.`); break;
    case '-fail': push('effect', 'Nhưng thất bại!'); break;
    case '-terastallize': {
      const id = ident(args[0]);
      const mon = v.active[id.position];
      if (mon) v.active[id.position] = { ...mon, tera: args[1] };
      push('effect', `${label(args[0])} Terastal hoá thành hệ ${args[1]}!`);
      break;
    }
    case '-mega': push('effect', `${label(args[0])} tiến hoá Mega!`); break;
    case '-weather':
      if (args[0] === 'none') {
        v.weather = '';
      } else if (!args.some(a => a === '[upkeep]')) {
        v.weather = args[0];
        push('effect', `${WEATHER_VI[args[0]] ?? args[0]}.`);
      }
      break;
    case 'turn':
      v.turn = Number(args[0]);
      push('turn', `Lượt ${args[0]}`);
      break;
    case 'win':
      push('win', `${args[0]} giành chiến thắng!`);
      v.winner = args[0];
      break;
    case 'tie':
      push('win', 'Trận đấu hoà.');
      break;
    case 'message':
    case '-message':
      push('info', args[0]);
      break;
    case 'error':
      v.error = args[0];
      break;
    default:
      break;
    }
  }
  if (v.log.length > 400) v.log.splice(0, v.log.length - 400);
  return v;
}

// ------------------------------------------------------------------ choices
const TARGETED = new Set(['normal', 'any', 'adjacentFoe', 'adjacentAlly', 'adjacentAllyOrSelf']);
export const needsTarget = (format: BattleView['format'], target: string) => format !== 'singles' && TARGETED.has(target);

/** Positions the UI can offer for a targeted move, as Showdown target numbers. */
export function targetOptions(view: BattleView, target: string, activeIndex: number) {
  const mine = view.mySlot;
  const allySide = mine === 'p1' ? 'p3' : mine === 'p3' ? 'p1' : mine === 'p2' ? 'p4' : 'p2';
  const foeSides = mine === 'p1' || mine === 'p3' ? ['p2', 'p4'] : ['p1', 'p3'];
  const opts: { n: number; label: string; ally: boolean }[] = [];
  const findMon = (pos: string) => view.active[pos];

  if (view.format === 'multi') {
    // Field is doubles; each player owns one position (a). Foes are 1 and 2, allies -1 and -2.
    if (target !== 'adjacentAlly' && target !== 'adjacentAllyOrSelf') {
      foeSides.forEach((s, i) => { const m = findMon(`${s}a`); if (m && !m.fainted) opts.push({ n: i + 1, label: m.name, ally: false }); });
    }
    if (target !== 'adjacentFoe') {
      const sides = mine === 'p1' || mine === 'p2' ? [mine, allySide] : [allySide, mine];
      sides.forEach((s, i) => {
        const m = findMon(`${s}a`);
        const self = s === mine;
        if (m && !m.fainted && (!self || target === 'adjacentAllyOrSelf')) opts.push({ n: -(i + 1), label: self ? `${m.name} (bản thân)` : m.name, ally: true });
      });
    }
    return opts;
  }
  // doubles: foe positions a=1, b=2; own a=-1, b=-2
  const foe = mine === 'p1' ? 'p2' : 'p1';
  if (target !== 'adjacentAlly' && target !== 'adjacentAllyOrSelf') {
    ['a', 'b'].forEach((l, i) => { const m = findMon(`${foe}${l}`); if (m && !m.fainted) opts.push({ n: i + 1, label: m.name, ally: false }); });
  }
  if (target !== 'adjacentFoe') {
    ['a', 'b'].forEach((l, i) => {
      const m = findMon(`${mine}${l}`);
      const self = i === activeIndex;
      if (m && !m.fainted && (!self || target === 'adjacentAllyOrSelf')) opts.push({ n: -(i + 1), label: self ? `${m.name} (bản thân)` : m.name, ally: true });
    });
  }
  return opts;
}
