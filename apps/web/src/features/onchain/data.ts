// On-chain wallet (catalogue B1, B2, B6, F3, F4): reads, search params and the small pure helpers of the on-chain
// screens. The node lists its wallet transactions newest first, paged by an offset over a list it sorts again on
// every call (read API, WP14b), so a new transaction shifts the rows between two pages: every read starts from the
// top and rows are de-duplicated by txid. Only a bounded number of rows is read.
import type { Chain, Network, OnchainTxPage, UtxoList } from '@lightning-pilot/core';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, type ApiClient } from '../../api/client.ts';

// Rows per request (the read API's maximum), rows per "load more" step, and the most rows the screens read.
export const READ_LIMIT = 200;
export const STEP_ROWS = 50;
export const MAX_ROWS = 2000;

export type OnchainTx = z.infer<typeof OnchainTxPage>['items'][number];
export type Utxo = z.infer<typeof UtxoList>['items'][number];

export const TxidSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const KINDS = ['receive', 'send', 'channel-open', 'channel-close', 'other'] as const;

export const OnchainSearch = z.object({
  kind: z.enum(['all', ...KINDS]).catch('all'),
  sort: z.enum(['-height', 'height', '-amount', 'amount']).catch('-height'),
  // Load-more steps beyond the first (each shows STEP_ROWS more rows).
  more: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_ROWS / STEP_ROWS - 1)
    .catch(0),
});
export type OnchainSearch = z.infer<typeof OnchainSearch>;

// The send form may be prefilled by a link (style guide §7): an address and an amount in sats. The router hands
// over JSON-parsed values (`amount=1000` arrives as a number), so both are read as text. A link never sends.
export function sendSearch(search: Record<string, unknown>): { address?: string; amount?: string } {
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  const address = text(search.address).trim(),
    amount = text(search.amount).trim();
  return {
    ...(address && address.length <= 200 ? { address } : {}),
    ...(/^[0-9]{1,16}$/.test(amount) ? { amount } : {}),
  };
}

