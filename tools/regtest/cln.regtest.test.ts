// Contract tests of the CLN adapter against the tools/regtest nodes of one chain (LP_REGTEST_CHAIN), run by the CI
// jobs contract-blake2b and contract-sha256d. Run locally with: LP_REGTEST_CHAIN=blake2b pnpm test:regtest
import { afterAll, describe, expect, it } from 'vitest';
import { createClnAdapter } from '../../packages/adapter-cln/src/index.ts';
import { METHODS } from '../../packages/adapter-cln/src/methods.ts';
import { adapterContract } from '../../packages/adapter-kit/src/contract.ts';
import { checkChainIdentity, PROFILES } from '../../packages/chain/src/index.ts';
import { AdapterError, msat, nodeMethodsFor, parsePubkey, parseTxid } from '../../packages/core/src/index.ts';
import fixtures from '../../packages/core/src/decode/fixtures/regtest-invoices.json' with { type: 'json' };
import {
  blockCount,
  creds,
  invoiceOn,
  isPaidOn,
  nodeUri,
  offerOn,
  payOn,
  profileOf,
  regtest,
  regtestChain,
} from './nodes.ts';

const chain = regtestChain();
if (!chain) throw new Error('set LP_REGTEST_CHAIN to blake2b or sha256d');

const view = creds(chain, 'cln-a', 'view');
const spend = creds(chain, 'cln-a', 'spend');
const sent = new Map<string, Set<string>>();
const record = (command: string, credential: string) => {
  if (!sent.has(credential)) sent.set(credential, new Set());
  sent.get(credential)?.add(command);
};
const connection = { url: view.url, caCertificate: view.caCertificate, serverName: view.serverName };
let counter = 0;
const label = () => `lp-test-${Date.now()}-${counter++}`;

const adapter = createClnAdapter({ ...connection, viewRune: view.rune, spendRune: spend.rune, onCall: record });
const other = nodeUri(chain, 'cln-b');

