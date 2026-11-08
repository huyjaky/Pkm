import { Flag, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  hpPercent, needsTarget, parseCondition, parseDetails, targetOptions,
  type BattleMon, type BattleView, type RequestMove, type ShowdownRequest,
} from '../lib/battle';
import { iconUrl, speciesIdFromShowdown, spriteUrl, type Meta } from '../lib/meta';
import { choose, closeBattle, send } from '../lib/session';
import { useMeta } from '../lib/useMeta';

const FORMAT_TEXT = { singles: 'Đấu đơn', doubles: 'Đấu đôi', multi: 'Đấu đội 2v2' } as const;

export function BattleScreen({ battle }: { battle: BattleView }) {
  const meta = useMeta();
  const mine = battle.mySlot;
  const allySlot = ({ p1: 'p3', p3: 'p1', p2: 'p4', p4: 'p2' } as const)[mine];
  const myTeam = mine === 'p1' || mine === 'p3' ? ['p1', 'p3'] : ['p2', 'p4'];

  const positions = Object.values(battle.active).sort((a, b) => a.position.localeCompare(b.position));
  const allies = positions.filter(m => myTeam.includes(m.side));
  const foes = positions.filter(m => !myTeam.includes(m.side));
  const colorOf = (side: string) => battle.colors[side] ?? '#888';
  const ownerOf = (side: string) => battle.players.find(p => p.slot === side)?.name ?? side;

  const opponents = battle.players.filter(p => !myTeam.includes(p.slot)).map(p => p.name).join(' & ');

  return (
    <div className="battle" role="dialog" aria-label={`Trận đấu với ${opponents}`}>
      <div className="battle-body">
        <div className="arena">
          <div className="turn-chip">
            <span className="tag">{FORMAT_TEXT[battle.format]}</span>
            {battle.turn > 0 && <span className="tag mono">Lượt {battle.turn}</span>}
            {battle.format === 'multi' && <span className="tag">Đồng đội: {ownerOf(allySlot)}</span>}
          </div>
          <div className="arena-row foe">
            {foes.map(m => <Combatant key={m.position} mon={m} meta={meta} color={colorOf(m.side)} owner={ownerOf(m.side)} exact={false} />)}
          </div>
          <div className="arena-row ally">
            {allies.map(m => <Combatant key={m.position} mon={m} meta={meta} color={colorOf(m.side)} owner={ownerOf(m.side)} exact={m.side === mine} />)}
          </div>
        </div>
        <BattleLog battle={battle} />
      </div>
      <div className="controls">
        {battle.ended ? <Result battle={battle} /> : <Controls battle={battle} meta={meta} />}
      </div>
    </div>
  );
}

function Combatant({ mon, meta, color, owner, exact }: { mon: BattleMon; meta: Meta | null; color: string; owner: string; exact: boolean }) {
  const pct = hpPercent(mon);
  const id = meta ? speciesIdFromShowdown(meta, mon.species) : null;
  return (
    <div className={`combatant ${mon.fainted ? 'fainted' : ''}`}>
      <div className="nameplate">
        <div className="top">
          <b>{mon.name}</b>
          <span className="mono muted">Lv{mon.level}</span>
        </div>
        <div className="owner">
          <span className="dot" style={{ background: color }} aria-hidden="true" />{owner}
          {mon.status && <span className={`status-tag ${mon.status}`}>{mon.status}</span>}
          {mon.tera && <span className="status-tag">Tera {mon.tera}</span>}
        </div>
        <div className="hpbar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`HP ${mon.name}`}>
          <i className={pct < 20 ? 'low' : pct < 50 ? 'mid' : ''} style={{ width: `${pct}%` }} />
        </div>
        <span className="hpnum">{exact ? `${mon.hp}/${mon.maxhp}` : `${Math.round(pct)}%`}</span>
      </div>
      {id ? <img src={spriteUrl(id)} alt={mon.species} width={128} height={128} /> : null}
    </div>
  );
}

