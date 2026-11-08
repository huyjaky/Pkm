/**
 * Locating GBA RAM inside the mGBA WebAssembly heap.
 *
 * mgba-wasm has no memory-read API, but it exports the wasm heap (Module.HEAPU8) and can write
 * save states. A raw mGBA save state (GBASerializedState) contains copies of IWRAM and EWRAM at
 * fixed offsets, so while the game is paused we take a state and search the heap for those exact
 * bytes. The core allocates its RAM once per loaded game, so the found offsets stay valid.
 */

export const STATE_IWRAM_OFFSET = 0x19000;
export const STATE_EWRAM_OFFSET = 0x21000;
export const IWRAM_SIZE = 0x8000;
export const EWRAM_SIZE = 0x40000;
export const IWRAM_BASE = 0x03000000;
export const EWRAM_BASE = 0x02000000;
export const ROM_BASE = 0x08000000;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns the raw GBASerializedState from a state file (plain, or embedded in a PNG "gbAs" chunk). */
export async function extractState(file: Uint8Array): Promise<Uint8Array> {
  if (PNG_SIG.every((b, i) => file[i] === b)) {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    let off = 8;
    while (off + 8 <= file.length) {
      const len = view.getUint32(off);
      const type = String.fromCharCode(...file.subarray(off + 4, off + 8));
      if (type === 'gbAs') return inflate(file.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    throw new Error('save state PNG has no gbAs chunk');
  }
  return file;
}

/** Pick a probe window inside `block` that is distinctive (many different byte values). */
export function pickProbe(block: Uint8Array, size = 48): number {
  // Right after boot most of RAM is still zero, so scan densely and fall back to a full scan.
  for (const step of [16, 1]) {
    let best = -1;
    let bestScore = 0;
    for (let off = 0; off + size <= block.length; off += step) {
      if (block[off] === 0 || block[off] === 0xff) continue;
      const seen = new Set<number>();
      for (let i = 0; i < size; i++) seen.add(block[off + i]);
      if (seen.size > bestScore) {
        bestScore = seen.size;
        best = off;
        if (seen.size >= size * 0.75) return best;
      }
    }
    if (best >= 0 && bestScore >= 8) return best;
  }
  throw new Error('memory block has no distinctive bytes');
}

function similarity(heap: Uint8Array, at: number, block: Uint8Array): number {
  if (at < 0 || at + block.length > heap.length) return 0;
  let same = 0;
  for (let i = 0; i < block.length; i += 4) if (heap[at + i] === block[i]) same++;
  return same / Math.ceil(block.length / 4);
}

/**
 * All heap offsets where `block` lives (similarity >= minSimilarity), best first.
 * There can be more than one: mGBA serialises the state into a heap buffer that still holds
 * an identical, frozen copy right after the save. `pickLive` tells them apart.
 */
export function findBlocks(heap: Uint8Array, block: Uint8Array, minSimilarity = 0.97): number[] {
  const probeOff = pickProbe(block);
  const probe = block.subarray(probeOff, probeOff + 48);
  const first = probe[0];
  const found: { at: number; sim: number }[] = [];
  let i = heap.indexOf(first);
  while (i !== -1) {
    let ok = true;
    for (let k = 1; k < probe.length; k++) {
      if (heap[i + k] !== probe[k]) { ok = false; break; }
    }
    if (ok) {
      const at = i - probeOff;
      const sim = similarity(heap, at, block);
      if (sim >= minSimilarity && !found.some(f => f.at === at)) found.push({ at, sim });
    }
    i = heap.indexOf(first, i + 1);
  }
  return found.sort((a, b) => b.sim - a.sim).map(f => f.at);
}

export function findBlock(heap: Uint8Array, block: Uint8Array, minSimilarity = 0.97): number {
  return findBlocks(heap, block, minSimilarity)[0] ?? -1;
}

/** After the game ran for a moment, the live RAM differs from the snapshot; a stale copy does not. */
export function pickLive(heap: Uint8Array, candidates: number[], snapshot: Uint8Array): number {
  if (candidates.length <= 1) return candidates[0] ?? -1;
  let best = -1;
  let bestChanged = 0;
  for (const at of candidates) {
    let changed = 0;
    for (let i = 0; i < snapshot.length; i += 4) if (heap[at + i] !== snapshot[i]) changed++;
    if (changed > bestChanged) { bestChanged = changed; best = at; }
  }
  return best;
}

/** Reads GBA addresses through the located heap offsets (and the ROM image for 0x08xxxxxx). */
export class GbaMemory {
  constructor(
    private heap: () => Uint8Array,
    private iwramAt: number,
    private ewramAt: number,
    private rom: Uint8Array,
  ) {}

  private locate(addr: number): [Uint8Array, number] | null {
    if (addr >= EWRAM_BASE && addr < EWRAM_BASE + EWRAM_SIZE) return [this.heap(), this.ewramAt + addr - EWRAM_BASE];
    if (addr >= IWRAM_BASE && addr < IWRAM_BASE + IWRAM_SIZE) return [this.heap(), this.iwramAt + addr - IWRAM_BASE];
    if (addr >= ROM_BASE && addr < ROM_BASE + this.rom.length) return [this.rom, addr - ROM_BASE];
    return null;
  }

  u8(addr: number): number {
    const l = this.locate(addr);
    return l ? l[0][l[1]] : 0;
  }
  s8(addr: number): number {
    const v = this.u8(addr);
    return v > 127 ? v - 256 : v;
  }
  u16(addr: number): number {
    return this.u8(addr) | (this.u8(addr + 1) << 8);
  }
  s16(addr: number): number {
    const v = this.u16(addr);
    return v > 32767 ? v - 65536 : v;
  }
  u32(addr: number): number {
    return (this.u16(addr) | (this.u16(addr + 2) << 16)) >>> 0;
  }
  /** Writes into EWRAM (used for the online-players buffer). */
  write(addr: number, data: Uint8Array): boolean {
    if (addr < EWRAM_BASE || addr + data.length > EWRAM_BASE + EWRAM_SIZE) return false;
    this.heap().set(data, this.ewramAt + addr - EWRAM_BASE);
    return true;
  }
  bytes(addr: number, len: number): Uint8Array {
    const l = this.locate(addr);
    if (!l) return new Uint8Array(len);
    return l[0].slice(l[1], l[1] + len);
  }
  isRam(addr: number): boolean {
    return (addr >= EWRAM_BASE && addr < EWRAM_BASE + EWRAM_SIZE) || (addr >= IWRAM_BASE && addr < IWRAM_BASE + IWRAM_SIZE);
  }
}

export type GameSymbols = {
  saveBlock1Ptr: number;
  parties: number;
  partiesCount: number;
  mapHeader: number;
  /** gMain address and CB2_Overworld; position is only trusted while the overworld runs. */
  main?: number;
  overworldCallback?: number;
  /** Added by rom-patch/: the ROM exports its own state and draws friends from gOnlinePlayers. */
  onlineSelf?: number;
  onlinePlayers?: number;
  onlineMagic?: number;
};

export type PlayerPosition = {
  group: number; num: number; x: number; y: number; mapsec: number; w: number; h: number;
  facing?: number; elev?: number; gfx?: number;
};

export const ONLINE_MAGIC = 0x4c4e4f48;
export const ONLINE_SLOTS = 8;
const ONLINE_SLOT_SIZE = 12;

export type Ghost = { group: number; num: number; x: number; y: number; facing: number; elev: number; gfx: number };

/** Writes friends on this map into gOnlinePlayers; slots[i] = null hides that slot. */
export function writeGhosts(mem: GbaMemory, sym: GameSymbols, slots: (Ghost | null)[]): boolean {
  if (!sym.onlinePlayers || !sym.onlineMagic) return false;
  const buf = new Uint8Array(ONLINE_SLOTS * ONLINE_SLOT_SIZE);
  const view = new DataView(buf.buffer);
  slots.slice(0, ONLINE_SLOTS).forEach((g, i) => {
    if (!g) return;
    const o = i * ONLINE_SLOT_SIZE;
    view.setUint8(o, 1);
    view.setInt8(o + 1, g.group);
    view.setInt8(o + 2, g.num);
    view.setUint8(o + 3, g.facing);
    view.setInt16(o + 4, g.x, true);
    view.setInt16(o + 6, g.y, true);
    view.setUint16(o + 8, g.gfx, true);
    view.setUint8(o + 10, g.elev);
  });
  const magic = new Uint8Array(4);
  new DataView(magic.buffer).setUint32(0, ONLINE_MAGIC, true);
  return mem.write(sym.onlinePlayers, buf) && mem.write(sym.onlineMagic, magic);
}

export function inOverworld(mem: GbaMemory, sym: GameSymbols): boolean {
  if (!sym.main || !sym.overworldCallback) return true;
  return ((mem.u32(sym.main + 4) & ~1) >>> 0) === ((sym.overworldCallback & ~1) >>> 0);
}

export function readPosition(mem: GbaMemory, sym: GameSymbols): PlayerPosition | null {
  if (!inOverworld(mem, sym)) return null;
  if (sym.onlineSelf && mem.u32(sym.onlineSelf) === ONLINE_MAGIC) {
    const o = sym.onlineSelf;
    const header = mapHeaderInfo(mem, sym);
    return {
      group: mem.s8(o + 8), num: mem.s8(o + 9), x: mem.s16(o + 12), y: mem.s16(o + 14), ...header,
      facing: mem.u8(o + 10), elev: mem.u8(o + 11), gfx: mem.u16(o + 16),
    };
  }
  const sb1 = mem.u32(sym.saveBlock1Ptr);
  if (!mem.isRam(sb1)) return null;
  const x = mem.s16(sb1);
  const y = mem.s16(sb1 + 2);
  const group = mem.s8(sb1 + 4);
  const num = mem.s8(sb1 + 5);
  if (group < 0 || num < 0) return null;
  return { group, num, x, y, ...mapHeaderInfo(mem, sym) };
}

function mapHeaderInfo(mem: GbaMemory, sym: GameSymbols) {
  const layoutPtr = mem.u32(sym.mapHeader);
  const mapsec = mem.u8(sym.mapHeader + 0x14);
  const w = layoutPtr >= ROM_BASE ? mem.u32(layoutPtr) : 0;
  const h = layoutPtr >= ROM_BASE ? mem.u32(layoutPtr + 4) : 0;
  return { mapsec, w: w < 1024 ? w : 0, h: h < 1024 ? h : 0 };
}

export function readParty(mem: GbaMemory, sym: GameSymbols): { count: number; data: Uint8Array } {
  const count = Math.min(6, mem.u8(sym.partiesCount));
  return { count, data: mem.bytes(sym.parties, 600) };
}