adapterContract(`cln (${chain})`, async () => ({
  chain: profileOf(chain),
  network: 'regtest',
  adapter,
  viewOnly: createClnAdapter({ ...connection, viewRune: view.rune, onCall: record }),
  other: { pubkey: parsePubkey(other.pubkey), uri: other.uri },
  invoiceElsewhere: async (amount) => invoiceOn(chain, 'cln-c', amount, label()),
  isPaidElsewhere: async (hash) => isPaidOn(chain, 'cln-c', hash),
  payFromElsewhere: async (bolt11) => payOn(chain, 'cln-c', bolt11),
  offerElsewhere: async () => offerOn(chain, 'cln-c'),
  mine: async (blocks) => {
    regtest(chain, 'mine', String(blocks));
    const target = blockCount(chain);
    for (let i = 0; i < 240 && (await adapter.node.getInfo()).blockHeight < target; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  },
  invoiceBit512: PROFILES[profileOf(chain)].invoiceBit512,
}));

describe(`cln adapter on ${chain}: connection and credentials`, () => {
  it('refuses a node whose certificate is not signed by the pinned CA, before sending anything', async () => {
    const other = creds(chain, 'cln-b', 'view');
    const adapter = createClnAdapter({ ...connection, caCertificate: other.caCertificate, viewRune: view.rune });
    await expect(adapter.node.getInfo()).rejects.toMatchObject({ code: 'node_unreachable', sent: false });
  });

  it('refuses a certificate issued for another server name', async () => {
    const adapter = createClnAdapter({ ...connection, serverName: 'example.org', viewRune: view.rune });
    await expect(adapter.node.getInfo()).rejects.toMatchObject({ code: 'node_unreachable', sent: false });
  });

  it('reports nothing listening as unreachable and not sent', async () => {
    const adapter = createClnAdapter({ ...connection, url: 'https://localhost:1', viewRune: view.rune });
    await expect(adapter.node.getInfo()).rejects.toMatchObject({ code: 'node_unreachable', sent: false });
  });

  it('treats a rune that does not allow the command as a definitive refusal', async () => {
    // The view rune in the spend slot: the node refuses xpay (1502) and pays nothing.
    const adapter = createClnAdapter({ ...connection, viewRune: view.rune, spendRune: view.rune });
    const bolt11 = invoiceOn(chain, 'cln-c', 1_000n, label());
    const attempt = adapter.pay.pay({ bolt11, maxFee: msat(1_000n), label: label(), retryForSeconds: 5 });
    await expect(attempt).rejects.toBeInstanceOf(AdapterError);
    await expect(attempt).rejects.toMatchObject({ code: 'node_credential_revoked', sent: true, definitive: true });
  });

  it('the node refuses the view rune for every spend method (credential scopes §4 check 5)', async () => {
    // The view rune in the spend slot: each spend command reaches the node, which refuses it (HTTP 401, 1502) and
    // does nothing.
    const wrong = createClnAdapter({ ...connection, viewRune: view.rune, spendRune: view.rune });
    const peer = nodeUri(chain, 'cln-b');
    const channel = (await adapter.channel.listChannels({ limit: 200 })).items[0];
    if (!channel) throw new Error('no channel');
    const txid = parseTxid('ab'.repeat(32));
    const attempts: Record<string, () => Promise<unknown>> = {
      xpay: () =>
        wrong.pay.pay({
          bolt11: invoiceOn(chain, 'cln-c', 1_000n, label()),
          maxFee: msat(1_000n),
          label: label(),
          retryForSeconds: 5,
        }),
      xkeysend: () =>
        wrong.pay.keysend({
          destination: parsePubkey(peer.pubkey),
          amount: msat(1_000n),
          maxFee: msat(1_000n),
          label: label(),
          retryForSeconds: 5,
        }),
      connect: () => wrong.peer.connect(peer.uri),
      disconnect: () => wrong.peer.disconnect(parsePubkey(peer.pubkey)),
      fundchannel: () => wrong.channel.openChannel({ peer: parsePubkey(peer.pubkey), amount: msat(100_000_000n) }),
      close: () => wrong.channel.closeChannel({ channel: channel.id, force: false }),
      setchannel: () => wrong.channel.setPolicy({ channel: channel.id, feePpm: 1 }),
      txprepare: () =>
        wrong.onchain.prepare({
          outputs: [{ address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', amount: msat(1_000_000n) }],
        }),
      txsend: () => wrong.onchain.send(txid),
      txdiscard: () => wrong.onchain.discard(txid),
      unreserveinputs: () => wrong.onchain.unreserve('cHNidP8BAAoCAAAAAAAAAAAAAA=='),
    };
    expect(Object.keys(attempts).sort()).toEqual(nodeMethodsFor(METHODS, 'spend'));
    for (const [method, attempt] of Object.entries(attempts)) {
      await expect(attempt(), method).rejects.toMatchObject({
        code: 'node_credential_revoked',
        sent: true,
        definitive: true,
        nodeCode: 1502,
      });
    }
  });

  it('classifies a payment with no route as definitively failed once the node confirms nothing went out', async () => {
    const adapter = createClnAdapter({ ...connection, viewRune: view.rune, spendRune: spend.rune });
    // 50 BTC: far more than the node's channels can carry, so xpay finds no route (205).
    const bolt11 = invoiceOn(chain, 'cln-c', 5_000_000_000_000n, label());
    const attempt = adapter.pay.pay({ bolt11, maxFee: msat(1_000n), label: label(), retryForSeconds: 5 });
    await expect(attempt).rejects.toMatchObject({
      code: 'payment_failed',
      sent: true,
      definitive: true,
      nodeCode: 205,
    });
  });
});

describe(`chain identity on ${chain}`, () => {
  const adapter = createClnAdapter({ ...connection, viewRune: view.rune, onCall: record });

  it('confirms the node under its own profile and refuses it under the other', async () => {
    const facts = await adapter.node.getInfo();
    const tip = await adapter.chain.getTipHeader();
    const own = checkChainIdentity({ profile: profileOf(chain), network: 'regtest', facts, tip });
    expect(own).toMatchObject({ state: 'confirmed' });
    const other = profileOf(chain) === 'blake2b' ? 'bitcoin' : 'blake2b';
    const wrong = checkChainIdentity({ profile: other, network: 'regtest', facts, tip });
    expect(wrong).toMatchObject({ state: 'refused', failedCheck: 'software' });
  });
});

// Cross-chain check of the nodes themselves, with an invoice from the other chain committed in the repository: stock
// CLN refuses a BLAKE2b invoice at decode (feature bit 512). Lightning Pilot's own rule on bit 512 comes with the
// complete invoice decoder.
describe.runIf(chain === 'sha256d')('cross-chain invoices on sha256d', () => {
  it('stock CLN refuses a BLAKE2b invoice', () => {
    const blake2bInvoice = fixtures.invoices.find((i) => i.chain === 'blake2b');
    if (!blake2bInvoice) throw new Error('no blake2b fixture');
    // lightning-cli prints the error as JSON on stdout and exits non-zero.
    const failure = (() => {
      try {
        regtest(chain, 'cli', 'cln-b', 'decode', blake2bInvoice.bolt11);
        return '';
      } catch (err) {
        return String((err as { stdout?: unknown }).stdout ?? '');
      }
    })();
    expect(failure).toMatch(/unknown feature bit 512/);
  });
});

afterAll(() => {
  // Two-way check of the method table: the suite above called every command the table lists, each with the
  // credential the table names, and nothing else (the runes allow exactly the table's commands, methods.test.ts).
  for (const credential of ['read', 'spend'] as const) {
    expect([...(sent.get(credential) ?? [])].sort(), credential).toEqual(nodeMethodsFor(METHODS, credential));
  }
});
