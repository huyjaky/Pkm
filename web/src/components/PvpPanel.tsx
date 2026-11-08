import { Crown, Plus, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { send, session, type Challenge, type Room } from '../lib/session';
import { useStore } from '../lib/store';

const levelText = (l: number) => (l ? `Lv ${l}` : 'cấp giữ nguyên');
const formatText = (f: string) => ({ singles: 'Đấu đơn', doubles: 'Đấu đôi', multi: 'Đấu đội 2v2' } as Record<string, string>)[f] ?? f;

export function PvpPanel() {
  const me = useStore(session, s => s.me);
  const challenges = useStore(session, s => s.challenges);
  const rooms = useStore(session, s => s.rooms);
  const battles = useStore(session, s => s.battles);
  const players = useStore(session, s => s.players);
  const nameOf = (id: number) => players.find(p => p.id === id)?.name ?? `#${id}`;
  const colorOf = (id: number) => players.find(p => p.id === id)?.color ?? '#888';

  const incoming = challenges.filter(c => c.to === me?.id);
  const outgoing = challenges.filter(c => c.from === me?.id);
  const myRoom = rooms.find(r => r.id === me?.roomId);

  return (
    <div className="panel">
      {incoming.map(c => <IncomingChallenge key={c.id} c={c} from={nameOf(c.from)} />)}
      {outgoing.map(c => (
        <div className="card" key={c.id}>
          <p>Đang chờ <b>{nameOf(c.to)}</b> nhận lời: {formatText(c.format)}, {levelText(c.level)}.</p>
          <div className="actions">
            <button className="btn sm ghost" onClick={() => send({ t: 'challenge_cancel', id: c.id })}>Huỷ lời mời</button>
          </div>
        </div>
      ))}

      <section className="panel-section" aria-labelledby="rooms-title">
        <div className="panel-head">
          <h2 id="rooms-title">Phòng đấu đội 2v2</h2>
          {!myRoom && (
            <button className="btn sm" onClick={() => send({ t: 'room_create', level: 50 })} disabled={!!me?.inBattle}>
              <Plus /> Tạo phòng
            </button>
          )}
        </div>
        {rooms.length === 0 && <p className="empty">Chưa có phòng nào. Tạo phòng rồi rủ thêm 3 người vào hai đội.</p>}
        {rooms.map(r => (
          <RoomCard key={r.id} room={r} meId={me?.id ?? 0} nameOf={nameOf} colorOf={colorOf} mine={r.id === myRoom?.id} />
        ))}
      </section>

      {battles.length > 0 && (
        <section className="panel-section" aria-labelledby="live-title">
          <h2 id="live-title">Đang diễn ra</h2>
          {battles.map(b => (
            <div className="player" key={b.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <span>{b.players.map(p => p.name).join(b.format === 'multi' ? ' · ' : ' vs ')}</span>
              <span className="tag live">{formatText(b.format)}</span>
            </div>
          ))}
        </section>
      )}

      <Leaderboard />
    </div>
  );
}

function IncomingChallenge({ c, from }: { c: Challenge; from: string }) {
  return (
    <div className="card incoming" role="alert">
      <div>
        <h2>{from} thách đấu bạn</h2>
        <p className="muted">{formatText(c.format)} · {c.engine === 'sim' ? `mô phỏng, ${levelText(c.level)}` : 'trận thật trong game'} · dùng đội hình hiện tại</p>
      </div>
      <div className="actions">
        <button className="btn sm ghost" onClick={() => send({ t: 'challenge_reply', id: c.id, accept: false })}>Từ chối</button>
        <button className="btn sm primary" onClick={() => send({ t: 'challenge_reply', id: c.id, accept: true })}>Nhận lời</button>
      </div>
    </div>
  );
}

function RoomCard({ room, meId, nameOf, colorOf, mine }: {
  room: Room; meId: number; nameOf: (id: number) => string; colorOf: (id: number) => string; mine: boolean;
}) {
  const full = room.teams.A.length === 2 && room.teams.B.length === 2;
  const team = (side: 'A' | 'B', title: string) => (
    <div className="team">
      <h3>{title}<span className="mono">{room.teams[side].length}/2</span></h3>
      {room.teams[side].map(id => (
        <div className="slot" key={id}>
          <span className="dot" style={{ background: colorOf(id) }} aria-hidden="true" />
          {nameOf(id)}
          {id === room.host && <Crown size={13} aria-label="Chủ phòng" style={{ color: 'var(--warn)', marginLeft: 'auto' }} />}
        </div>
      ))}
      {room.teams[side].length < 2 && !room.teams[side].includes(meId) && (
        <button className="slot open" onClick={() => send({ t: 'room_join', id: room.id, team: side })}>
          Vào {title.toLowerCase()}
        </button>
      )}
    </div>
  );
  return (
    <div className="card">
      <div className="panel-head">
        <b>{room.name}</b>
        <span className="tag">{levelText(room.level)}</span>
      </div>
      <div className="teams">
        {team('A', 'Đội Cam')}
        <span className="vs">VS</span>
        {team('B', 'Đội Xanh')}
      </div>
      {mine && (
        <div className="actions">
          <button className="btn sm ghost" onClick={() => send({ t: 'room_leave' })}>Rời phòng</button>
          {room.host === meId && (
            <button className="btn sm primary" disabled={!full} onClick={() => send({ t: 'room_start' })}>
              {full ? 'Bắt đầu trận' : 'Chờ đủ 4 người'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Leaderboard() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.leaderboard>>>([]);
  const battles = useStore(session, s => s.battles.length);
  useEffect(() => {
    api.leaderboard().then(setRows).catch(() => undefined);
  }, [battles]);
  if (!rows.length) return null;
  return (
    <section className="panel-section" aria-labelledby="board-title">
      <div className="panel-head">
        <h2 id="board-title">Bảng xếp hạng</h2>
        <Trophy size={16} aria-hidden="true" style={{ color: 'var(--warn)' }} />
      </div>
      <div className="board">
        {rows.map((r, i) => (
          <div className="board-row" key={r.id}>
            <span className="mono muted">{i + 1}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="dot" style={{ background: r.color }} aria-hidden="true" />{r.username}
            </span>
            <span className="mono">{r.wins}T · {r.losses}B</span>
          </div>
        ))}
      </div>
    </section>
  );
}
