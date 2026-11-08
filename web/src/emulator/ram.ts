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
  let best = -1;
  let bestScore = 0;
  for (let off = 0; off + size <= block.length; off += 256) {
    if (block[off] === 0 || block[off] === 0xff) continue;
    const seen = new Set<number>();
    for (let i = 0; i < size; i++) seen.add(block[off + i]);
    if (seen.size > bestScore) {
      bestScore = seen.size;
      best = off;
      if (seen.size >= size * 0.75) break;
    }
  }
  if (best < 0) throw new Error('memory block has no distinctive bytes');
  return best;
}

function similarity(heap: Uint8Array, at: number, block: Uint8Array): number {
  if (at < 0 || at + block.length > heap.length) return 0;
  let same = 0;
  for (let i = 0; i < block.length; i += 4) if (heap[at + i] === block[i]) same++;
  return same / Math.ceil(block.length / 4);
}

/** Find the heap offset where `block` lives. Returns -1 if not found. */
export function findBlock(heap: Uint8Array, block: Uint8Array, minSimilarity = 0.97): number {
  const probeOff = pickProbe(block);
  const probe = block.subarray(probeOff, probeOff + 48);
  const first = probe[0];
  let i = heap.indexOf(first);
  let bestAt = -1;
  let bestSim = 0;
  while (i !== -1) {
    let ok = true;
    for (let k = 1; k < probe.length; k++) {
      if (heap[i + k] !== probe[k]) { ok = false; break; }
    }
    if (ok) {
      const at = i - probeOff;
      const sim = similarity(heap, at, block);
      if (sim > bestSim) { bestSim = sim; bestAt = at; }
      if (sim >= 0.999) break;
    }
    i = heap.indexOf(first, i + 1);
  }
  return bestSim >= minSimilarity ? bestAt : -1;
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
};

export type PlayerPosition = { group: number; num: number; x: number; y: number; mapsec: number; w: number; h: number };

export function inOverworld(mem: GbaMemory, sym: GameSymbols): boolean {
  if (!sym.main || !sym.overworldCallback) return true;
  return ((mem.u32(sym.main + 4) & ~1) >>> 0) === ((sym.overworldCallback & ~1) >>> 0);
}

export function readPosition(mem: GbaMemory, sym: GameSymbols): PlayerPosition | null {
  if (!inOverworld(mem, sym)) return null;
  const sb1 = mem.u32(sym.saveBlock1Ptr);
  if (!mem.isRam(sb1)) return null;
  const x = mem.s16(sb1);
  const y = mem.s16(sb1 + 2);
  const group = mem.s8(sb1 + 4);
  const num = mem.s8(sb1 + 5);
  if (group < 0 || num < 0) return null;
  const layoutPtr = mem.u32(sym.mapHeader);
  const mapsec = mem.u8(sym.mapHeader + 0x14);
  const w = layoutPtr >= ROM_BASE ? mem.u32(layoutPtr) : 0;
  const h = layoutPtr >= ROM_BASE ? mem.u32(layoutPtr + 4) : 0;
  return { group, num, x, y, mapsec, w: w < 1024 ? w : 0, h: h < 1024 ? h : 0 };
}

export function readParty(mem: GbaMemory, sym: GameSymbols): { count: number; data: Uint8Array } {
  const count = Math.min(6, mem.u8(sym.partiesCount));
  return { count, data: mem.bytes(sym.parties, 600) };
}
