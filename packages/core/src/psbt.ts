// Reads the parts of a PSBT (BIP174 version 0, BIP370 version 2) that a spend check needs: the amount of every
// input, every output (amount and script) and the transaction id. CLN's `txprepare` returns version 2. Nothing is
// signed or changed here. Anything the reader does not understand throws PsbtError, so the caller refuses the
// transaction instead of guessing. Amounts are msat, like every amount in the domain.
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { msat, type Msat } from './money.ts';
import { parseTxid, type Txid } from './ids.ts';

export class PsbtError extends Error {}

export interface PsbtSummary {
  version: 0 | 2;
  txid: Txid;
  inputs: { txid: string; vout: number; amount: Msat }[];
  outputs: { amount: Msat; script: string }[];
  // Inputs minus outputs.
  fee: Msat;
}

class Reader {
  i = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  need(n: number): void {
    if (this.i + n > this.b.length) throw new PsbtError('truncated');
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }
  u8(): number {
    return this.bytes(1)[0] as number;
  }
  u32(): number {
    const v = this.bytes(4);
    return ((v[0] as number) | ((v[1] as number) << 8) | ((v[2] as number) << 16)) + (v[3] as number) * 0x1000000;
  }
  u64(): bigint {
    const v = this.bytes(8);
    let n = 0n;
    for (let k = 7; k >= 0; k--) n = (n << 8n) | BigInt(v[k] as number);
    return n;
  }
  varint(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) return this.u8() | (this.u8() << 8);
    if (first === 0xfe) return this.u32();
    const big = this.u64();
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new PsbtError('length too large');
    return Number(big);
  }
  done(): boolean {
    return this.i === this.b.length;
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const dsha = (b: Uint8Array) => sha256(sha256(b));
const reversedHex = (b: Uint8Array) => hex(Uint8Array.from(b).reverse());
// Satoshis on the wire, msat in the domain; at most 21 million BTC.
const toMsat = (sat: bigint) => {
  if (sat > 2_100_000_000_000_000n) throw new PsbtError('amount out of range');
  return msat(sat * 1000n);
};

function varintBytes(n: number): number[] {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, n >> 8];
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}
const le = (n: bigint, size: number) => Array.from({ length: size }, (_, k) => Number((n >> BigInt(8 * k)) & 0xffn));

interface Tx {
  version: number;
  inputs: { txid: Uint8Array; vout: number; sequence: number }[];
  outputs: { amount: bigint; script: Uint8Array }[];
  locktime: number;
}

function serialize(tx: Tx): Uint8Array {
  const out: number[] = [...le(BigInt(tx.version), 4), ...varintBytes(tx.inputs.length)];
  for (const input of tx.inputs)
    out.push(...input.txid, ...le(BigInt(input.vout), 4), 0, ...le(BigInt(input.sequence), 4));
  out.push(...varintBytes(tx.outputs.length));
  for (const o of tx.outputs) out.push(...le(o.amount, 8), ...varintBytes(o.script.length), ...o.script);
  out.push(...le(BigInt(tx.locktime), 4));
  return Uint8Array.from(out);
}

// A transaction, with or without witness data; the txid never covers the witness.
function readTx(bytes: Uint8Array): Tx {
  const r = new Reader(bytes);
  const version = r.u32();
  let segwit = false;
  if (bytes[r.i] === 0 && bytes[r.i + 1] === 1) {
    segwit = true;
    r.i += 2;
  }
  const inputs = Array.from({ length: r.varint() }, () => {
    const txid = Uint8Array.from(r.bytes(32));
    const vout = r.u32();
    r.bytes(r.varint());
    return { txid, vout, sequence: r.u32() };
  });
  const outputs = Array.from({ length: r.varint() }, () => ({
    amount: r.u64(),
    script: Uint8Array.from(r.bytes(r.varint())),
  }));
  if (segwit) for (let k = 0; k < inputs.length; k++) for (let n = r.varint(); n > 0; n--) r.bytes(r.varint());
  const locktime = r.u32();
  if (!r.done()) throw new PsbtError('trailing transaction bytes');
  return { version, inputs, outputs, locktime };
}

type Map_ = Map<number, { key: Uint8Array; value: Uint8Array }>;
function readMap(r: Reader): Map_ {
  const map: Map_ = new Map();
  for (;;) {
    const keyLength = r.varint();
    if (keyLength === 0) return map;
    const key = Uint8Array.from(r.bytes(keyLength));
    const value = Uint8Array.from(r.bytes(r.varint()));
    const type = key[0] as number;
    // Only single-byte key types without key data are read; repeated ones are refused.
    if (keyLength === 1) {
      if (map.has(type)) throw new PsbtError('duplicate key');
      map.set(type, { key, value });
    }
  }
}
const u32le = (v: Uint8Array) => {
  if (v.length !== 4) throw new PsbtError('bad field');
  return new Reader(v).u32();
};

