// First run: the setup token from the server log and the owner password (setup spec §1–§2). The password rules
// are the shared schema's, so the browser refuses what the server would refuse.
import { zodResolver } from '@hookform/resolvers/zod';
import { SetupRequest } from '@lightning-pilot/core';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { ErrorNote, Field } from '../../app/parts.tsx';

const SetupForm = z
  .object({ token: SetupRequest.shape.token, password: SetupRequest.shape.password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'] });
type SetupForm = z.infer<typeof SetupForm>;

export function SetupScreen() {
  const tr = useT();
  const api = useApi();
  const navigate = useNavigate();
  const form = useForm<SetupForm>({
    resolver: zodResolver(SetupForm),
    defaultValues: { token: '', password: '', confirm: '' },
  });
  const setup = useMutation({
    mutationFn: (v: SetupForm) => api.call('setup', { body: { token: v.token, password: v.password } }),
    onSuccess: () => navigate({ to: '/login', search: {} }),
  });
  const errors = form.formState.errors;

  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-6 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{tr.t('setup.title')}</h1>
      <p className="text-muted">{tr.t('setup.intro')}</p>
      <form
        className="rounded-card border-border bg-surface flex flex-col gap-4 border p-4"
        onSubmit={form.handleSubmit((v) => setup.mutate(v))}
        noValidate
      >
        <Field
          label={tr.t('setup.token')}
          htmlFor="token"
          error={errors.token ? tr.t('setup.tokenRequired') : undefined}
        >
          <input
            id="token"
            className="input font-mono"
            autoComplete="off"
            spellCheck={false}
            {...form.register('token')}
          />
        </Field>
        <Field
          label={tr.t('setup.password')}
          htmlFor="password"
          hint={tr.t('setup.passwordRules')}
          error={errors.password ? tr.t('setup.passwordRules') : undefined}
        >
          <input
            id="password"
            type="password"
            className="input"
            autoComplete="new-password"
            {...form.register('password')}
          />
        </Field>
        <Field
          label={tr.t('setup.confirm')}
          htmlFor="confirm"
          error={errors.confirm ? tr.t('setup.mismatch') : undefined}
        >
          <input
            id="confirm"
            type="password"
            className="input"
            autoComplete="new-password"
            {...form.register('confirm')}
          />
        </Field>
        {setup.error ? <ErrorNote error={setup.error} /> : null}
        <button type="submit" className="btn-primary self-start" disabled={setup.isPending}>
          {tr.t('setup.submit')}
        </button>
      </form>
    </main>
  );
}
