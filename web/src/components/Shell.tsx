import {
  CloudCheck, CloudOff, CloudUpload, Gauge, History, LogOut, Map, Maximize, Menu, MessagesSquare, Minimize, Pause, Play,
  Settings, Swords, Users, Volume2, VolumeX, Wifi, WifiOff, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type User } from '../lib/api';
import { game, setGameKeyboard, setSpeed, setVolume, SPEEDS, togglePause } from '../lib/game';
import { send, session } from '../lib/session';
import { useStore } from '../lib/store';
import { BattleScreen, Countdown } from './BattleScreen';
import { ChatPanel } from './ChatPanel';
import { enterFullscreen, GameStage } from './GameStage';
import { HudMinimap } from './HudMinimap';
import { MapPanel } from './MapPanel';
import { PlayersPanel } from './PlayersPanel';
import { PvpPanel } from './PvpPanel';

type Tab = 'map' | 'players' | 'pvp' | 'chat' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof Map }[] = [
  { id: 'map', label: 'Bản đồ', icon: Map },
  { id: 'players', label: 'Người chơi', icon: Users },
  { id: 'pvp', label: 'Đấu', icon: Swords },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'settings', label: 'Cài đặt', icon: Settings },
];

/**
 * Full-screen game. Everything else lives on a thin layer above it: a menu button that opens a
 * popup, an always-visible minimap in the top-right corner, and banners for incoming challenges.
 */
