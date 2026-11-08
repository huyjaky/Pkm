import { FastForward, Maximize, Pause, Play, Save, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cycleSpeed, game, getEmulator, saveNow, setVolume, startGame, togglePause } from '../lib/game';
import { useStore } from '../lib/store';
import { TouchPad } from './TouchPad';

export function GameStage({ userId }: { userId: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const phase = useStore(game, s => s.phase);
  const progress = useStore(game, s => s.progress);
  const message = useStore(game, s => s.message);
  const paused = useStore(game, s => s.paused);
  const volume = useStore(game, s => s.volume);
  const speed = useStore(game, s => s.speed);
  const ram = useStore(game, s => s.ram);
  const [lastVolume, setLastVolume] = useState(0.8);

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
    <>
      <div className="screen-wrap">
        <div className="screen" ref={screen}>
          <canvas ref={canvas} id="screen" width={240} height={160} aria-label="Màn hình game" tabIndex={0} />
          {phase !== 'running' && (
            <div className="screen-overlay">
              <div className="inner">
                {phase === 'idle' && (
                  <>
                    <h2>Sẵn sàng vào Hoenn</h2>
                    <p>Game chạy ngay trên trình duyệt của bạn. Save được tải từ máy chủ và tự lưu lại khi bạn ghi trong game.</p>
                    <button className="btn primary" onClick={() => canvas.current && startGame(canvas.current, userId)}>
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
        </div>
      </div>

      {phase === 'running' && (
        <>
          <div className="toolbar">
            <button className="btn sm icon" onClick={togglePause} aria-label={paused ? 'Tiếp tục' : 'Tạm dừng'} title={paused ? 'Tiếp tục' : 'Tạm dừng'}>
              {paused ? <Play /> : <Pause />}
            </button>
            <button className={`btn sm ${speed > 1 ? 'primary' : ''}`} onClick={cycleSpeed} aria-label={`Tốc độ x${speed}`} title="Tăng tốc">
              <FastForward /> <span className="mono">x{speed}</span>
            </button>
            <span className="volume">
              <button className="btn sm icon ghost" aria-label={volume ? 'Tắt tiếng' : 'Bật tiếng'}
                onClick={() => { if (volume) { setLastVolume(volume); setVolume(0); } else setVolume(lastVolume || 0.8); }}>
                {volume ? <Volume2 /> : <VolumeX />}
              </button>
              <input type="range" min={0} max={1} step={0.05} value={volume} aria-label="Âm lượng"
                onChange={e => setVolume(Number(e.target.value))} />
            </span>
            <button className="btn sm" onClick={saveNow} title="Tải save hiện tại lên máy chủ ngay">
              <Save /> Đồng bộ save
            </button>
            <button className="btn sm icon" aria-label="Toàn màn hình" title="Toàn màn hình"
              onClick={() => screen.current?.requestFullscreen?.()}>
              <Maximize />
            </button>
            <div className="spacer" />
            <div className="keys" aria-label="Phím điều khiển">
              <span><kbd>←↑↓→</kbd>Di chuyển</span>
              <span><kbd>X</kbd>A</span>
              <span><kbd>Z</kbd>B</span>
              <span><kbd>A</kbd><kbd>S</kbd>L/R</span>
              <span><kbd>Enter</kbd>Start</span>
              <span><kbd>⌫</kbd>Select</span>
            </div>
          </div>
          {ram === 'unavailable' && (
            <p className="muted" style={{ padding: '0 20px 10px', fontSize: 13 }}>
              Chưa đọc được vị trí từ RAM: bạn vẫn chơi bình thường, nhưng tạm thời chưa hiện trên bản đồ của người khác.
            </p>
          )}
          <TouchPad />
        </>
      )}
    </>
  );
}
