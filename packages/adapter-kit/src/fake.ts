// In-memory fake adapter. It behaves like a node of the given chain: a tip block in that chain's header format,
// the matching feature bits, BOLT11 invoices our decoder can read, and payments between fake nodes on the same
// FakeNetwork. Used by the server's tests and by the UI work, and held to the same contract suite as real adapters.
import { createHash, randomBytes } from 'node:crypto';
import { bech32 } from '@scure/base';
import {
  AdapterError,
  msat,
  parsePaymentHash,
  parsePubkey,
  readBolt11,
  untrustedText,
  ZERO,
  type Balances,
  type Chain,
  type Msat,
  type Network,
  type NodeAdapter,
  type NodeFacts,
  type Payment,
  type PaymentHash,
} from '@lightning-pilot/core';

interface FakeInvoice {
  owner: string;
  preimage: string;
  amount: Msat;
  paid: boolean;
}

// Shared state of the fake nodes that can pay each other.
export class FakeNetwork {
  readonly invoices = new Map<string, FakeInvoice>();
}

export interface FakeNodeOptions {
  chain: Chain;
  network?: Network;
  alias?: string;
  blockHeight?: number;
  canSpend?: boolean;
  world?: FakeNetwork;
}

const HRP: Record<Network, string> = { mainnet: 'lnbc', testnet4: 'lntb', signet: 'lntbs', regtest: 'lnbcrt' };
const CLN_NETWORK: Record<Network, string> = {
  mainnet: 'bitcoin',
  testnet4: 'testnet4',
  signet: 'signet',
  regtest: 'regtest',
};

const sha256hex = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

function numberWords(value: number, length: number): number[] {
  const words: number[] = [];
  for (let i = 0; i < length; i++) {
    words.unshift(value % 32);
    value = Math.floor(value / 32);
  }
  return words;
}

// A BOLT11 string with a real checksum, amount, payment hash and expiry. Its signature is zero: the fake is for
// tests of our own code, and the minimal decoder does not check signatures.
function fakeBolt11(network: Network, amount: Msat, paymentHash: string, expirySeconds: number): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const hashWords = bech32.toWords(Buffer.from(paymentHash, 'hex'));
  const expiryWords = bech32.toWords(Buffer.from(expirySeconds.toString(16).padStart(8, '0'), 'hex'));
  const words = [
    ...numberWords(timestamp, 7),
    1,
    ...numberWords(hashWords.length, 2),
    ...hashWords,
    6,
    ...numberWords(expiryWords.length, 2),
    ...expiryWords,
    ...new Array<number>(104).fill(0),
  ];
  // The pico-bitcoin multiplier: one msat is 10 p.
  return bech32.encode(`${HRP[network]}${amount * 10n}p`, words, false);
}

// The tip block in the chain's format: BLAKE2b 164-byte header with version 0xa0000000, Bitcoin 80-byte header
// with version 0x20000000; then one transaction (only its count is needed by the identity check).
function fakeBlock(chain: Chain): string {
  const header = chain === 'blake2b' ? '000000a0' + '00'.repeat(160) : '00000020' + '00'.repeat(76);
  return header + '01';
}

// Node feature bits: option_blake2b (bit 513, optional) on BLAKE2b; the usual low bits on both.
function fakeFeatures(chain: Chain): string {
  const low = '0898880a8a59a1';
  // Bit 513 is bit 1 of the 65th byte from the end.
  return chain === 'blake2b' ? '02' + '00'.repeat(64 - low.length / 2) + low : low;
}

export class FakeAdapter implements NodeAdapter {
  readonly implementation = 'cln' as const;
  readonly pubkey = parsePubkey('02' + randomBytes(32).toString('hex'));
  readonly calls: string[] = [];
  blockHeight: number;
  synced = true;
  // Overrides for identity tests: a different chain's tip block or feature bits.
  tipOverride: string | undefined;
  featuresOverride: string | undefined;
  #nextError: AdapterError | undefined;
  readonly #options: Required<Omit<FakeNodeOptions, 'world'>>;
  readonly #world: FakeNetwork;
  readonly #payments = new Map<string, Payment>();
  #local: Msat;

