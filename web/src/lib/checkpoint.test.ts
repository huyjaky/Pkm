import { describe, expect, it } from 'vitest';
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint';

const HASH = 'f214b543b5460354a97a82dc7c3ec2d9edf391a8';

describe('checkpoint files', () => {
  it('round-trips a save state and compresses it', async () => {
    const state = new Uint8Array(0x61000);
    for (let i = 0; i < 4096; i++) state[i * 7] = i & 0xff;
    const file = await encodeCheckpoint(state, HASH);
    expect(file.length).toBeLessThan(state.length / 4);
    expect(await decodeCheckpoint(file, HASH)).toEqual(state);
  });

  it('refuses a checkpoint from another ROM build or a corrupt file', async () => {
    const file = await encodeCheckpoint(new Uint8Array([1, 2, 3]), HASH);
    expect(await decodeCheckpoint(file, 'a'.repeat(40))).toBeNull();
    expect(await decodeCheckpoint(new Uint8Array([1, 2, 3]), HASH)).toBeNull();
    const broken = file.slice(0, 50);
    expect(await decodeCheckpoint(broken, HASH)).toBeNull();
  });
});
