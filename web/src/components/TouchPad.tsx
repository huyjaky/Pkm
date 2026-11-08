import type { PointerEvent } from 'react';
import type { GbaButton } from '../emulator/emulator';
import { getEmulator } from '../lib/game';

function Key({ button, className, label }: { button: GbaButton; className: string; label: string }) {
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('on');
    getEmulator()?.press(button);
    navigator.vibrate?.(8);
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.remove('on');
    getEmulator()?.release(button);
  };
  return (
    <button type="button" className={className} aria-label={label}
      onPointerDown={down} onPointerUp={up} onPointerCancel={up} onContextMenu={e => e.preventDefault()}>
      {label.length <= 2 ? label : ''}
    </button>
  );
}

/** On-screen controls, shown only on touch devices (see .touchpad media query). */
export function TouchPad() {
  return (
    <div className="touchpad">
      <div className="dpad">
        <Key button="up" className="up" label="Lên" />
        <Key button="left" className="left" label="Trái" />
        <Key button="right" className="right" label="Phải" />
        <Key button="down" className="down" label="Xuống" />
      </div>
      <div className="sys">
        <Key button="l" className="pill-btn" label="L" />
        <Key button="select" className="pill-btn" label="Select" />
        <Key button="start" className="pill-btn" label="Start" />
        <Key button="r" className="pill-btn" label="R" />
      </div>
      <div className="ab">
        <Key button="b" className="abtn b" label="B" />
        <Key button="a" className="abtn" label="A" />
      </div>
    </div>
  );
}
