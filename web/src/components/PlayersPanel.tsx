import { Swords } from 'lucide-react';
import { useState } from 'react';
import { iconUrl } from '../lib/meta';
import { send, session, type OnlinePlayer } from '../lib/session';
import { useStore } from '../lib/store';
import { placeName, useMeta } from '../lib/useMeta';

export function PlayersPanel() {
  const meta = useMeta();
  const players = useStore(session, s => s.players);
  const me = useStore(session, s => s.me);
  const [open, setOpen] = useState<number | null>(null);
  const sorted = [...players].sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : a.name.localeCompare(b.name)));

  return (
    <div className="panel">
      <section className="panel-section" aria-labelledby="players-title">
        <div className="panel-head">
          <h2 id="players-title">Đang trực tuyến</h2>
          <span className="muted mono">{players.filter(p => p.online).length}</span>
        </div>
        {sorted.length <= 1 && <p className="empty">Chỉ có mình bạn. Gửi link trang cho bạn bè để cùng chơi.</p>}
        <div className="players">
          {sorted.map(p => (
            <div className="player" key={p.id}>
              <span className="dot" style={{ background: p.color }} aria-hidden="true" />
              <div className="who">
                <span className="name">
                  {p.name}
                  {p.id === me?.id && <span className="tag">Bạn</span>}
                  {p.inBattle && <span className="tag live">Đang đấu</span>}
                </span>
                <span className="where">{placeName(meta, p.pos)}</span>
              </div>
              {p.id !== me?.id ? (
                <button className="btn sm" disabled={p.inBattle || !p.partySize}
                  title={!p.partySize ? 'Người này chưa có Pokémon' : 'Thách đấu'}
                  onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                  <Swords /> Thách đấu
                </button>
              ) : (
                p.lead ? <img className="lead" src={iconUrl(p.lead)} alt="" width={32} height={32} /> : <span />
              )}
              {open === p.id && <ChallengeForm target={p} onDone={() => setOpen(null)} />}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ChallengeForm({ target, onDone }: { target: OnlinePlayer; onDone: () => void }) {
  const [format, setFormat] = useState<'singles' | 'doubles'>('singles');
  const [level, setLevel] = useState<0 | 50 | 100>(50);
  const [engine, setEngine] = useState<'rom' | 'sim'>('rom');
  return (
    <div className="challenge-form">
      <div className="row">
        <span className="muted">Thể thức</span>
        <div className="seg" role="group" aria-label="Thể thức">
          <button aria-pressed={format === 'singles'} onClick={() => setFormat('singles')}>Đơn</button>
          <button aria-pressed={format === 'doubles'} onClick={() => setFormat('doubles')}>Đôi</button>
        </div>
      </div>
      <div className="row">
        <span className="muted">Kiểu trận</span>
        <div className="seg" role="group" aria-label="Kiểu trận">
          <button aria-pressed={engine === 'rom'} onClick={() => setEngine('rom')}>Trong game</button>
          <button aria-pressed={engine === 'sim'} onClick={() => setEngine('sim')}>Mô phỏng nhanh</button>
        </div>
      </div>
      {engine === 'sim' ? (
        <div className="row">
          <span className="muted">Cấp độ</span>
          <div className="seg" role="group" aria-label="Cấp độ">
            <button aria-pressed={level === 50} onClick={() => setLevel(50)}>Lv 50</button>
            <button aria-pressed={level === 100} onClick={() => setLevel(100)}>Lv 100</button>
            <button aria-pressed={level === 0} onClick={() => setLevel(0)}>Giữ nguyên</button>
          </div>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>Trận link thật của game: đầy đủ hiệu ứng, cấp độ giữ nguyên, đội hình được trả lại sau trận.</p>
      )}
      <div className="row">
        <button className="btn sm ghost" onClick={onDone}>Huỷ</button>
        <button className="btn sm primary" onClick={() => { send({ t: 'challenge', to: target.id, format, level, engine }); onDone(); }}>
          Gửi lời thách đấu tới {target.name}
        </button>
      </div>
    </div>
  );
}