export function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [open, setOpen] = useState<Tab | null>(null);
  const unread = useStore(session, s => s.unread);
  const challenges = useStore(session, s => s.challenges);
  const meId = useStore(session, s => s.me?.id);
  const incoming = challenges.filter(c => c.to === meId);
  const players = useStore(session, s => s.players);
  const battle = useStore(session, s => s.battle);
  const romBattle = useStore(session, s => s.romBattle);
  const connected = useStore(session, s => s.connected);
  const phase = useStore(game, s => s.phase);
  const battleId = battle?.id;

  // A battle takes over the screen: close the menu so nothing hides it.
  useEffect(() => {
    if (battleId) setOpen(null);
  }, [battleId]);

  // Arrow keys belong to the popup while it is open.
  useEffect(() => {
    setGameKeyboard(open === null);
    session.set({ chatOpen: open === 'chat' });
    if (open === 'chat') session.set({ unread: 0 });
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const badge = incoming.length + (open === 'chat' ? 0 : unread);
  const nameOf = (id: number) => players.find(p => p.id === id)?.name ?? `#${id}`;

  return (
    <div className="play">
      <GameStage userId={user.id} />

      <div className="hud" aria-label="Thanh công cụ">
        <button className="hud-btn" onClick={() => setOpen(open ? null : 'map')} aria-haspopup="dialog"
          aria-expanded={open !== null} aria-label="Mở menu" title="Menu (bản đồ, người chơi, đấu, chat)">
          <Menu />
          {!connected && <span className="hud-dot bad" aria-label="Mất kết nối" />}
          {badge > 0 && <span className="badge">{badge}</span>}
        </button>
        {phase === 'running' && (
          <HudMinimap onOpen={() => setOpen('map')} />
        )}
      </div>

      {romBattle?.phase === 'battle' && romBattle.deadline && (
        <div className="banner compact" role="timer">
          <span>Đến lượt bạn chọn</span>
          <Countdown deadline={romBattle.deadline} />
        </div>
      )}

      {romBattle?.phase === 'starting' && !open && (
        <div className="banner" role="status">
          <Swords aria-hidden="true" />
          <span>Sắp đấu với <b>{romBattle.opponents.join(' & ') || 'đối thủ'}</b>: đứng tự do ngoài bản đồ để bắt đầu</span>
        </div>
      )}

      {!open && !battle && !romBattle && incoming.length > 0 && (
        <div className="banner" role="alert">
          <Swords aria-hidden="true" />
          <span><b>{nameOf(incoming[0].from)}</b> thách đấu bạn</span>
          <button className="btn sm ghost" onClick={() => send({ t: 'challenge_reply', id: incoming[0].id, accept: false })}>Từ chối</button>
          <button className="btn sm primary" onClick={() => send({ t: 'challenge_reply', id: incoming[0].id, accept: true })}>Nhận lời</button>
        </div>
      )}

      {open && <Popup tab={open} onTab={setOpen} onClose={() => setOpen(null)} user={user} onLogout={onLogout} unread={unread} incoming={incoming.length} />}
      {battle && <BattleScreen battle={battle} />}
    </div>
  );
}

function Popup({ tab, onTab, onClose, user, onLogout, unread, incoming }: {
  tab: Tab; onTab: (t: Tab) => void; onClose: () => void; user: User; onLogout: () => void; unread: number; incoming: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const badgeFor = (t: Tab) => (t === 'chat' ? unread : t === 'pvp' ? incoming : 0);
  return (
    <div className="popup-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="popup" role="dialog" aria-modal="true" aria-label="Menu" ref={ref} tabIndex={-1}>
        <div className="popup-head">
          <div className="tabs" role="tablist">
            {TABS.map(t => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => onTab(t.id)}>
                <t.icon aria-hidden="true" />
                {t.label}
                {badgeFor(t.id) > 0 && <span className="badge">{badgeFor(t.id)}</span>}
              </button>
            ))}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Đóng menu"><X /></button>
        </div>
        <div className="popup-body" role="tabpanel">
          {tab === 'map' && <MapPanel />}
          {tab === 'players' && <PlayersPanel />}
          {tab === 'pvp' && <PvpPanel />}
          {tab === 'chat' && <ChatPanel />}
          {tab === 'settings' && <SettingsPanel user={user} onLogout={onLogout} />}
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ user, onLogout }: { user: User; onLogout: () => void }) {
  const me = useStore(session, s => s.me);
  const connected = useStore(session, s => s.connected);
  const online = useStore(session, s => s.players.filter(p => p.online).length);
  const volume = useStore(game, s => s.volume);
  const paused = useStore(game, s => s.paused);
  const save = useStore(game, s => s.save);
  const savedAt = useStore(game, s => s.savedAt);
  const speed = useStore(game, s => s.speed);
  const checkpointAt = useStore(game, s => s.checkpointAt);
  const [record, setRecord] = useState({ wins: user.wins, losses: user.losses });
  const [full, setFull] = useState(!!document.fullscreenElement);

  useEffect(() => { api.me().then(u => setRecord({ wins: u.wins, losses: u.losses })).catch(() => undefined); }, []);
  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const time = savedAt ? new Date(savedAt * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const saveInfo = {
    none: { icon: CloudOff, text: 'Chưa có save trên máy chủ (hãy ghi save trong game)' },
    synced: { icon: CloudCheck, text: time ? `Đã đồng bộ lúc ${time}` : 'Save đã đồng bộ' },
    pending: { icon: CloudUpload, text: 'Sẽ đồng bộ trong vài giây' },
    saving: { icon: CloudUpload, text: 'Đang đồng bộ…' },
    error: { icon: CloudOff, text: 'Đồng bộ lỗi, đang thử lại mỗi 5 giây' },
  }[save];

  return (
    <div className="panel">
      <section className="panel-section">
        <div className="user-chip">
          <span className="dot" style={{ background: me?.color ?? user.color }} aria-hidden="true" />
          <b>{user.username}</b>
          <span className="record mono">{record.wins} thắng · {record.losses} thua</span>
        </div>
        <div className="settings-list">
          <div className="setting">
            {connected ? <Wifi aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
            <span>{connected ? `Đã kết nối · ${online} người đang chơi` : 'Mất kết nối, đang thử lại…'}</span>
          </div>
          <div className="setting">
            <saveInfo.icon aria-hidden="true" />
            <span>{saveInfo.text}</span>
          </div>
          <div className="setting">
            <History aria-hidden="true" />
            <span>
              {checkpointAt
                ? `Điểm khôi phục tự động lúc ${new Date(checkpointAt * 1000).toLocaleTimeString('vi-VN')} (F5 sẽ quay lại đây)`
                : 'Điểm khôi phục được tạo tự động mỗi 5 giây'}
            </span>
          </div>
        </div>
      </section>
      <section className="panel-section">
        <h2>Âm thanh và hiển thị</h2>
        <div className="setting">
          <Gauge aria-hidden="true" />
          <span>Tốc độ game</span>
          <div className="seg" role="group" aria-label="Tốc độ game" style={{ marginLeft: 'auto' }}>
            {SPEEDS.map(v => (
              <button key={v} aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v}x</button>
            ))}
          </div>
        </div>
        <div className="setting">
          <button className="btn sm icon ghost" aria-label={volume ? 'Tắt tiếng' : 'Bật tiếng'} onClick={() => setVolume(volume ? 0 : 0.8)}>
            {volume ? <Volume2 /> : <VolumeX />}
          </button>
          <input className="range" type="range" min={0} max={1} step={0.05} value={volume} aria-label="Âm lượng"
            onChange={e => setVolume(Number(e.target.value))} />
        </div>
        <div className="row-actions">
          <button className="btn sm" onClick={togglePause}>{paused ? <Play /> : <Pause />}{paused ? 'Tiếp tục game' : 'Tạm dừng game'}</button>
          <button className="btn sm" onClick={() => (full ? document.exitFullscreen() : enterFullscreen())}>
            {full ? <Minimize /> : <Maximize />}{full ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
          </button>
          <button className="btn sm danger" onClick={onLogout}><LogOut />Đăng xuất</button>
        </div>
      </section>
    </div>
  );
}
