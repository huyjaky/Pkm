import { Play } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { game, getEmulator, startGame } from '../lib/game';
import { useStore } from '../lib/store';
import { TouchPad } from './TouchPad';

/** Enter browser fullscreen; needs a user gesture, so it is called from a click. */
export function enterFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => undefined);
}

/** The game screen, scaled to fill the window (3:2, letterboxed). */
export function GameStage({ userId }: { userId: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useStore(game, s => s.phase);
  const progress = useStore(game, s => s.progress);
  const message = useStore(game, s => s.message);

  // Typing in chat or forms must not move the player.
  useEffect(() => {
    const isField = (el: EventTarget | null) => el instanceof HTMLElement && (el.matches('input, textarea, select') || el.isContentEditable);
    const onIn = (e: FocusEvent) => { if (isField(e.target)) getEmulator()?.setKeyboard(false); };
    const onOut = (e: FocusEvent) => { if (isField(e.target)) getEmulator()?.setKeyboard(true); };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); };
  }, []);

  return (
    <div className="stage">
      <div className="screen">
        <canvas ref={canvas} id="screen" width={240} height={160} aria-label="Màn hình game" tabIndex={0} />
      </div>
      {phase !== 'running' && (
        <div className="screen-overlay">
          <div className="inner">
            {phase === 'idle' && (
              <>
                <h2>Sẵn sàng vào Hoenn</h2>
                <p>Game chạy toàn màn hình ngay trên trình duyệt. Save được tải từ máy chủ và tự đồng bộ mỗi 5 giây.</p>
                <button className="btn primary" onClick={() => {
                  enterFullscreen();
                  if (canvas.current) void startGame(canvas.current, userId);
                }}>
                  <Play aria-hidden="true" /> Bắt đầu chơi
                </button>
              </>
            )}
            {phase === 'loading' && (
              <>
                <div className="spinner" />
                <p>{progress}</p>
              </>
            )}
            {phase === 'error' && (
              <>
                <h2>Không khởi động được game</h2>
                <p>{message}</p>
                <button className="btn" onClick={() => location.reload()}>Tải lại trang</button>
              </>
            )}
          </div>
        </div>
      )}
      {phase === 'running' && <TouchPad />}
    </div>
  );
}
