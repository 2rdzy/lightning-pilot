// Receive (walking skeleton): a BOLT11 invoice for an amount in sats, shown as QR code and text with a copy button.
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { Amount, Card, CopyButton, ErrorNote, Field } from '../../shell/parts.tsx';
import { QrCode } from '@lightning-pilot/ui';
import { nodeRoute } from '../../app/router.tsx';
import { formatDateTime, formatSats, parseSatsInput } from '../../i18n/format.ts';

interface ReceiveForm {
  amount: string;
  description: string;
}

export function ReceiveScreen() {
  const tr = useT();
  const api = useApi();
  const { node } = nodeRoute.useLoaderData();
  const form = useForm<ReceiveForm>({ defaultValues: { amount: '', description: '' } });
  const create = useMutation({
    mutationFn: (v: { amount: bigint; description: string }) =>
      api.call('createInvoice', {
        userActivity: true,
        params: { nodeId: node.id },
        body: { amount: v.amount.toString(), description: v.description },
      }),
  });
  const parsed = parseSatsInput(form.watch('amount'), tr.locale);
  const invoice = create.data;

  if (invoice) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">{tr.t('receive.title')}</h1>
        <p role="status" className="text-success font-medium">
          {tr.t('receive.created')}
        </p>
        <Card title={tr.t('receive.invoice')}>
          <div className="flex flex-col items-start gap-4 md:flex-row">
            <QrCode value={invoice.bolt11} label={tr.t('receive.qr')} />
            <div className="flex min-w-0 flex-col gap-3">
              <p className="text-2xl font-semibold">
                {invoice.amount ? <Amount msat={invoice.amount} testId="invoice-amount" /> : null}
              </p>
              <p className="text-muted text-sm">
                {tr.t('receive.expires', { time: formatDateTime(invoice.expiresAt, tr.locale) })}
              </p>
              <p className="font-mono text-xs break-all" data-testid="bolt11">
                {invoice.bolt11}
              </p>
              <div className="flex gap-2">
                <CopyButton value={invoice.bolt11} />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    create.reset();
                    form.reset();
                  }}
                >
                  {tr.t('receive.another')}
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <h1 className="text-2xl font-semibold">{tr.t('receive.title')}</h1>
      <form
        className="rounded-card border-border bg-surface flex flex-col gap-4 border p-4"
        noValidate
        onSubmit={form.handleSubmit((v) => {
          const amount = parseSatsInput(v.amount, tr.locale);
          if (amount !== undefined && amount > 0n) create.mutate({ amount, description: v.description });
        })}
      >
        <Field
          label={tr.t('receive.amount')}
          htmlFor="amount"
          error={form.formState.errors.amount ? tr.t('receive.amountInvalid') : undefined}
          {...(parsed !== undefined && parsed > 0n
            ? { hint: tr.t('receive.amountReadBack', { amount: formatSats(parsed, tr.locale) }) }
            : {})}
        >
          <input
            id="amount"
            className="input tabular-nums"
            inputMode="numeric"
            autoComplete="off"
            {...form.register('amount', {
              validate: (text) => {
                const value = parseSatsInput(text, tr.locale);
                return value !== undefined && value > 0n;
              },
            })}
          />
        </Field>
        <Field label={tr.t('receive.description')} htmlFor="description">
          <input id="description" className="input" maxLength={640} {...form.register('description')} />
        </Field>
        {create.error ? <ErrorNote error={create.error} /> : null}
        <button type="submit" className="btn-primary self-start" disabled={create.isPending}>
          {tr.t('receive.submit')}
        </button>
      </form>
    </div>
  );
}