  constructor(options: FakeNodeOptions) {
    this.#options = {
      chain: options.chain,
      network: options.network ?? 'regtest',
      alias: options.alias ?? `fake-${options.chain}`,
      blockHeight: options.blockHeight ?? 1000,
      canSpend: options.canSpend ?? true,
    };
    this.blockHeight = this.#options.blockHeight;
    this.#world = options.world ?? new FakeNetwork();
    this.#local = msat(1_000_000_000n);
  }

  // The next call fails with this error (once).
  failNext(error: AdapterError): void {
    this.#nextError = error;
  }

  #enter(method: string): void {
    this.calls.push(method);
    const error = this.#nextError;
    if (error) {
      this.#nextError = undefined;
      throw error;
    }
  }

  readonly node = {
    getInfo: async (): Promise<NodeFacts> => {
      this.#enter('getInfo');
      return {
        pubkey: this.pubkey,
        alias: untrustedText(this.#options.alias),
        color: '024470',
        implementation: 'cln',
        version: 'fake',
        network: this.#options.network,
        networkRaw: CLN_NETWORK[this.#options.network],
        blockHeight: this.blockHeight,
        synced: this.synced,
        numPeers: 1,
        numActiveChannels: 1,
        numPendingChannels: 0,
        numInactiveChannels: 0,
        features: this.featuresOverride ?? fakeFeatures(this.#options.chain),
      };
    },
  };

  readonly chain = {
    getTipHeader: async () => {
      this.#enter('getTipHeader');
      return { height: this.blockHeight, raw: this.tipOverride ?? fakeBlock(this.#options.chain) };
    },
  };

  readonly balance = {
    getBalances: async (): Promise<Balances> => {
      this.#enter('getBalances');
      return {
        onchain: { confirmed: msat(500_000_000n), unconfirmed: ZERO, reserved: ZERO },
        lightning: {
          local: this.#local,
          spendable: this.#local,
          remote: msat(1_000_000_000n),
          receivable: msat(1_000_000_000n),
        },
        pendingClose: ZERO,
      };
    },
  };

  readonly receive = {
    createInvoice: async (request: { amount: Msat; description: string; label: string; expirySeconds?: number }) => {
      this.#enter('createInvoice');
      const preimage = randomBytes(32).toString('hex');
      const paymentHash = sha256hex(preimage);
      const expirySeconds = request.expirySeconds ?? 3600;
      this.#world.invoices.set(paymentHash, { owner: this.pubkey, preimage, amount: request.amount, paid: false });
      return {
        paymentHash: parsePaymentHash(paymentHash),
        bolt11: fakeBolt11(this.#options.network, request.amount, paymentHash, expirySeconds),
        amount: request.amount,
        description: untrustedText(request.description),
        label: request.label,
        status: 'unpaid' as const,
        expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
      };
    },
  };

  readonly pay = {
    getPayment: async (paymentHash: PaymentHash) => {
      this.#enter('getPayment');
      return this.#payments.get(paymentHash);
    },
    pay: async (request: { bolt11: string; maxFee: Msat; label: string; retryForSeconds: number }) => {
      if (!this.#options.canSpend) throw new AdapterError({ code: 'permission_denied', sent: false, definitive: true });
      this.#enter('pay');
      const decoded = readBolt11(request.bolt11);
      const invoice = this.#world.invoices.get(decoded.paymentHash);
      // An invoice no fake node issued has no route: the node definitely paid nothing.
      if (!invoice || invoice.owner === this.pubkey) {
        throw new AdapterError({ code: 'payment_failed', sent: true, definitive: true, nodeCode: 205 });
      }
      if (invoice.paid) throw new AdapterError({ code: 'node_error', sent: true, definitive: false, nodeCode: 219 });
      invoice.paid = true;
      this.#local = msat(this.#local - invoice.amount);
      const payment: Payment = {
        paymentHash: decoded.paymentHash,
        status: 'succeeded',
        amount: invoice.amount,
        amountSent: invoice.amount,
        preimage: invoice.preimage,
        label: request.label,
      };
      this.#payments.set(decoded.paymentHash, payment);
      return {
        paymentHash: decoded.paymentHash,
        preimage: invoice.preimage,
        amount: invoice.amount,
        amountSent: invoice.amount,
        fee: ZERO,
      };
    },
  };

  // Test helper: has this invoice (made by this fake) been paid?
  isPaid(paymentHash: string): boolean {
    return this.#world.invoices.get(paymentHash)?.paid === true;
  }
}
