import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { ErrorNote, Field } from '../../app/parts.tsx';
import { QrCode } from '../../app/qr.tsx';

export function RecoveryScreen() {
  const api = useApi();
  const tr = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const enrol = useMutation({ mutationFn: () => api.call('recoveryEnrol') });
  const confirm = useMutation({
    mutationFn: () => api.call('recoveryConfirm', { body: { code } }),
    onSuccess: async () => {
      const session = await api.call('session');
      api.setCsrfToken(session.csrfToken, session.recoveryRequired);
      queryClient.clear();
      await navigate({ to: '/', replace: true });
    },
  });
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-6 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{tr.t('login.recoverTitle')}</h1>
      <p>{tr.t('login.recoverNote')}</p>
      {enrol.data ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
        >
          <QrCode value={enrol.data.uri} label={tr.t('setup.totpQr')} preserveCase />
          <Field label={tr.t('login.secret')} htmlFor="secret">
            <input id="secret" className="input" value={enrol.data.secret} readOnly autoComplete="off" />
          </Field>
          <Field label={tr.t('login.totpCode')} htmlFor="code">
            <input
              id="code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <button className="btn-primary self-start" disabled={confirm.isPending}>
            {tr.t('login.verify')}
          </button>
        </form>
      ) : (
        <button className="btn-primary self-start" disabled={enrol.isPending} onClick={() => enrol.mutate()}>
          {tr.t('login.enrol')}
        </button>
      )}
      {enrol.data ? (
        <button
          type="button"
          className="btn-secondary self-start"
          disabled={enrol.isPending || confirm.isPending}
          onClick={() => {
            enrol.reset();
            confirm.reset();
            setCode('');
          }}
        >
          {tr.t('login.restartEnrol')}
        </button>
      ) : null}
      {enrol.error || confirm.error ? <ErrorNote error={enrol.error ?? confirm.error} /> : null}
    </main>
  );
}
