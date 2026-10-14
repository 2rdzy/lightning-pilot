import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { buildPsbt, PsbtError, readPsbt } from './psbt.ts';
import fixture from './fixtures/txprepare-psbt.json' with { type: 'json' };

describe('readPsbt', () => {
  it('reads a CLN txprepare PSBT (version 2): txid, outputs and fee', () => {
    const read = readPsbt(fixture.blake2b.psbt);
    expect(read.version).toBe(2);
    expect(read.txid).toBe(fixture.blake2b.txid);
    expect(read.outputs[0]).toEqual({ amount: 12_345_000n, script: fixture.blake2b.destination });
    expect(read.inputs).toEqual([
      { txid: 'd88b80f65f300366376bc1caeccaa0cb3ae3ddf0ed5db6d7a4d0cffc19fba46b', vout: 1, amount: 189_706_000n },
    ]);
    // 189706 in, 12345 + 177077 out: 284 sat at 2 sat/vB.
    expect(read.fee).toBe(284_000n);
  });

  it('builds a PSBT it reads back, and refuses what it cannot read', () => {
    const built = buildPsbt({
      inputs: [{ txid: 'ab'.repeat(32), vout: 3, amountSat: 50_000n, script: '0014' + '11'.repeat(20) }],
      outputs: [
        { amountSat: 20_000n, script: '0014' + '22'.repeat(20) },
        { amountSat: 29_000n, script: '5120' + '33'.repeat(32) },
      ],
    });
    const read = readPsbt(built.psbt);
    expect(read.txid).toBe(built.txid);
    expect(read.fee).toBe(1_000_000n);
    expect(read.inputs[0]).toMatchObject({ txid: 'ab'.repeat(32), vout: 3 });
    const bytes = base64.decode(fixture.blake2b.psbt);
    for (const bad of [
      'not base64!',
      base64.encode(Uint8Array.of(1, 2, 3, 4, 5, 6)),
      base64.encode(bytes.subarray(0, bytes.length - 10)),
      base64.encode(Uint8Array.of(...bytes, 0)),
    ])
      expect(() => readPsbt(bad), bad).toThrow(PsbtError);
    // Outputs worth more than the inputs.
    expect(() => buildPsbt({ inputs: [], outputs: [{ amountSat: 1n, script: '00' }] })).toThrow(PsbtError);
  });

  it('reads version 0 too, checking a full previous transaction against the outpoint and the witness UTXO', () => {
    const v2 = base64.decode(fixture.blake2b.psbt);
    // Pull the input's two UTXO records out of the version 2 PSBT (key 0x00 then key 0x01, as CLN writes them).
    const find = (key: number) => {
      for (let i = 0; i < v2.length - 2; i++)
        if (v2[i] === 1 && v2[i + 1] === key && v2[i + 2] === (key === 0 ? 125 : 43)) return i;
      throw new Error('not found');
    };
    const full = v2.subarray(find(0x00), find(0x00) + 3 + 125);
    const witness = v2.subarray(find(0x01), find(0x01) + 3 + 43);
    const tx = Uint8Array.from(fixture.blake2b.unsignedTx.match(/../g) ?? [], (h) => parseInt(h, 16));
    const v0 = (input: number[]) =>
      base64.encode(Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff, 1, 0x00, 0x7d, ...tx, 0, ...input, 0, 0, 0));
    const read = readPsbt(v0([...full, ...witness]));
    expect(read).toMatchObject({ version: 0, txid: fixture.blake2b.txid, fee: 284_000n });
    expect(readPsbt(v0([...witness])).fee).toBe(284_000n);
    // A changed full transaction no longer matches the outpoint; a changed witness amount disagrees with it.
    const tampered = Uint8Array.from(full);
    tampered[10] = (tampered[10] as number) ^ 1;
    expect(() => readPsbt(v0([...tampered, ...witness]))).toThrow('previous transaction mismatch');
    const cheaper = Uint8Array.from(witness);
    cheaper[3] = (cheaper[3] as number) ^ 1;
    expect(() => readPsbt(v0([...full, ...cheaper]))).toThrow('input amounts disagree');
    expect(() => readPsbt(v0([]))).toThrow('input amount unknown');
    expect(() => readPsbt(v0([...witness, ...witness]))).toThrow('duplicate key');
  });
});
