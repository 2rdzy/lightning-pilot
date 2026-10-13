// Connection details of the tools/regtest nodes for tests, read from the script's `creds` output, so the tests use
// the same restricted runes a real installation would. The chain comes from LP_REGTEST_CHAIN (blake2b | sha256d).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Chain } from '../../packages/core/src/index.ts';

export const SCRIPT = fileURLToPath(new URL('./regtest', import.meta.url));

export type RegtestChain = 'blake2b' | 'sha256d';
export type ClnNode = 'cln-a' | 'cln-b' | 'cln-c';

export function regtestChain(): RegtestChain | undefined {
  const value = process.env.LP_REGTEST_CHAIN;
  if (value === undefined || value === '') return undefined;
  if (value !== 'blake2b' && value !== 'sha256d') throw new Error('LP_REGTEST_CHAIN must be blake2b or sha256d');
  return value;
}

// The chain profile Lightning Pilot uses for each regtest chain.
export const profileOf = (chain: RegtestChain): Chain => (chain === 'blake2b' ? 'blake2b' : 'bitcoin');

export function regtest(chain: RegtestChain, ...args: string[]): string {
  return execFileSync(SCRIPT, [chain, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function cli(chain: RegtestChain, node: string, ...args: string[]): unknown {
  return JSON.parse(regtest(chain, 'cli', node, ...args));
}

export interface ClnConnection {
  pubkey: string;
  url: string;
  caCertificate: string;
  serverName: string;
  rune: string;
}

export function creds(chain: RegtestChain, node: ClnNode, level: 'view' | 'spend'): ClnConnection {
  const out = regtest(chain, 'creds', node, level);
  const field = (pattern: RegExp) => {
    const match = pattern.exec(out);
    if (!match?.[1]) throw new Error(`unexpected creds output for ${node}`);
    return match[1];
  };
  return {
    pubkey: field(/node: \S+ \((0[23][0-9a-f]{64})\)/),
    url: field(/^url:\s+(\S+)/m),
    serverName: field(/TLS servername: (\S+)\)/),
    caCertificate: readFileSync(field(/^ca certificate: (\S+)/m), 'utf8'),
    rune: field(/rune:\s+(\S+)$/m),
  };
}

export function invoiceOn(chain: RegtestChain, node: ClnNode, amountMsat: bigint, label: string): string {
  const reply = cli(
    chain,
    node,
    'invoice',
    '-k',
    `amount_msat=${amountMsat}`,
    `label=${label}`,
    'description=test',
  ) as {
    bolt11: string;
  };
  return reply.bolt11;
}

export function isPaidOn(chain: RegtestChain, node: ClnNode, paymentHash: string): boolean {
  const reply = cli(chain, node, 'listinvoices', '-k', `payment_hash=${paymentHash}`) as {
    invoices: { status: string }[];
  };
  return reply.invoices.some((i) => i.status === 'paid');
}

// Pays an invoice from a regtest node (lightning-cli xpay prints a progress line before its JSON).
export function payOn(chain: RegtestChain, node: ClnNode, bolt11: string): void {
  const out = regtest(chain, 'cli', node, 'xpay', bolt11);
  const reply = JSON.parse(out.slice(out.indexOf('{'))) as { payment_preimage?: string };
  if (!reply.payment_preimage) throw new Error(`payment from ${node} failed`);
}

export function offerOn(chain: RegtestChain, node: ClnNode): string {
  return (cli(chain, node, 'offer', '-k', 'amount=any', 'description=test') as { bolt12: string }).bolt12;
}

// The node's key and its peer address as `pubkey@host:port`.
export function nodeUri(chain: RegtestChain, node: ClnNode): { pubkey: string; uri: string } {
  const info = cli(chain, node, 'getinfo') as { id: string; binding: { address: string; port: number }[] };
  const binding = info.binding[0];
  if (!binding) throw new Error(`${node} has no binding`);
  return { pubkey: info.id, uri: `${info.id}@${binding.address}:${binding.port}` };
}

export function blockCount(chain: RegtestChain): number {
  return Number(regtest(chain, 'cli', 'btc', 'getblockcount').trim());
}
