// Parts shared by the settings screens: the frame of a settings page, a "confirm your identity to see this" card,
// the spending-limits fields and the node connection form (add and replace).
import { Button, Card, Field, PageHeader } from '@lightning-pilot/ui';
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';
import { ApiError } from '../../api/client.ts';
import { useT } from '../../app/i18n.tsx';
import { ErrorNote } from '../../shell/parts.tsx';
import {
  ACCESS_LEVELS,
  chosenAccessLevel,
  needsAdminAcknowledgement,
  type FeeMode,
  type NodeForm,
  type PolicyForm,
} from './data.ts';

export function SettingsPage({
  title,
  intro,
  actions,
  back = true,
  children,
}: {
  title: string;
  intro?: string;
  actions?: ReactNode;
  back?: boolean;
  children: ReactNode;
}) {
  const tr = useT();
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      {back ? (
        <Link to="/settings" className="text-sm text-brand-strong underline">
          {tr.t('settings.back')}
        </Link>
      ) : null}
      <PageHeader title={title} actions={actions}>
        {intro ? <p className="text-sm text-muted">{intro}</p> : null}
      </PageHeader>
      {children}
    </div>
  );
}

// Data the server shows only after a security step-up (known devices, recovery-code count, session timeouts).
export function LockedCard({ title, body, onUnlock }: { title: string; body: string; onUnlock: () => void }) {
  const tr = useT();
  return (
    <Card title={title}>
      <p className="mb-3 text-sm text-muted">{body}</p>
      <Button onClick={onUnlock}>{tr.t('settings.unlock')}</Button>
    </Card>
  );
}

// The translated error and, for refusals of a pasted value, the server's own reason (it names the field).
export function FormError({ error }: { error: unknown }) {
  const detail =
    error instanceof ApiError && ['validation_failed', 'permission_denied'].includes(error.code)
      ? error.message
      : undefined;
  return (
    <div className="flex flex-col gap-1">
      <ErrorNote error={error} />
      {detail ? <p className="text-sm text-muted">{detail}</p> : null}
    </div>
  );
}

function FeeModeSelect({ id, value, onChange }: { id: string; value: FeeMode; onChange: (mode: FeeMode) => void }) {
  const tr = useT();
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as FeeMode)}>
      <option value="refuse">{tr.t('settings.limits.refuse')}</option>
      <option value="step-up">{tr.t('settings.limits.stepUp')}</option>
    </select>
  );
}

export function LimitsFields({
  form,
  onChange,
  disabled = false,
}: {
  form: PolicyForm;
  onChange: (form: PolicyForm) => void;
  disabled?: boolean;
}) {
  const tr = useT();
  const id = useId();
  const text = (key: keyof PolicyForm, hint?: string) => (
    <Field
      label={tr.t(`settings.limits.${key}`)}
      htmlFor={`${id}-${key}`}
      hint={hint === undefined ? undefined : tr.t(hint)}
    >
      <input
        id={`${id}-${key}`}
        className="input"
        inputMode="decimal"
        autoComplete="off"
        value={form[key]}
        disabled={disabled}
        onChange={(e) => onChange({ ...form, [key]: e.target.value })}
        data-testid={`limit-${key}`}
      />
    </Field>
  );
  const mode = (key: 'maxFeeRateMode' | 'maxFeeShareMode' | 'maxRoutingFeeMode') => (
    <Field label={tr.t(`settings.limits.${key}`)} htmlFor={`${id}-${key}`}>
      <FeeModeSelect id={`${id}-${key}`} value={form[key]} onChange={(m) => onChange({ ...form, [key]: m })} />
    </Field>
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">{tr.t('settings.limits.scopeNote')}</p>
      <div className="grid gap-4 md:grid-cols-3">
        {text('maxPerPayment', 'settings.limits.noLimit')}
        {text('max24h', 'settings.limits.noLimit')}
        {text('stepUpAbove', 'settings.limits.noStepUp')}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {text('maxFeeRate')}
        {mode('maxFeeRateMode')}
        {text('maxFeeSharePercent')}
        {mode('maxFeeShareMode')}
        {text('maxRoutingFeeSharePercent')}
        {mode('maxRoutingFeeMode')}
        {text('routingFeeAllowance')}
      </div>
    </div>
  );
}

