// The server owns stage order and draft state; the browser keeps enrolment secrets only while this screen is open.
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Password,
  AddNodeRequest as NodeSchema,
  type SetupAction,
  type SetupProgress,
  type SetupLimits,
} from '@lightning-pilot/core';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { ErrorNote, Field } from '../../app/parts.tsx';
import { QrCode } from '../../app/qr.tsx';
import { generatePassword } from './password.ts';
import { limitsInOrder } from './limits.ts';

export function SetupScreen() {
  const tr = useT();
  const api = useApi();
  const navigate = useNavigate();
  const [progress, setProgress] = useState<SetupProgress>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const step = progress?.step ?? 'start';
  const field = (name: string, label: string, type = 'text', hint?: string) => (
    <Field key={name} htmlFor={name} label={tr.t(label)} {...(hint ? { hint: tr.t(hint) } : {})}>
      <input
        id={name}
        type={type}
        className="input"
        autoComplete={name === 'password' || name === 'confirm' ? 'new-password' : 'off'}
        value={values[name] ?? ''}
        onChange={(e) => setValues({ ...values, [name]: e.target.value })}
      />
    </Field>
  );
  const act = async (action: SetupAction) => {
    setBusy(true);
    setError(undefined);
    setNote('');
    try {
      const reply = await api.call('setup', {
        userActivity: true,
        body: action,
        ...(progress ? { setupCsrfToken: progress.csrfToken } : {}),
      });
      setProgress(reply);
      setValues({});
      if (reply.step === 'limits')
        setValues(
          reply.defaultLimits
            ? {
                maxFeeRate: reply.defaultLimits.maxFeeRate,
                maxFeeSharePercent: '5',
                maxRoutingFeeSharePercent: '1',
                routingFeeAllowance: '10',
              }
            : { maxFeeSharePercent: '5', maxRoutingFeeSharePercent: '1', routingFeeAllowance: '10' },
        );
      if (reply.step === 'done' && reply.session) {
        api.setCsrfToken(reply.session.csrfToken);
        await navigate({ to: '/', replace: true });
      }
      if (reply.step === 'cancelled') {
        setProgress(undefined);
        api.setCsrfToken(undefined);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (step === 'start') return act({ action: 'start', token: values.token ?? '' });
    if (step === 'password') {
      if (values.password !== values.confirm) {
        setNote(tr.t('setup.mismatch'));
        return;
      }
      if (!Password.safeParse(values.password).success) {
        setNote(tr.t('setup.passwordRules'));
        return;
      }
      return act({ action: 'password', password: values.password ?? '' });
    }
    if (step === 'totp') return act({ action: 'totp', code: values.code ?? '' });
    if (step === 'recovery') return act({ action: 'recovery', code: values.code ?? '' });
    if (step === 'backup') {
      if (values.backup !== 'yes') {
        setNote(tr.t('setup.backupRequired'));
        return;
      }
      return act({ action: 'backup', confirmed: true });
    }
    if (step === 'node') {
      try {
        const node = NodeSchema.parse({
          name: values.name,
          chain: values.chain ?? 'blake2b',
          network: values.network ?? 'mainnet',
          implementation: 'cln',
          url: values.url,
          caCertificate: values.caCertificate,
          serverName: values.serverName || 'localhost',
          viewRune: values.viewRune,
          ...(values.spendRune ? { spendRune: values.spendRune } : {}),
        });
        return act({ action: 'node', node });
      } catch {
        setNote(tr.t('setup.nodeInvalid'));
        return;
      }
    }
    if (step === 'limits') {
      const nullable = (key: string) => values[key]?.trim() || null;
      const limits: SetupLimits = {
        maxFeeRateMode: values.maxFeeRateMode === 'step-up' ? 'step-up' : 'refuse',
        maxFeeShareMode: values.maxFeeShareMode === 'step-up' ? 'step-up' : 'refuse',
        maxRoutingFeeMode: values.maxRoutingFeeMode === 'step-up' ? 'step-up' : 'refuse',
        maxPerPayment: nullable('maxPerPayment'),
        max24h: nullable('max24h'),
        stepUpAbove: nullable('stepUpAbove'),
        maxFeeRate: values.maxFeeRate ?? '',
        maxFeeSharePercent: Number(values.maxFeeSharePercent),
        maxRoutingFeeSharePercent: Number(values.maxRoutingFeeSharePercent),
        routingFeeAllowance: values.routingFeeAllowance ?? '',
      };
      if (!limitsInOrder(limits)) {
        setNote(tr.t('setup.limitsOrder'));
        return;
      }
      return act({ action: 'limits', limits });
    }
    if (step === 'alerts') {
      if (values.alertKind === 'nostr')
        return act({
          action: 'alerts',
          alerts: {
            kind: 'nostr',
            recipient: values.recipient ?? '',
            relays: (values.relays ?? '').split(/\s+/).filter(Boolean),
          },
        });
      if (values.alertKind === 'telegram')
        return act({ action: 'alerts', alerts: { kind: 'telegram', botToken: values.botToken ?? '' } });
      if (values.alertKind === 'none') return act({ action: 'alerts', alerts: { kind: 'none' } });
      setNote(tr.t('setup.chooseAlerts'));
      return;
    }
    if (step === 'complete') return act({ action: 'complete' });
  };
  const downloadCodes = () => {
    const url = URL.createObjectURL(
      new Blob([(progress?.recoveryCodes ?? []).join('\n') + '\n'], { type: 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lightning-pilot-recovery-codes.txt';
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking in the same tick can cancel the download in Firefox and Safari; the codes are on screen anyway.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-6 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{tr.t('setup.title')}</h1>
      <p>{tr.t('setup.intro')}</p>
      <form
        className="rounded-card border-border bg-surface flex flex-col gap-4 border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-lg font-semibold">{tr.t(`setup.step.${step}`)}</h2>
        {step === 'start' ? field('token', 'setup.token') : null}
        {step === 'password' ? (
          <>
            {field('password', 'setup.password', 'password', 'setup.passwordRules')}
            {field('confirm', 'setup.confirm', 'password')}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                const password = generatePassword();
                setValues({ password, confirm: password });
              }}
            >
              {tr.t('setup.generate')}
            </button>
          </>
        ) : null}
        {step === 'totp' ? (
          <>
            {progress?.uri ? (
              <QrCode value={progress.uri} label={tr.t('setup.totpQr')} preserveCase />
            ) : (
              <p>{tr.t('setup.restartHint')}</p>
            )}
            <code data-testid="totp-secret">{progress?.secret}</code>
            {field('code', 'setup.totpCode')}
          </>
        ) : null}
        {step === 'recovery' ? (
          <>
            <p>{tr.t('setup.recoveryHint')}</p>
            <ul data-testid="recovery-codes" className="font-mono">
              {progress?.recoveryCodes?.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <button type="button" className="btn-secondary" onClick={downloadCodes}>
              {tr.t('setup.download')}
            </button>
            {field('code', 'setup.recoveryCode')}
          </>
        ) : null}
        {step === 'backup' ? (
          <>
            <p>{tr.t('setup.backupHint')}</p>
            <code>{progress?.vaultKeyId}</code>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={values.backup === 'yes'}
                onChange={(e) => setValues({ backup: e.target.checked ? 'yes' : '' })}
              />
              {tr.t('setup.backup')}
            </label>
          </>
        ) : null}
        {step === 'node' ? (
          <>
            <p>{tr.t('setup.nodeHint')}</p>
            {field('name', 'setup.nodeName')}
            <label>
              {tr.t('setup.chain')}
              <select
                className="input"
                value={values.chain ?? 'blake2b'}
                onChange={(e) => setValues({ ...values, chain: e.target.value })}
              >
                <option value="blake2b">{tr.t('chain.blake2b')}</option>
                <option value="bitcoin">{tr.t('chain.bitcoin')}</option>
              </select>
            </label>
            <label>
              {tr.t('setup.network')}
              <select
                className="input"
                value={values.network ?? 'mainnet'}
                onChange={(e) => setValues({ ...values, network: e.target.value })}
              >
                {['mainnet', 'testnet4', 'signet', 'regtest'].map((network) => (
                  <option key={network}>{network}</option>
                ))}
              </select>
            </label>
            {field('url', 'setup.nodeUrl')}
            <Field htmlFor="caCertificate" label={tr.t('setup.nodeCa')}>
              <textarea
                id="caCertificate"
                className="input font-mono"
                value={values.caCertificate ?? ''}
                onChange={(e) => setValues({ ...values, caCertificate: e.target.value })}
              />
            </Field>
            {field('viewRune', 'setup.nodeViewRune', 'password')}
            {field('spendRune', 'setup.nodeSpendRune', 'password')}
            {field('serverName', 'setup.nodeServerName')}
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => void act({ action: 'node', node: null })}
            >
              {tr.t('setup.skipNode')}
            </button>
          </>
        ) : null}
        {step === 'limits' ? (
          <>
            <p>{tr.t('setup.limitsScope')}</p>
            {progress?.feeEstimateAvailable === false ? <p>{tr.t('setup.noFeeEstimate')}</p> : null}
            {field('maxPerPayment', 'setup.maxPerPayment', 'text', 'setup.noLimit')}
            {field('max24h', 'setup.max24h', 'text', 'setup.noLimit')}
            {field('stepUpAbove', 'setup.stepUpAbove', 'text', 'setup.noLimit')}
            {field('maxFeeRate', 'setup.maxFeeRate')}
            {field('maxFeeSharePercent', 'setup.maxFeeSharePercent')}
            {field('maxRoutingFeeSharePercent', 'setup.maxRoutingFeeSharePercent')}
            {field('routingFeeAllowance', 'setup.routingFeeAllowance')}
            {(['maxFeeRateMode', 'maxFeeShareMode', 'maxRoutingFeeMode'] as const).map((key) => (
              <label key={key}>
                {tr.t(`setup.${key}`)}
                <select
                  className="input"
                  value={values[key] ?? 'refuse'}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                >
                  <option value="refuse">{tr.t('setup.feeRefuse')}</option>
                  <option value="step-up">{tr.t('setup.feeStepUp')}</option>
                </select>
              </label>
            ))}
          </>
        ) : null}
        {step === 'alerts' ? (
          <>
            <p>{tr.t('setup.alertsPending')}</p>
            <label>
              {tr.t('setup.alertKind')}
              <select
                className="input"
                value={values.alertKind ?? ''}
                onChange={(e) => setValues({ alertKind: e.target.value })}
              >
                <option value="">{tr.t('setup.select')}</option>
                <option value="none">{tr.t('setup.noAlerts')}</option>
                <option value="nostr">Nostr</option>
                <option value="telegram">Telegram</option>
              </select>
            </label>
            {values.alertKind === 'nostr' ? (
              <>
                {field('recipient', 'setup.nostrRecipient')}
                {field('relays', 'setup.nostrRelays')}
              </>
            ) : null}
            {values.alertKind === 'telegram' ? field('botToken', 'setup.telegramToken', 'password') : null}
          </>
        ) : null}
        {step === 'complete' ? <p>{tr.t('setup.finishHint')}</p> : null}
        {note ? <p role="alert">{note}</p> : null}
        {error ? <ErrorNote error={error} /> : null}
        <button className="btn-primary self-start" disabled={busy} type="submit">
          {tr.t(step === 'complete' ? 'setup.submit' : 'setup.continue')}
        </button>
        {progress ? (
          <button
            className="btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => void act({ action: 'cancel' })}
          >
            {tr.t('setup.restart')}
          </button>
        ) : null}
      </form>
    </main>
  );
}