export function readPsbt(text: string): PsbtSummary {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(text);
  } catch {
    throw new PsbtError('not base64');
  }
  if (hex(bytes.subarray(0, 5)) !== '70736274ff') throw new PsbtError('not a PSBT');
  const r = new Reader(bytes);
  r.i = 5;
  const global = readMap(r);
  const version = global.get(0xfb) ? u32le(global.get(0xfb)?.value as Uint8Array) : 0;
  let tx: Tx;
  let inputMaps: Map_[];
  if (version === 0) {
    const unsigned = global.get(0x00);
    if (!unsigned) throw new PsbtError('no unsigned transaction');
    tx = readTx(unsigned.value);
    inputMaps = tx.inputs.map(() => readMap(r));
    for (let k = 0; k < tx.outputs.length; k++) readMap(r);
  } else if (version === 2) {
    const count = (type: number) => {
      const field = global.get(type);
      if (!field) throw new PsbtError('missing count');
      return new Reader(field.value).varint();
    };
    const txVersion = global.get(0x02);
    if (!txVersion) throw new PsbtError('missing transaction version');
    inputMaps = Array.from({ length: count(0x04) }, () => readMap(r));
    const outputMaps = Array.from({ length: count(0x05) }, () => readMap(r));
    if (inputMaps.some((m) => m.has(0x11) || m.has(0x12))) throw new PsbtError('required lock times not supported');
    const fallback = global.get(0x03);
    tx = {
      version: u32le(txVersion.value),
      inputs: inputMaps.map((m) => {
        const txid = m.get(0x0e)?.value;
        const vout = m.get(0x0f)?.value;
        if (!txid || txid.length !== 32 || !vout) throw new PsbtError('input without outpoint');
        const sequence = m.get(0x10);
        return { txid, vout: u32le(vout), sequence: sequence ? u32le(sequence.value) : 0xffffffff };
      }),
      outputs: outputMaps.map((m) => {
        const amount = m.get(0x03)?.value;
        const script = m.get(0x04)?.value;
        if (!amount || amount.length !== 8 || !script) throw new PsbtError('output without amount or script');
        return { amount: new Reader(amount).u64(), script };
      }),
      locktime: fallback ? u32le(fallback.value) : 0,
    };
  } else {
    throw new PsbtError('unsupported PSBT version');
  }
  if (!r.done()) throw new PsbtError('trailing bytes');
  // An input's amount comes from its full previous transaction when present (checked against the outpoint), else
  // from its witness UTXO; both present must agree.
  const inputs = tx.inputs.map((input, k) => {
    const map = inputMaps[k] as Map_;
    let amount: bigint | undefined;
    const full = map.get(0x00);
    if (full) {
      const previous = readTx(full.value);
      if (hex(dsha(serialize(previous))) !== hex(input.txid)) throw new PsbtError('previous transaction mismatch');
      const spent = previous.outputs[input.vout];
      if (!spent) throw new PsbtError('previous output missing');
      amount = spent.amount;
    }
    const witness = map.get(0x01);
    if (witness) {
      const value = new Reader(witness.value).u64();
      if (amount !== undefined && amount !== value) throw new PsbtError('input amounts disagree');
      amount = value;
    }
    if (amount === undefined) throw new PsbtError('input amount unknown');
    return { txid: reversedHex(input.txid), vout: input.vout, amount: toMsat(amount) };
  });
  const outputs = tx.outputs.map((o) => ({ amount: toMsat(o.amount), script: hex(o.script) }));
  const totalIn = inputs.reduce((sum, input) => sum + input.amount, 0n);
  const totalOut = outputs.reduce((sum, o) => sum + o.amount, 0n);
  if (totalOut > totalIn) throw new PsbtError('outputs exceed inputs');
  return {
    version,
    txid: parseTxid(reversedHex(dsha(serialize(tx)))),
    inputs,
    outputs,
    fee: msat(totalIn - totalOut),
  };
}

// Builds an unsigned version 2 PSBT with witness UTXOs (test doubles only: the fake adapter's `prepare`).
export function buildPsbt(tx: {
  inputs: { txid: string; vout: number; amountSat: bigint; script: string }[];
  outputs: { amountSat: bigint; script: string }[];
}): { psbt: string; txid: Txid } {
  const out: number[] = [0x70, 0x73, 0x62, 0x74, 0xff];
  const field = (type: number, value: number[]) => out.push(1, type, ...varintBytes(value.length), ...value);
  field(0x02, le(2n, 4));
  field(0x03, le(0n, 4));
  field(0x04, varintBytes(tx.inputs.length));
  field(0x05, varintBytes(tx.outputs.length));
  field(0xfb, le(2n, 4));
  out.push(0);
  for (const input of tx.inputs) {
    const script = [...fromHex(input.script)];
    field(0x01, [...le(input.amountSat, 8), ...varintBytes(script.length), ...script]);
    field(0x0e, [...fromHex(input.txid).reverse()]);
    field(0x0f, le(BigInt(input.vout), 4));
    out.push(0);
  }
  for (const o of tx.outputs) {
    field(0x03, le(o.amountSat, 8));
    field(0x04, [...fromHex(o.script)]);
    out.push(0);
  }
  const psbt = base64.encode(Uint8Array.from(out));
  return { psbt, txid: readPsbt(psbt).txid };
}