// Connection and credentials of a node. In `replace` mode the chain and network are the node's and cannot change
// (another chain or network is another node, node-management §2).
export function NodeFields({
  form,
  onChange,
  mode,
}: {
  form: NodeForm;
  onChange: (form: NodeForm) => void;
  mode: 'add' | 'replace';
}) {
  const tr = useT();
  const id = useId();
  const set = <K extends keyof NodeForm>(key: K, value: NodeForm[K]) => onChange({ ...form, [key]: value });
  const input = (key: 'name' | 'url' | 'serverName' | 'viewRune' | 'spendRune', hint?: string) => (
    <Field
      label={tr.t(`settings.node.${key}`)}
      htmlFor={`${id}-${key}`}
      hint={hint === undefined ? undefined : tr.t(hint)}
    >
      <input
        id={`${id}-${key}`}
        className={key === 'name' ? 'input' : 'input font-mono'}
        autoComplete="off"
        spellCheck={false}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );
  const area = (key: 'caCertificate' | 'credentialBlock', hint?: string) => (
    <Field
      label={tr.t(`settings.node.${key}`)}
      htmlFor={`${id}-${key}`}
      hint={hint === undefined ? undefined : tr.t(hint)}
    >
      <textarea
        id={`${id}-${key}`}
        className="input min-h-28 font-mono text-xs"
        spellCheck={false}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );
  const level = chosenAccessLevel(form);
  return (
    <div className="flex flex-col gap-4">
      {input('name')}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={tr.t('settings.node.chain')} htmlFor={`${id}-chain`}>
          <select
            id={`${id}-chain`}
            className="input"
            value={form.chain}
            disabled={mode === 'replace'}
            onChange={(e) => set('chain', e.target.value as NodeForm['chain'])}
          >
            <option value="blake2b">{tr.t('settings.chain.blake2b')}</option>
            <option value="bitcoin">{tr.t('settings.chain.bitcoin')}</option>
          </select>
        </Field>
        <Field label={tr.t('settings.node.network')} htmlFor={`${id}-network`}>
          <select
            id={`${id}-network`}
            className="input"
            value={form.network}
            disabled={mode === 'replace'}
            onChange={(e) => set('network', e.target.value as NodeForm['network'])}
          >
            {(['mainnet', 'testnet4', 'signet', 'regtest'] as const).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {input('url', 'settings.node.urlHint')}
      {area('caCertificate', 'settings.node.caHint')}
      {input('serverName', 'settings.node.serverNameHint')}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{tr.t('settings.node.credentialForm')}</legend>
        {(['block', 'runes'] as const).map((choice) => (
          <label key={choice} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              className="size-6"
              name={`${id}-credential-form`}
              checked={form.credentialForm === choice}
              onChange={() => set('credentialForm', choice)}
            />
            {tr.t(`settings.node.credentialForm.${choice}`)}
          </label>
        ))}
      </fieldset>
      {form.credentialForm === 'block' ? (
        area('credentialBlock', 'settings.node.credentialBlockHint')
      ) : (
        <>
          <Field label={tr.t('settings.node.accessLevel')} htmlFor={`${id}-access`}>
            <select
              id={`${id}-access`}
              className="input"
              value={form.accessLevel}
              onChange={(e) => set('accessLevel', e.target.value as NodeForm['accessLevel'])}
            >
              {ACCESS_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {tr.t(`settings.access.${l}`)}
                </option>
              ))}
            </select>
          </Field>
          {input('viewRune')}
          {form.accessLevel === 'read-only' ? null : input('spendRune')}
        </>
      )}
      {needsAdminAcknowledgement(form) ? (
        <div className="flex flex-col gap-2 rounded-control border border-danger p-3" data-testid="admin-warning">
          <p className="text-sm">{tr.t('settings.node.adminWarning')}</p>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-6"
              checked={form.adminAcknowledged}
              onChange={(e) => set('adminAcknowledged', e.target.checked)}
            />
            {tr.t('settings.node.adminAcknowledge')}
          </label>
        </div>
      ) : null}
      {level === 'read-only' ? <p className="text-sm text-muted">{tr.t('settings.node.readOnlyNote')}</p> : null}
    </div>
  );
}
