import { SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { send, session } from '../lib/session';
import { useStore } from '../lib/store';

export function ChatPanel() {
  const chat = useStore(session, s => s.chat);
  const connected = useStore(session, s => s.connected);
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [chat.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    send({ t: 'chat', text });
    setText('');
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={log} aria-live="polite">
        {chat.length === 0 && <p className="empty">Chưa có tin nhắn. Chào cả nhóm một câu đi.</p>}
        {chat.map(m => (
          <div className="msg" key={`${m.at}-${m.from}`}>
            <div className="meta">
              <b style={{ color: m.color }}>{m.name}</b>
              <time dateTime={new Date(m.at).toISOString()}>
                {new Date(m.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
              </time>
            </div>
            <p>{m.text}</p>
          </div>
        ))}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="chat-input" className="sr-only">Tin nhắn</label>
        <input id="chat-input" className="input" value={text} maxLength={300} placeholder="Nhắn cho cả nhóm…"
          onChange={e => setText(e.target.value)} autoComplete="off" />
        <button className="btn primary icon" type="submit" disabled={!connected || !text.trim()} aria-label="Gửi tin nhắn">
          <SendHorizontal />
        </button>
      </form>
    </div>
  );
}
