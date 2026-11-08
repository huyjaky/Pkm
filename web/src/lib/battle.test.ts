import { describe, expect, it } from 'vitest';
import { findBlock, GbaMemory, readPosition } from '../emulator/ram';
import { applyLines, newBattle, targetOptions } from './battle';

const base = () => newBattle({
  id: 'b1', format: 'singles', level: 50, mySlot: 'p1', colors: {},
  players: [{ slot: 'p1', userId: 1, name: 'May' }, { slot: 'p2', userId: 2, name: 'Wally' }],
});

describe('applyLines', () => {
  it('tracks switches, damage and faints', () => {
    let v = applyLines(base(), ['|switch|p1a: Mudkip|Mudkip, L50, M|125/125', '|switch|p2a: Ralts|Ralts, L50, shiny|100/100', '|turn|1']);
    expect(v.active.p1a.hp).toBe(125);
    expect(v.active.p2a.shiny).toBe(true);
    expect(v.turn).toBe(1);
    v = applyLines(v, ['|move|p1a: Mudkip|Water Gun|p2a: Ralts', '|-damage|p2a: Ralts|40/100', '|faint|p1a: Mudkip', '|-damage|p1a: Mudkip|0 fnt']);
    expect(v.active.p2a.hp).toBe(40);
    expect(v.active.p1a.fainted).toBe(true);
    expect(v.active.p1a.maxhp).toBe(125);
    expect(v.log.some(e => e.text === 'Mudkip dùng Water Gun!')).toBe(true);
    expect(v.log.some(e => e.text.includes('Ralts (Wally) mất 60% HP'))).toBe(true);
  });

  it('offers foe and ally targets in a 2v2 multi battle', () => {
    let v = newBattle({ ...base(), format: 'multi', mySlot: 'p3', players: [] });
    v = applyLines(v, ['p1a', 'p2a', 'p3a', 'p4a'].map(p => `|switch|${p}: M${p}|Pikachu, L50|100/100`));
    const opts = targetOptions(v, 'normal', 0);
    expect(opts.filter(o => !o.ally).map(o => o.n)).toEqual([1, 2]);
    expect(opts.filter(o => o.ally).map(o => o.n)).toEqual([-1]); // ally p1, not self
  });
});

describe('RAM search', () => {
  it('finds a memory block inside a larger heap and reads the player position', () => {
    const heap = new Uint8Array(1 << 20);
    for (let i = 0; i < heap.length; i++) heap[i] = (i * 2654435761) >>> 24;
    const iwram = new Uint8Array(0x8000);
    const ewram = new Uint8Array(0x40000);
    for (let i = 0; i < iwram.length; i++) iwram[i] = (i * 7 + 3) & 0xff;
    for (let i = 0; i < ewram.length; i++) ewram[i] = (i * 13 + 5) & 0xff;
    // gSaveBlock1Ptr (IWRAM 0x03005d8c) -> EWRAM 0x02025a00: pos (7, 9), map 0.10
    new DataView(iwram.buffer).setUint32(0x5d8c, 0x02025a00, true);
    const sb = new DataView(ewram.buffer, 0x25a00);
    sb.setInt16(0, 7, true); sb.setInt16(2, 9, true); sb.setInt8(4, 0); sb.setInt8(5, 10);
    // gMapHeader at 0x02037318: layout pointer into ROM + mapsec
    new DataView(ewram.buffer).setUint32(0x37318, 0x08000010, true);
    ewram[0x37318 + 0x14] = 3;
    heap.set(iwram, 0x1234);
    heap.set(ewram, 0x40000);
    const iAt = findBlock(heap, iwram);
    const eAt = findBlock(heap, ewram);
    expect(iAt).toBe(0x1234);
    expect(eAt).toBe(0x40000);
    const rom = new Uint8Array(0x40);
    new DataView(rom.buffer).setUint32(0x10, 20, true);
    new DataView(rom.buffer).setUint32(0x14, 30, true);
    const mem = new GbaMemory(() => heap, iAt, eAt, rom);
    expect(readPosition(mem, { saveBlock1Ptr: 0x03005d8c, parties: 0, partiesCount: 0, mapHeader: 0x02037318 }))
      .toEqual({ group: 0, num: 10, x: 7, y: 9, mapsec: 3, w: 20, h: 30 });
  });
});
