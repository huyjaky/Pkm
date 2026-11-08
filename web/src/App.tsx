import { useEffect, useState } from 'react';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import { Toasts } from './components/Toasts';
import { api, ApiError, type User } from './lib/api';
import { connect, disconnect } from './lib/session';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setUser).catch(e => {
      if (!(e instanceof ApiError) || e.status !== 401) console.error(e);
      setUser(null);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    connect();
    return () => disconnect();
  }, [user?.id]);

  if (user === undefined) {
    return <div className="screen-overlay" role="status"><div className="spinner" aria-label="Đang tải" /></div>;
  }

  return (
    <>
      {user ? (
        <Shell
          user={user}
          onLogout={async () => {
            await api.logout().catch(() => undefined);
            try { sessionStorage.removeItem('hl-playing'); } catch { /* storage blocked */ }
            location.reload();
          }}
        />
      ) : (
        <Login onLogin={setUser} />
      )}
      <Toasts />
    </>
  );
}
