// Settings › Security (route map /settings/security, both views; story U10; sessions §11): change the password,
// replace the authenticator and manage the recovery codes. Every change needs a security step-up, and a password or
// authenticator change ends the other sessions and clears this session's grant.
import { Password } from '@lightning-pilot/core';
import { Button, Card, DestructiveConfirm, Field, QrCode, SuccessNote } from '@lightning-pilot/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { formatDateTime } from '../../i18n/format.ts';
import { CopyButton, ErrorNote } from '../../shell/parts.tsx';
import { SettingsPage } from './parts.tsx';
import { useSecurityGuard } from './step-up.tsx';

function PasswordCard() {
  const api = useApi(),
    tr = useT(),
    id = useId();
  const guard = useSecurityGuard(tr.t('settings.security.passwordReason'));
  const [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState('');
  const [note, setNote] = useState<string>(),
    [error, setError] = useState<unknown>(),
    [done, setDone] = useState(false),
    [pending, setPending] = useState(false);
  const submit = async () => {
    setNote(undefined);
    setError(undefined);
    setDone(false);
    if (password !== repeat) return setNote(tr.t('settings.security.passwordMismatch'));
    if (!Password.safeParse(password).success) return setNote(tr.t('settings.security.passwordRule'));
    setPending(true);
    try {
      const result = await guard.run(() =>
        api.call('changePassword', { body: { password }, userActivity: true }).then(() => true),
      );
      if (result) {
        setPassword('');
        setRepeat('');
        setDone(true);
      }
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <Card title={tr.t('settings.security.passwordTitle')}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-muted">{tr.t('settings.security.passwordRule')}</p>
        <Field label={tr.t('settings.security.newPassword')} htmlFor={`${id}-new`}>
          <input
            id={`${id}-new`}
            type="password"
            className="input"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={tr.t('settings.security.repeatPassword')} htmlFor={`${id}-repeat`}>
          <input
            id={`${id}-repeat`}
            type="password"
            className="input"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        {note ? (
          <p role="alert" className="text-sm text-danger">
            {note}
          </p>
        ) : null}
        {error ? <ErrorNote error={error} /> : null}
        {done ? <SuccessNote>{tr.t('settings.security.passwordChanged')}</SuccessNote> : null}
        <Button type="submit" variant="primary" disabled={pending} className="self-start">
          {tr.t('settings.security.changePassword')}
        </Button>
      </form>
      {guard.dialog}
    </Card>
  );
}

function AuthenticatorCard() {
  const api = useApi(),
    tr = useT(),
    id = useId();
  const guard = useSecurityGuard(tr.t('settings.security.totpReason'));
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string; expiresAt: string }>();
  const [code, setCode] = useState(''),
    [error, setError] = useState<unknown>(),
    [done, setDone] = useState(false),
    [pending, setPending] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setError(undefined);
    setPending(true);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const begin = () =>
    act(async () => {
      setDone(false);
      const pendingSeed = await guard.run(() => api.call('changeTotpEnrol', { userActivity: true }));
      if (pendingSeed) setEnrolment(pendingSeed);
    });
  const finish = () =>
    act(async () => {
      const ok = await guard.run(() =>
        api.call('changeTotpConfirm', { body: { code: code.trim() }, userActivity: true }).then(() => true),
      );
      if (!ok) return;
      setEnrolment(undefined);
      setCode('');
      setDone(true);
    });
  return (
    <Card title={tr.t('settings.security.totpTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{tr.t('settings.security.totpIntro')}</p>
        {enrolment ? (
          <>
            <p className="text-sm">{tr.t('settings.security.totpScan')}</p>
            <QrCode value={enrolment.uri} label={tr.t('settings.security.totpQr')} preserveCase testId="totp-qr" />
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm break-all" data-testid="totp-secret">
                {enrolment.secret}
              </code>
              <CopyButton value={enrolment.secret} />
            </div>
            <p className="text-sm text-muted">
              {tr.t('settings.security.totpExpires', { time: formatDateTime(enrolment.expiresAt, tr.locale) })}
            </p>
            <form
              className="flex flex-col gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void finish();
              }}
            >
              <Field label={tr.t('settings.security.totpCode')} htmlFor={`${id}-code`}>
                <input
                  id={`${id}-code`}
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={pending || !/^[0-9]{6}$/.test(code.trim())}>
                  {tr.t('settings.security.totpConfirm')}
                </Button>
                <Button onClick={() => setEnrolment(undefined)}>{tr.t('common.cancel')}</Button>
              </div>
            </form>
          </>
        ) : (
          <Button onClick={() => void begin()} disabled={pending} className="self-start">
            {tr.t('settings.security.totpBegin')}
          </Button>
        )}
        {error ? <ErrorNote error={error} /> : null}
        {done ? <SuccessNote>{tr.t('settings.security.totpChanged')}</SuccessNote> : null}
      </div>
      {guard.dialog}
    </Card>
  );
}

function RecoveryCard() {
  const api = useApi(),
    tr = useT();
  const guard = useSecurityGuard(tr.t('settings.security.recoveryReason'));
  const [remaining, setRemaining] = useState<number>();
  const [codes, setCodes] = useState<string[]>();
  const [confirming, setConfirming] = useState(false),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const urls = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const act = async (fn: () => Promise<void>) => {
    setError(undefined);
    setPending(true);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const count = () =>
    act(async () => {
      const result = await guard.run(() => api.call('recoveryCount', { userActivity: true }));
      if (result) setRemaining(result.remaining);
    });
  const regenerate = () =>
    act(async () => {
      setConfirming(false);
      const result = await guard.run(() => api.call('regenerateRecoveryCodes', { userActivity: true }));
      if (!result) return;
      setCodes(result.codes);
      setRemaining(result.codes.length);
    });
  const download = () => {
    if (!codes) return;
    const url = URL.createObjectURL(new Blob([codes.join('\n') + '\n'], { type: 'text/plain' }));
    urls.current.add(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lightning-pilot-recovery-codes.txt';
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking in the same tick can cancel the download in Firefox and Safari; the codes are on screen anyway.
    setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }, 10_000);
  };
  return (
    <Card title={tr.t('settings.security.recoveryTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{tr.t('settings.security.recoveryIntro')}</p>
        {remaining === undefined ? (
          <Button onClick={() => void count()} disabled={pending} className="self-start">
            {tr.t('settings.security.recoveryShow')}
          </Button>
        ) : (
          <p className="text-sm" data-testid="recovery-remaining">
            {tr.plural('settings.security.recoveryRemaining', remaining)}
          </p>
        )}
        {codes ? (
          <div className="flex flex-col gap-3 rounded-control border border-warning p-3">
            <p className="text-sm">{tr.t('settings.security.recoveryNew')}</p>
            <ul data-testid="recovery-codes" className="grid grid-cols-2 gap-1 font-mono text-sm">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button onClick={download}>{tr.t('settings.security.recoveryDownload')}</Button>
              <Button onClick={() => setCodes(undefined)}>{tr.t('settings.security.recoverySaved')}</Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setConfirming(true)} disabled={pending} className="self-start">
            {tr.t('settings.security.recoveryRegenerate')}
          </Button>
        )}
        {error ? <ErrorNote error={error} /> : null}
      </div>
      <DestructiveConfirm
        open={confirming}
        onOpenChange={setConfirming}
        title={tr.t('settings.security.recoveryRegenerate')}
        consequences={tr.t('settings.security.recoveryConsequences')}
        confirmLabel={tr.t('settings.security.recoveryRegenerateConfirm')}
        cancelLabel={tr.t('common.cancel')}
        onConfirm={() => void regenerate()}
        pending={pending}
      />
      {guard.dialog}
    </Card>
  );
}

export function SecurityScreen() {
  const tr = useT();
  return (
    <SettingsPage title={tr.t('settings.security.title')} intro={tr.t('settings.security.intro')}>
      <PasswordCard />
      <AuthenticatorCard />
      <RecoveryCard />
    </SettingsPage>
  );
}
