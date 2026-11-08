import { CloudCheck, CloudOff, CloudUpload, LogOut, Map, MessagesSquare, Swords, Users, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type User } from '../lib/api';
import { game } from '../lib/game';
import { session } from '../lib/session';
import { useStore } from '../lib/store';
import { BattleScreen } from './BattleScreen';
import { Brand } from './Brand';
import { ChatPanel } from './ChatPanel';
import { GameStage } from './GameStage';
import { MapPanel } from './MapPanel';
import { PlayersPanel } from './PlayersPanel';
import { PvpPanel } from './PvpPanel';

type Tab = 'map' | 'players' | 'pvp' | 'chat';

export function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('map');
  const connected = useStore(session, s => s.connected);
  const me = useStore(session, s => s.me);
  const unread = useStore(session, s => s.unread);
  const incoming = useStore(session, s => s.challenges.filter(c => c.to === s.me?.id).length);
  const online = useStore(session, s => s.players.filter(p => p.online).length);
  const battle = useStore(session, s => s.battle);
  const [record, setRecord] = useState({ wins: user.wins, losses: user.losses });
  const battleEnded = useStore(session, s => !!s.battle?.ended);

  useEffect(() => {
    if (battleEnded) api.me().then(u => setRecord({ wins: u.wins, losses: u.losses })).catch(() => undefined);
  }, [battleEnded]);

  useEffect(() => {
    if (tab === 'chat') session.set({ unread: 0 });
  }, [tab, unread]);

  useEffect(() => {
    if (incoming) setTab('pvp');
  }, [incoming]);

  const tabs: { id: Tab; label: string; icon: typeof Map; badge?: number }[] = [
    { id: 'map', label: 'Bản đồ', icon: Map },
    { id: 'players', label: 'Người chơi', icon: Users, badge: online > 1 ? online : undefined },
    { id: 'pvp', label: 'Đấu', icon: Swords, badge: incoming || undefined },
    { id: 'chat', label: 'Chat', icon: MessagesSquare, badge: tab !== 'chat' && unread ? unread : undefined },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <span className={`status ${connected ? 'ok' : 'bad'}`} title={connected ? 'Đã kết nối máy chủ' : 'Mất kết nối, đang thử lại'}>
          {connected ? <Wifi /> : <WifiOff />}
          <span className="hide-sm">{connected ? `${online} đang chơi` : 'Đang kết nối lại…'}</span>
        </span>
        <SaveStatus />
        <div className="spacer" />
        <div className="user-chip">
          <span className="dot" style={{ background: me?.color ?? user.color }} aria-hidden="true" />
          <span>{user.username}</span>
          <span className="record mono hide-sm">{record.wins}T · {record.losses}B</span>
        </div>
        <button className="btn ghost icon" onClick={onLogout} aria-label="Đăng xuất" title="Đăng xuất"><LogOut /></button>
      </header>

      <div className="main">
        <div className="stage">
          <GameStage userId={user.id} />
          {battle && <BattleScreen battle={battle} />}
        </div>
        <aside className="rail" aria-label="Bảng điều khiển">
          <div className="tabs" role="tablist">
            {tabs.map(t => (
              <button key={t.id} role="tab" id={`tab-${t.id}`} aria-controls={`panel-${t.id}`} aria-selected={tab === t.id}
                className="tab" onClick={() => setTab(t.id)}>
                <t.icon aria-hidden="true" />
                {t.label}
                {t.badge ? <span className="badge">{t.badge}</span> : null}
              </button>
            ))}
          </div>
          <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} style={{ minHeight: 0, overflow: 'hidden', display: 'grid' }}>
            {tab === 'map' && <MapPanel />}
            {tab === 'players' && <PlayersPanel />}
            {tab === 'pvp' && <PvpPanel />}
            {tab === 'chat' && <ChatPanel />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SaveStatus() {
  const save = useStore(game, s => s.save);
  const savedAt = useStore(game, s => s.savedAt);
  const phase = useStore(game, s => s.phase);
  if (phase !== 'running') return null;
  const time = savedAt ? new Date(savedAt * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
  const map = {
    none: { cls: 'warn', icon: CloudOff, text: 'Chưa có save trên máy chủ' },
    synced: { cls: 'ok', icon: CloudCheck, text: time ? `Đã lưu lúc ${time}` : 'Save đã đồng bộ' },
    pending: { cls: 'warn', icon: CloudUpload, text: 'Có thay đổi chưa lưu' },
    saving: { cls: 'warn', icon: CloudUpload, text: 'Đang lưu…' },
    error: { cls: 'bad', icon: CloudOff, text: 'Lưu thất bại' },
  }[save];
  return (
    <span className={`status ${map.cls}`} title="Save trong game được tự động tải lên máy chủ">
      <map.icon />
      <span className="hide-sm">{map.text}</span>
    </span>
  );
}
