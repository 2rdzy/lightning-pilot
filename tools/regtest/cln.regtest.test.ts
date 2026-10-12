// Contract tests of the CLN adapter against the tools/regtest nodes of one chain (LP_REGTEST_CHAIN), run by the CI
// jobs contract-blake2b and contract-sha256d. Run locally with: LP_REGTEST_CHAIN=blake2b pnpm test:regtest
import { afterAll, describe, expect, it } from 'vitest';
import { createClnAdapter } from '../../packages/adapter-cln/src/index.ts';
import { METHODS } from '../../packages/adapter-cln/src/methods.ts';
import { adapterContract } from '../../packages/adapter-kit/src/contract.ts';
import { checkChainIdentity } from '../../packages/chain/src/index.ts';
import { AdapterError, msat, nodeMethodsFor } from '../../packages/core/src/index.ts';
import fixtures from '../../packages/core/src/decode/fixtures/regtest-invoices.json' with { type: 'json' };
import { creds, invoiceOn, isPaidOn, profileOf, regtest, regtestChain } from './nodes.ts';

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

adapterContract(`cln (${chain})`, async () => ({
  chain: profileOf(chain),
  network: 'regtest',
  adapter: createClnAdapter({ ...connection, viewRune: view.rune, spendRune: spend.rune, onCall: record }),
  viewOnly: createClnAdapter({ ...connection, viewRune: view.rune, onCall: record }),
  invoiceElsewhere: async (amount) => invoiceOn(chain, 'cln-c', amount, label()),
  isPaidElsewhere: async (hash) => isPaidOn(chain, 'cln-c', hash),
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
  // Two-way check of the method table, as far as the minimal adapter goes: the suite above called every command
  // the table lists, each with the credential the table names.
  for (const credential of ['read', 'spend'] as const) {
    expect([...(sent.get(credential) ?? [])].sort(), credential).toEqual(nodeMethodsFor(METHODS, credential));
  }
});