// Reads up to `rows` distinct transactions, newest first. `more` tells whether the node has more beyond them.
export async function readTransactions(
  read: (cursor?: string) => Promise<{ items: OnchainTx[]; nextCursor?: string | undefined }>,
  rows: number,
  stop?: (tx: OnchainTx) => boolean,
): Promise<{ items: OnchainTx[]; more: boolean }> {
  const items: OnchainTx[] = [];
  const seen = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await read(cursor);
    for (const tx of page.items) {
      if (seen.has(tx.txid)) continue;
      seen.add(tx.txid);
      items.push(tx);
      if (stop?.(tx)) return { items, more: false };
    }
    if (page.nextCursor === undefined) return { items: items.slice(0, rows), more: items.length > rows };
    if (items.length >= rows) return { items: items.slice(0, rows), more: true };
    if (cursors.has(page.nextCursor)) throw new ApiError('bad_response', 'Repeated transaction cursor', 0);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

const readPage = (api: ApiClient, nodeId: string) => (cursor?: string) =>
  api.call('onchainTransactions', { params: { nodeId }, query: { limit: READ_LIMIT, cursor } });

export const transactionsQuery = (api: ApiClient, nodeId: string, more: number) =>
  queryOptions({
    queryKey: ['onchain-transactions', nodeId, more],
    queryFn: () => readTransactions(readPage(api, nodeId), (more + 1) * STEP_ROWS),
  });

// One transaction: there is no detail route (read API rule 7), so the newest MAX_ROWS are searched for it.
export const transactionQuery = (api: ApiClient, nodeId: string, txid: string) =>
  queryOptions({
    queryKey: ['onchain-transactions', nodeId, 'tx', txid],
    queryFn: async () => {
      const { items } = await readTransactions(readPage(api, nodeId), MAX_ROWS, (tx) => tx.txid === txid);
      return { tx: items.find((tx) => tx.txid === txid) ?? null };
    },
  });

export const utxosQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({ queryKey: ['utxos', nodeId], queryFn: () => api.call('utxos', { params: { nodeId } }) });

export const feesQuery = (api: ApiClient, nodeId: string) =>
  queryOptions({
    queryKey: ['fee-estimates', nodeId],
    queryFn: () => api.call('feeEstimates', { params: { nodeId } }),
  });

// The signed amount of a transaction for sorting: received positive, sent negative, unknown as zero.
function signed(tx: OnchainTx): bigint {
  if (!tx.amount) return 0n;
  const value = BigInt(tx.amount.value);
  return tx.amount.direction === 'in' ? value : -value;
}

export function filterTransactions(rows: readonly OnchainTx[], kind: string, sort: string): OnchainTx[] {
  const direction = sort.startsWith('-') ? -1 : 1;
  // Node order is newest first; unconfirmed rows have no height and stay on top when newest first.
  const order = new Map(rows.map((tx, i) => [tx.txid, i]));
  const position = (tx: OnchainTx) => order.get(tx.txid) ?? 0;
  return rows
    .filter((tx) => kind === 'all' || tx.kind === kind)
    .sort((a, b) => {
      if (sort.endsWith('amount')) {
        const x = signed(a),
          y = signed(b);
        if (x !== y) return direction * (x < y ? -1 : 1);
        return position(a) - position(b);
      }
      return direction === -1 ? position(a) - position(b) : position(b) - position(a);
    });
}

// A preset fee rate for the send preview: the node's estimate, rounded up to the three decimals the preview accepts
// (as the server rounds its own default). Undefined when the estimate is not a usable rate.
export function presetRate(value: string | undefined): string | undefined {
  const match = value === undefined ? null : /^([0-9]{1,7})(?:\.([0-9]+))?$/.exec(value);
  if (!match) return undefined;
  const digits = match[2] ?? '';
  let thousandths = BigInt(match[1] as string) * 1000n + BigInt(digits.slice(0, 3).padEnd(3, '0'));
  if (/[1-9]/.test(digits.slice(3))) thousandths += 1n;
  if (thousandths === 0n || thousandths >= 10_000_000_000n) return undefined;
  const fraction = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${thousandths / 1000n}.${fraction}` : `${thousandths / 1000n}`;
}

// Explorer links (F4): only on mainnet, where the chain profiles' default explorers (packages/chain profile.ts,
// which apps/web may not import) know the transactions. Not configurable yet: no setting or API carries one.
const EXPLORERS: Record<Chain, string> = {
  blake2b: 'https://mempool.kilombino.com',
  bitcoin: 'https://mempool.space',
};
export function explorerTxUrl(chain: Chain, network: Network, txid: string): string | undefined {
  if (network !== 'mainnet' || !TxidSchema.safeParse(txid).success) return undefined;
  return `${EXPLORERS[chain]}/tx/${txid}`;
}

// The whole sats of a msat amount, with the msat remainder as three decimals when there is one.
function satsText(msat: string): string {
  const value = BigInt(msat);
  const rest = value % 1000n;
  return rest === 0n ? (value / 1000n).toString() : `${value / 1000n}.${rest.toString().padStart(3, '0')}`;
}

// A CSV cell. Labels are untrusted text: a cell a spreadsheet would read as a formula is prefixed with a quote.
function cell(value: string | number | undefined): string {
  let text = value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const CSV_HEADER = [
  'txid',
  'kind',
  'direction',
  'amount_sat',
  'fee_sat',
  'block_height',
  'confirmations',
  'label',
] as const;

export function transactionsCsv(rows: readonly OnchainTx[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const tx of rows)
    lines.push(
      [
        tx.txid,
        tx.kind,
        tx.amount?.direction,
        tx.amount ? satsText(tx.amount.value) : undefined,
        tx.fee === undefined ? undefined : satsText(tx.fee),
        tx.blockHeight,
        tx.confirmations,
        tx.label,
      ]
        .map(cell)
        .join(','),
    );
  return lines.join('\r\n') + '\r\n';
}

// The wallet's coins created by one transaction.
export function utxosOf(utxos: readonly Utxo[], txid: string): Utxo[] {
  return utxos.filter((u) => u.outpoint.startsWith(`${txid}:`));
}
