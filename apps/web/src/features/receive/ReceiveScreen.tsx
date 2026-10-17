// Receive (U7, and the on-chain tab of the route map): a BOLT11 invoice for an amount in sats, or a new on-chain
// address. A created invoice opens its own page (/invoices/:hash), so a refresh keeps it and the page follows its
// status live. A new address is made only on a button press, never on load (a route performs no action), and names
// the chain it receives on: addresses look the same on both chains (read API rule 4).
import {
  Button,
  ChainBadge as UiChainBadge,
  PageHeader,
  QrBlock,
  SegmentedControl,
  useToast,
} from '@lightning-pilot/ui';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodeRoute, receiveRoute } from '../../app/router.tsx';
import { formatDateTime, formatSats, parseSatsInput } from '../../i18n/format.ts';
import { Card, ChainBadge, ErrorNote, Field, useCopyLabels } from '../../shell/parts.tsx';

// Invoice lifetimes offered; '' leaves it to the node's default.
const EXPIRIES = ['', '3600', '86400', '604800'] as const;

export function ReceiveScreen() {
  const tr = useT();
  const navigate = useNavigate();
  const { node } = nodeRoute.useLoaderData();
  const tab = receiveRoute.useSearch().tab ?? 'invoice';
  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <PageHeader title={tr.t('receive.title')} />
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label={tr.t('receive.kind')}
          value={tab}
          options={[
            { value: 'invoice', label: tr.t('receive.tab.invoice') },
            { value: 'onchain', label: tr.t('receive.tab.onchain') },
          ]}
          onChange={(next) =>
            void navigate({
              to: '/n/$node/receive',
              params: { node: node.id },
              search: next === 'onchain' ? { tab: next } : {},
              replace: true,
            })
          }
          testId="receive-tab"
        />
        <ChainBadge identity={node.chainIdentity} />
      </div>
      {/* Keyed by node: nothing typed or created for one node stays on screen for another. */}
      {tab === 'invoice' ? <InvoiceForm key={node.id} /> : <NewAddress key={node.id} />}
    </div>
  );
}

function InvoiceForm() {
  const tr = useT();
  const api = useApi();
  const navigate = useNavigate();
  const toast = useToast();
  const { node } = nodeRoute.useLoaderData();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [expiry, setExpiry] = useState<(typeof EXPIRIES)[number]>('');
  const [invalid, setInvalid] = useState(false);
  const create = useMutation({
    mutationFn: (value: bigint) =>
      api.call('createInvoice', {
        userActivity: true,
        params: { nodeId: node.id },
        body: {
          amount: value.toString(),
          description,
          ...(expiry ? { expirySeconds: Number(expiry) } : {}),
        },
      }),
    onSuccess: (invoice) => {
      toast(tr.t('receive.created'));
      void navigate({ to: '/n/$node/invoices/$hash', params: { node: node.id, hash: invoice.paymentHash } });
    },
  });
  const parsed = parseSatsInput(amount, tr.locale);
  return (
    <form
      className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const value = parseSatsInput(amount, tr.locale);
        setInvalid(value === undefined || value === 0n);
        if (value !== undefined && value > 0n) create.mutate(value);
      }}
    >
      <fieldset disabled={create.isPending} className="contents">
        <Field
          label={tr.t('receive.amount')}
          htmlFor="amount"
          error={invalid ? tr.t('receive.amountInvalid') : undefined}
          {...(parsed !== undefined && parsed > 0n
            ? { hint: tr.t('receive.amountReadBack', { amount: formatSats(parsed, tr.locale) }) }
            : {})}
        >
          <input
            id="amount"
            className="input tabular-nums"
            inputMode="numeric"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label={tr.t('receive.description')} htmlFor="description">
          <input
            id="description"
            className="input"
            maxLength={640}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label={tr.t('receive.expiry')} htmlFor="expiry">
          <select
            id="expiry"
            className="input"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as (typeof EXPIRIES)[number])}
          >
            {EXPIRIES.map((value) => (
              <option key={value} value={value}>
                {tr.t(`receive.expiry.${value || 'default'}`)}
              </option>
            ))}
          </select>
        </Field>
        <p className="text-sm text-muted">{tr.t('receive.amountRequired')}</p>
        {create.error ? <ErrorNote error={create.error} /> : null}
        <Button type="submit" variant="primary" className="self-start">
          {tr.t('receive.submit')}
        </Button>
      </fieldset>
    </form>
  );
}

function NewAddress() {
  const tr = useT();
  const api = useApi();
  const copyLabels = useCopyLabels();
  const { node } = nodeRoute.useLoaderData();
  const [type, setType] = useState<'p2wpkh' | 'p2tr'>('p2wpkh');
  const create = useMutation({
    mutationFn: () => api.call('newAddress', { userActivity: true, params: { nodeId: node.id }, body: { type } }),
  });
  const address = create.data;
  return (
    <Card>
      <div className="flex flex-col gap-4">
        <Field label={tr.t('receive.addressType')} htmlFor="address-type">
          <select
            id="address-type"
            className="input"
            value={type}
            disabled={create.isPending}
            onChange={(e) => {
              setType(e.target.value as 'p2wpkh' | 'p2tr');
              create.reset();
            }}
          >
            <option value="p2wpkh">{tr.t('receive.type.p2wpkh')}</option>
            <option value="p2tr">{tr.t('receive.type.p2tr')}</option>
          </select>
        </Field>
        <p className="text-sm text-muted">{tr.t('receive.addressHelp')}</p>
        {create.error ? <ErrorNote error={create.error} /> : null}
        <Button variant="primary" className="self-start" disabled={create.isPending} onClick={() => create.mutate()}>
          {tr.t(address ? 'receive.anotherAddress' : 'receive.newAddress')}
        </Button>
        {address ? (
          <div className="flex flex-col gap-3" data-testid="new-address">
            <div className="flex flex-wrap items-center gap-2">
              <UiChainBadge
                kind={address.chain}
                label={tr.t(`chain.${address.chain}`)}
                title={tr.t('chain.label', { chain: tr.t(`chain.${address.chain}`) })}
              />
              <span className="text-sm">
                {tr.t('receive.addressFor', {
                  chain: tr.t(`receive.chain.${address.chain}`),
                  network: address.network,
                })}
              </span>
            </div>
            <QrBlock
              value={address.address}
              label={tr.t('receive.addressQr')}
              copyLabels={copyLabels}
              textTestId="address"
            />
            <p className="text-sm text-muted">
              {tr.t('receive.addressCreated', { time: formatDateTime(address.createdAt, tr.locale) })}
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
