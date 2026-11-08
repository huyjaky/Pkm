import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from '../lib/api';
import { Brand } from './Brand';

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteRequired, setInviteRequired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config().then(c => setInviteRequired(c.inviteRequired)).catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = mode === 'login'
        ? await api.login(username.trim(), password)
        : await api.register(username.trim(), password, invite.trim() || undefined);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const isRegister = mode === 'register';

  return (
    <div className="login">
      <div className="login-art">
        <img className="map" src="/game/region_map.png" alt="" aria-hidden="true" />
        <Brand />
        <div>
          <h1>Phiêu lưu Hoenn cùng cả nhóm</h1>
          <p>
            Mỗi người chơi bản Emerald Expansion của riêng mình ngay trên trình duyệt, thấy nhau trên bản đồ,
            trò chuyện và đấu PVP bằng chính đội hình trong game.
          </p>
          <div className="login-facts">
            <div><strong>1v1 · 2v2</strong><span>Đấu đơn, đấu đôi, đấu đội</span></div>
            <div><strong>Lưu tự động</strong><span>Save đồng bộ lên máy chủ</span></div>
            <div><strong>Không ràng buộc</strong><span>Theo cốt truyện hoặc đi tự do</span></div>
          </div>
        </div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <h2>{isRegister ? 'Tạo tài khoản' : 'Đăng nhập'}</h2>
          <form onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="username">Tên người chơi</label>
              <input id="username" className="input" autoComplete="username" value={username}
                onChange={e => setUsername(e.target.value)} placeholder="vd: may_hoenn" required />
            </div>
            <div className="field">
              <label htmlFor="password">Mật khẩu</label>
              <input id="password" className="input" type="password" value={password}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                onChange={e => setPassword(e.target.value)} required />
            </div>
            {isRegister && inviteRequired && (
              <div className="field">
                <label htmlFor="invite">Mã mời</label>
                <input id="invite" className="input" value={invite} onChange={e => setInvite(e.target.value)} required />
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn primary" type="submit" disabled={busy || !username || !password}>
              {busy ? 'Đang xử lý…' : isRegister ? 'Tạo tài khoản và vào game' : 'Vào game'}
            </button>
          </form>
          <p className="login-switch">
            {isRegister ? 'Đã có tài khoản?' : 'Lần đầu ghé Hoenn?'}
            <button type="button" onClick={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }}>
              {isRegister ? 'Đăng nhập' : 'Tạo tài khoản'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
