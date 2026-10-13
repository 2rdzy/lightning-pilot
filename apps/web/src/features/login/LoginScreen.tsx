// Login with the owner password; afterwards back to the route that asked for it (a path inside the app only).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { ErrorNote, Field } from '../../app/parts.tsx';
import { loginRoute } from '../../app/router.tsx';

export function LoginScreen() {
  const tr = useT();
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { next } = loginRoute.useSearch();
  const [recovery, setRecovery] = useState(false);
  const form = useForm<{ password: string; totpCode: string; recoveryCode: string }>({
    defaultValues: { password: '', totpCode: '', recoveryCode: '' },
    shouldUnregister: true,
  });
  const login = useMutation({
    mutationFn: (body: { password: string; totpCode: string; recoveryCode: string }) =>
      api.call('login', {
        body: {
          password: body.password,
          ...(recovery ? { recoveryCode: body.recoveryCode } : { totpCode: body.totpCode }),
        },
      }),
    onSuccess: async (session) => {
      api.setCsrfToken(session.csrfToken, session.recoveryRequired);
      queryClient.clear();
      // Replace the login entry: its ?next= may hold a payment request, which must not stay in the history.
      await navigate({ href: session.recoveryRequired ? '/recover' : (next ?? '/'), replace: true });
    },
  });

  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-6 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{tr.t('login.title')}</h1>
      <form
        className="rounded-card border-border bg-surface flex flex-col gap-4 border p-4"
        onSubmit={form.handleSubmit((v) => login.mutate(v))}
        noValidate
      >
        <Field
          label={tr.t('login.password')}
          htmlFor="password"
          error={form.formState.errors.password ? tr.t('login.required') : undefined}
        >
          <input
            id="password"
            type="password"
            className="input"
            autoComplete="current-password"
            {...form.register('password', { required: true })}
          />
        </Field>
        <label className="flex gap-2">
          <input type="checkbox" checked={recovery} onChange={(e) => setRecovery(e.target.checked)} />
          {tr.t('login.useRecovery')}
        </label>
        {recovery ? (
          <Field label={tr.t('login.recoveryCode')} htmlFor="recoveryCode">
            <input
              id="recoveryCode"
              className="input"
              autoComplete="off"
              {...form.register('recoveryCode', { required: recovery })}
            />
          </Field>
        ) : (
          <Field label={tr.t('login.totpCode')} htmlFor="totpCode">
            <input
              id="totpCode"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              {...form.register('totpCode', { required: !recovery })}
            />
          </Field>
        )}
        {login.error ? <ErrorNote error={login.error} /> : null}
        <button type="submit" className="btn-primary self-start" disabled={login.isPending}>
          {tr.t('login.submit')}
        </button>
      </form>
    </main>
  );
}
