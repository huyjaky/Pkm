import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { RegionMap } from './MapPanel';

const STORAGE_KEY = 'hl-minimap-width';
const MIN_WIDTH = 120;
const DEFAULT_WIDTH = 200;
const RATIO = 248 / 152; // region_map.png width / height
const KEY_STEP = 24;

const maxWidth = () => Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.7, (window.innerHeight * 0.8) * RATIO));
const clamp = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth(), w)));

function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if (v) return clamp(v);
  } catch { /* storage blocked */ }
  return clamp(Math.min(DEFAULT_WIDTH, window.innerWidth * 0.17));
}

/**
 * The always-on minimap in the top-right corner. Click opens the big map; dragging the
 * bottom-left handle (the map is pinned top-right) resizes it, and the size is remembered.
 */
export function HudMinimap({ onOpen }: { onOpen: () => void }) {
  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; w: number; moved: boolean } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* storage blocked */ }
  }, [width]);

  useEffect(() => {
    const onResize = () => setWidth(w => clamp(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, w: width, moved: false };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Left grows the map; down grows it too (converted through the map's aspect ratio).
    const dx = d.x - e.clientX;
    const dy = (e.clientY - d.y) * RATIO;
    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    if (Math.abs(delta) > 2) d.moved = true;
    setWidth(clamp(d.w + delta));
  };
  const onUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === '+';
    const shrink = e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === '-';
    if (!grow && !shrink) return;
    e.preventDefault();
    e.stopPropagation();
    setWidth(w => clamp(w + (grow ? KEY_STEP : -KEY_STEP)));
  };

  return (
    <div className={`hud-map ${dragging ? 'resizing' : ''}`} style={{ width }}>
      <button className="hud-map-open" onClick={onOpen} aria-label="Mở bản đồ lớn">
        <RegionMap compact />
      </button>
      <div
        className="hud-map-handle"
        role="slider"
        tabIndex={0}
        aria-label="Kéo để đổi kích thước bản đồ"
        title="Kéo để phóng to hoặc thu nhỏ bản đồ (nhấp đúp để về mặc định)"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.round(maxWidth())}
        aria-valuenow={width}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => setWidth(clamp(DEFAULT_WIDTH))}
        onKeyDown={onKey}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 1v10h10M1 6v5h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
