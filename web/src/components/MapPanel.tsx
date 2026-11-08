import { game } from '../lib/game';
import { iconUrl } from '../lib/meta';
import { session, type OnlinePlayer } from '../lib/session';
import { useStore } from '../lib/store';
import { placeName, regionPoint, useMeta } from '../lib/useMeta';

const RADAR_RANGE = 12; // tiles from you to the radar edge

/** Hoenn region map with a marker per online player. `compact` is the always-on HUD version. */
export function RegionMap({ compact = false }: { compact?: boolean }) {
  const meta = useMeta();
  const players = useStore(session, s => s.players);
  const me = useStore(session, s => s.me);
  const myPos = useStore(game, s => s.pos);
  const others = players.filter(p => p.id !== me?.id && p.pos && p.online);
  const w = meta?.regionMap.width ?? 248;
  const h = meta?.regionMap.height ?? 152;

  const markers: { p: OnlinePlayer; x: number; y: number; me: boolean }[] = [];
  if (meta) {
    for (const p of others) {
      const pt = regionPoint(meta, p.pos!);
      if (pt) markers.push({ p, ...pt, me: false });
    }
    if (me && myPos) {
      const pt = regionPoint(meta, myPos);
      if (pt) markers.push({ p: { ...me, pos: myPos }, ...pt, me: true });
    }
  }

  return (
    <div className={`minimap ${compact ? 'compact' : ''}`} role="img" aria-label="Bản đồ vùng Hoenn với vị trí người chơi">
      <img src="/game/region_map.png" alt="" width={w} height={h} />
      {markers.map(m => (
        <div key={m.p.id} className={`marker ${m.me ? 'me' : ''}`}
          style={{ left: `${(m.x / w) * 100}%`, top: `${(m.y / h) * 100}%`, background: m.p.color, color: m.p.color, zIndex: m.me ? 3 : 2 }}
          title={`${m.p.name} — ${placeName(meta, m.p.pos)}`}>
          {!m.me && !compact && <span className="marker-label">{m.p.name}</span>}
        </div>
      ))}
    </div>
  );
}

export function MapPanel() {
  const meta = useMeta();
  const players = useStore(session, s => s.players);
  const me = useStore(session, s => s.me);
  const myPos = useStore(game, s => s.pos);
  const party = useStore(session, s => s.party);
  const phase = useStore(game, s => s.phase);
  const others = players.filter(p => p.id !== me?.id && p.pos && p.online);
  const sameMap = myPos ? others.filter(p => p.pos!.group === myPos.group && p.pos!.num === myPos.num) : [];

  return (
    <div className="panel">
      <section className="panel-section" aria-labelledby="map-title">
        <div className="here">
          <div>
            <h3 id="map-title">Bạn đang ở</h3>
            <strong>{phase === 'running' ? placeName(meta, myPos) : 'Chưa vào game'}</strong>
          </div>
          {myPos && <span className="mono muted">X {myPos.x} · Y {myPos.y}</span>}
        </div>
        <RegionMap />
      </section>

      <section className="panel-section" aria-labelledby="near-title">
        <div className="panel-head">
          <h2 id="near-title">Cùng bản đồ</h2>
          <span className="muted mono">{sameMap.length} người</span>
        </div>
        {myPos && sameMap.length > 0 ? (
          <div className="radar" role="img" aria-label="Vị trí người chơi gần bạn">
            <div className="marker me" style={{ left: '50%', top: '50%', background: me?.color, color: me?.color, zIndex: 3 }} title="Bạn" />
            {sameMap.map(p => {
              const dx = Math.max(-1, Math.min(1, (p.pos!.x - myPos.x) / RADAR_RANGE));
              const dy = Math.max(-1, Math.min(1, (p.pos!.y - myPos.y) / RADAR_RANGE));
              return (
                <div key={p.id} className="marker" title={`${p.name}: cách ${Math.abs(p.pos!.x - myPos.x) + Math.abs(p.pos!.y - myPos.y)} ô`}
                  style={{ left: `${50 + dx * 46}%`, top: `${50 + dy * 46}%`, background: p.color }}>
                  <span className="marker-label">{p.name}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty">Chưa có ai ở cùng bản đồ với bạn.</p>
        )}
      </section>

      <section className="panel-section" aria-labelledby="party-title">
        <div className="panel-head">
          <h2 id="party-title">Đội hình của bạn</h2>
          <span className="muted mono">{party.filter(m => !m.isEgg).length}/6</span>
        </div>
        {party.length ? (
          <div className="party">
            {party.map(m => {
              const pct = m.maxHP ? (m.hp / m.maxHP) * 100 : 0;
              const name = m.isEgg ? 'Trứng' : m.nickname || meta?.species[m.speciesId]?.name || '???';
              return (
                <div className="mon" key={`${m.slot}-${m.speciesId}`}>
                  <img src={iconUrl(m.speciesId)} alt="" width={40} height={40} />
                  <span className="nm">{name}</span>
                  <span className="lv mono">Lv {m.level}</span>
                  {!m.isEgg && (
                    <div className="hpbar" aria-label={`HP ${m.hp}/${m.maxHP}`}>
                      <i className={pct < 20 ? 'low' : pct < 50 ? 'mid' : ''} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty">Đội hình sẽ hiện khi bạn có Pokémon trong game.</p>
        )}
      </section>
    </div>
  );
}
