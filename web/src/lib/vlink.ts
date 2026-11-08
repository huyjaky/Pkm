/**
 * Relay for the ROM's virtual link cable (rom-patch/src/online_link.c).
 *
 * The ROM writes the link commands it would shift out over the serial port into gVLink.out and reads
 * every player's commands from gVLink.in. This module copies them between the emulator RAM and the
 * server so two (or more) ROMs play a real in-game link battle with all its animations.
 */
import type { GbaMemory } from '../emulator/ram';

const MAGIC = 0x4b4e4c56; // "VLNK"
const QUEUE = 64;
const CMD_BYTES = 16; // CMD_LENGTH (8) u16
const MAX_PLAYERS = 4;

// struct VLinkMailbox offsets
const O = {
  magic: 0x00, active: 0x04, mpId: 0x05, count: 0x06, kind: 0x07, start: 0x08, state: 0x09, outcome: 0x0a,
  linkOpen: 0x0b, outHead: 0x0c, outTail: 0x0e, inHead: 0x10, inTail: 0x18, overflow: 0x20, forfeit: 0x22, out: 0x24,
};
const IN_BASE = O.out + QUEUE * CMD_BYTES;
const MAILBOX_BYTES = IN_BASE + MAX_PLAYERS * QUEUE * CMD_BYTES;

export const VLINK_STATE = { idle: 0, waiting: 1, inBattle: 2, done: 3 } as const;
export const KIND = { singles: 0, doubles: 1, multi: 2 } as const;

export type VLinkSession = { battle: string; mpId: number; count: number; kind: keyof typeof KIND };

function b64encode(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class VLinkRelay {
  private queues: Uint8Array[][] = [[], [], [], []]; // incoming commands per sender, not yet in RAM
  private reportedDone = false;

  constructor(
    private mem: () => GbaMemory | null,
    private base: number,
    readonly session: VLinkSession,
    private sendCmds: (data: string) => void,
    private onDone: (outcome: number) => void,
  ) {}

  private u8 = (o: number) => this.mem()?.u8(this.base + o) ?? 0;
  private u16 = (o: number) => this.mem()?.u16(this.base + o) ?? 0;
  private w8(o: number, v: number) { this.mem()?.write(this.base + o, new Uint8Array([v & 0xff])); }
  private w16(o: number, v: number) { this.mem()?.write(this.base + o, new Uint8Array([v & 0xff, (v >> 8) & 0xff])); }

  /** Clears the mailbox and asks the ROM to start the battle as soon as the player is free. */
  start(): boolean {
    const mem = this.mem();
    if (!mem) return false;
    mem.write(this.base, new Uint8Array(MAILBOX_BYTES));
    this.w8(O.mpId, this.session.mpId);
    this.w8(O.count, this.session.count);
    this.w8(O.kind, KIND[this.session.kind]);
    this.w8(O.active, 1);
    const magic = new Uint8Array(4);
    new DataView(magic.buffer).setUint32(0, MAGIC, true);
    mem.write(this.base + O.magic, magic);
    this.w8(O.start, 1);
    return true;
  }

  get state() { return this.u8(O.state); }
  get overflow() { return this.u16(O.overflow); }

  /** Commands from another player arrived from the server. */
  receive(from: number, data: string) {
    if (from < 0 || from >= MAX_PLAYERS || from === this.session.mpId) return;
    const bytes = b64decode(data);
    for (let i = 0; i + CMD_BYTES <= bytes.length; i += CMD_BYTES) this.queues[from].push(bytes.slice(i, i + CMD_BYTES));
    this.pump();
  }

  /** The opponent left or this player was AFK: make the ROM leave the battle. 2 = we win, 1 = we lose. */
  forfeit(weWin: boolean) {
    this.w16(O.forfeit, weWin ? 2 : 1);
  }

  /** Called every few milliseconds: ROM -> server and server -> ROM. */
  pump() {
    const mem = this.mem();
    if (!mem || mem.u32(this.base + O.magic) !== MAGIC) return;

    // Outgoing: everything the ROM queued since last time.
    const head = this.u16(O.outHead);
    let tail = this.u16(O.outTail);
    if (head !== tail) {
      const n = (head - tail) & 0xffff;
      const out = new Uint8Array(n * CMD_BYTES);
      for (let k = 0; k < n; k++, tail = (tail + 1) & 0xffff) {
        out.set(mem.bytes(this.base + O.out + (tail % QUEUE) * CMD_BYTES, CMD_BYTES), k * CMD_BYTES);
      }
      this.w16(O.outTail, tail);
      this.sendCmds(b64encode(out));
    }

    // Incoming: fill each sender's ring as far as there is room.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const q = this.queues[p];
      if (!q.length) continue;
      let inHead = this.u16(O.inHead + p * 2);
      const inTail = this.u16(O.inTail + p * 2);
      while (q.length && ((inHead - inTail) & 0xffff) < QUEUE) {
        mem.write(this.base + IN_BASE + p * QUEUE * CMD_BYTES + (inHead % QUEUE) * CMD_BYTES, q.shift()!);
        inHead = (inHead + 1) & 0xffff;
      }
      this.w16(O.inHead + p * 2, inHead); // publish only after the data is in place
    }

    if (!this.reportedDone && this.state === VLINK_STATE.done) {
      this.reportedDone = true;
      this.onDone(this.u8(O.outcome));
    }
  }

  /** Session over: the ROM stops using the virtual cable. */
  stop() {
    const mem = this.mem();
    if (!mem) return;
    this.w8(O.active, 0);
    this.w8(O.start, 0);
    mem.write(this.base + O.magic, new Uint8Array(4));
  }
}
