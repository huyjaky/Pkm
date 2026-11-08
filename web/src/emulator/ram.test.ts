import { describe, expect, it } from 'vitest';
import { findBlocks, GbaMemory, ONLINE_MAGIC, pickLive, readPosition, writeGhosts } from './ram';

const EW = 0x40000;
function setup() {
  const heap = new Uint8Array(EW + 0x8000 + 0x100);
  const mem = new GbaMemory(() => heap, EW, 0, new Uint8Array(0x40));
  return { heap, mem };
}

describe('online players buffer', () => {
  it('reads our own state from gOnlineSelf and writes friends into gOnlinePlayers', () => {
    const { heap, mem } = setup();
    const sym = { saveBlock1Ptr: 0x03000000, parties: 0, partiesCount: 0, mapHeader: 0x02000100,
      onlineSelf: 0x02000200, onlinePlayers: 0x02000300, onlineMagic: 0x02000400 };
    const self = new DataView(heap.buffer, 0x200);
    self.setUint32(0, ONLINE_MAGIC, true);
    self.setInt8(8, 0); self.setInt8(9, 9); self.setUint8(10, 4); self.setUint8(11, 3);
    self.setInt16(12, 11, true); self.setInt16(14, -2, true); self.setUint16(16, 89, true);
    expect(readPosition(mem, sym)).toMatchObject({ group: 0, num: 9, x: 11, y: -2, facing: 4, elev: 3, gfx: 89 });

    writeGhosts(mem, sym, [null, { group: 0, num: 9, x: 5, y: 6, facing: 2, elev: 3, gfx: 100 }]);
    const slot1 = new DataView(heap.buffer, 0x300 + 12);
    expect(heap[0x300]).toBe(0); // slot 0 hidden
    expect([slot1.getUint8(0), slot1.getInt8(2), slot1.getInt16(4, true), slot1.getUint16(8, true)]).toEqual([1, 9, 5, 100]);
    expect(new DataView(heap.buffer, 0x400).getUint32(0, true)).toBe(ONLINE_MAGIC);
  });
});

describe('stale save-state copy', () => {
  it('prefers the copy that kept changing', () => {
    const heap = new Uint8Array(1 << 18);
    let seed = 12345;
    const block = new Uint8Array(0x8000).map(() => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; });
    heap.set(block, 0x1000);   // stale serialisation copy
    heap.set(block, 0x20000);  // live RAM
    const found = findBlocks(heap, block);
    expect([...found].sort((a, b) => a - b)).toEqual([0x1000, 0x20000]);
    for (let i = 0; i < 400; i += 4) heap[0x20000 + 0x100 + i] ^= 0xff; // the game ran
    expect(pickLive(heap, found, block)).toBe(0x20000);
  });
});