function BattleLog({ battle }: { battle: BattleView }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [battle.log.length]);
  return (
    <div className="battle-log" ref={ref} aria-live="polite" aria-label="Diễn biến trận đấu">
      {battle.log.length === 0 && <p className="muted">Trận đấu sắp bắt đầu…</p>}
      {battle.log.map((e, i) => <div key={i} className={e.kind}>{e.text}</div>)}
    </div>
  );
}

function Result({ battle }: { battle: BattleView }) {
  const won = battle.won;
  return (
    <div className={`result ${won ? 'win' : ''}`}>
      <h2>{battle.aborted ? 'Trận đấu đã huỷ' : won ? 'Chiến thắng!' : won === false ? 'Thất bại' : 'Kết thúc'}</h2>
      <p className="muted">{battle.aborted ?? (battle.winner ? `${battle.winner} thắng sau ${battle.turn} lượt.` : 'Trận đấu đã kết thúc.')}</p>
      <button className="btn primary" onClick={closeBattle}><X /> Quay lại game</button>
    </div>
  );
}

// ------------------------------------------------------------------ choice building
type Pending = { parts: string[]; moveIndex: number | null; tera: boolean };

function Controls({ battle, meta }: { battle: BattleView; meta: Meta | null }) {
  const req = battle.request;
  const [pending, setPending] = useState<Pending>({ parts: [], moveIndex: null, tera: false });
  useEffect(() => {
    // During a forced switch, slots that are not forced answer "pass" automatically.
    const parts: string[] = [];
    if (req?.forceSwitch) while (parts.length < req.forceSwitch.length && !req.forceSwitch[parts.length]) parts.push('pass');
    if (req?.forceSwitch && parts.length >= req.forceSwitch.length) return;
    setPending({ parts, moveIndex: null, tera: false });
  }, [req]);

  const forfeit = () => {
    if (confirm('Đầu hàng trận này?')) send({ t: 'forfeit', battle: battle.id });
  };
  const head = (title: string) => (
    <div className="controls-head">
      <h2>{title}</h2>
      <button className="btn sm ghost danger" onClick={forfeit}><Flag /> Đầu hàng</button>
    </div>
  );

  if (!req) {
    return (
      <>
        {head(battle.waiting ? 'Đang chờ đối thủ…' : 'Đang chuẩn bị…')}
        {battle.error && <p className="battle-error">{battle.error}</p>}
      </>
    );
  }

  const team = req.side.pokemon;
  const submit = (parts: string[]) => choose(parts.join(', '));

  if (req.teamPreview) {
    return (
      <>
        {head('Chọn Pokémon ra sân đầu tiên')}
        <SwitchGrid team={team} meta={meta} filter={() => true} onPick={i => choose(`team ${i}`)} />
      </>
    );
  }

  // Which active slots need a decision this request
  const slots: { index: number; kind: 'switch' | 'move' }[] = [];
  if (req.forceSwitch) {
    req.forceSwitch.forEach((f, i) => slots.push({ index: i, kind: f ? 'switch' : 'move' }));
  } else if (req.active) {
    req.active.forEach((_, i) => slots.push({ index: i, kind: 'move' }));
  }
  const step = pending.parts.length;
  const current = slots[step];

  const advance = (part: string) => {
    const parts = [...pending.parts, part];
    // Auto-pass slots that need nothing (e.g. a non-forced slot during a forced switch).
    while (parts.length < slots.length && req.forceSwitch && !req.forceSwitch[parts.length]) parts.push('pass');
    if (parts.length >= slots.length) submit(parts);
    else setPending({ parts, moveIndex: null, tera: false });
  };

  if (!current || (req.forceSwitch && current.kind === 'move')) return head('Đang chờ…');

  const chosenSwitches = pending.parts.filter(p => p.startsWith('switch')).map(p => Number(p.split(' ')[1]));
  const canSwitch = (i: number) => {
    const mon = team[i - 1];
    return !mon.active && !parseCondition(mon.condition).fainted && !chosenSwitches.includes(i);
  };
  const activeMon = team.filter(m => m.active)[current.index];
  const who = activeMon ? activeMon.ident.split(': ')[1] : '';

  if (current.kind === 'switch') {
    return (
      <>
        {head('Chọn Pokémon thay thế')}
        <SwitchGrid team={team} meta={meta} filter={canSwitch} onPick={i => advance(`switch ${i}`)} />
      </>
    );
  }

  const active = req.active![current.index];
  if (pending.moveIndex !== null) {
    const move = active.moves[pending.moveIndex];
    const opts = targetOptions(battle, move.target, current.index);
    return (
      <>
        {head(`${move.move}: chọn mục tiêu`)}
        <div className="moves">
          {opts.map(o => (
            <button key={o.n} className="move-btn" onClick={() => advance(`move ${pending.moveIndex! + 1} ${o.n}${pending.tera ? ' terastallize' : ''}`)}>
              <b>{o.label}</b><span>{o.ally ? 'Đồng minh' : 'Đối thủ'}</span>
            </button>
          ))}
          <button className="move-btn" onClick={() => setPending({ ...pending, moveIndex: null })}><b>Quay lại</b><span>Chọn chiêu khác</span></button>
        </div>
      </>
    );
  }

  const pickMove = (i: number, m: RequestMove) => {
    if (needsTarget(battle.format, m.target)) setPending({ ...pending, moveIndex: i });
    else advance(`move ${i + 1}${pending.tera ? ' terastallize' : ''}`);
  };

  return (
    <>
      {head(slots.length > 1 ? `${who} sẽ làm gì? (${step + 1}/${slots.length})` : `${who} sẽ làm gì?`)}
      {battle.error && <p className="battle-error">{battle.error}</p>}
      <div className="moves">
        {active.moves.map((m, i) => (
          <button key={m.id} className="move-btn" disabled={!!m.disabled || m.pp === 0} onClick={() => pickMove(i, m)}>
            <b>{m.move}</b>
            <span>PP {m.pp}/{m.maxpp}</span>
          </button>
        ))}
      </div>
      {active.canTerastallize && (
        <label className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={pending.tera} onChange={e => setPending({ ...pending, tera: e.target.checked })} style={{ accentColor: 'var(--accent)' }} />
          Terastal hoá ({active.canTerastallize})
        </label>
      )}
      {!active.trapped && (
        <SwitchGrid team={team} meta={meta} filter={canSwitch} onPick={i => advance(`switch ${i}`)} compact />
      )}
    </>
  );
}

function SwitchGrid({ team, meta, filter, onPick, compact }: {
  team: ShowdownRequest['side']['pokemon']; meta: Meta | null; filter: (i: number) => boolean; onPick: (i: number) => void; compact?: boolean;
}) {
  const rows = useMemo(() => team.map((m, idx) => {
    const d = parseDetails(m.details);
    const c = parseCondition(m.condition);
    return { i: idx + 1, name: m.ident.split(': ')[1], species: d.species, level: d.level, ...c, active: m.active };
  }), [team]);
  return (
    <div className="switches" aria-label={compact ? 'Đổi Pokémon' : 'Chọn Pokémon'}>
      {rows.map(r => {
        const id = meta ? speciesIdFromShowdown(meta, r.species) : null;
        return (
          <button key={r.i} className="switch-btn" disabled={!filter(r.i)} onClick={() => onPick(r.i)}
            title={`${r.name} Lv${r.level} — ${r.fainted ? 'đã gục' : `${r.hp}/${r.maxhp} HP`}`}>
            {id ? <img src={iconUrl(id)} alt="" width={32} height={32} /> : null}
            <span>{r.name}</span>
          </button>
        );
      })}
    </div>
  );
}
