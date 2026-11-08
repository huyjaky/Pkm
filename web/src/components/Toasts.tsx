import { session } from '../lib/session';
import { useStore } from '../lib/store';

export function Toasts() {
  const toasts = useStore(session, s => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
      ))}
    </div>
  );
}
