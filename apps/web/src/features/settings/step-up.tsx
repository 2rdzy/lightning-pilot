// Security step-up for the settings screens (sessions §4, §11): changes to credentials, security settings, limits and
// nodes need a live password-plus-TOTP grant, which lasts five minutes and is cleared by a password or TOTP change.
// The screens just run the action; when the server answers `step_up_required` the dialog asks for both factors,
// and the action runs once more after the grant. Cancelling leaves the action undone.
import { StepUpDialog, type StepUpValues } from '@lightning-pilot/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { ErrorNote } from '../../shell/parts.tsx';
import { isStepUpRequired } from './data.ts';

export interface SecurityGuard {
  // The action's result, or undefined when the owner cancelled the step-up.
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  // Asks for a grant without an action first (to show data that needs one); true once granted.
  confirm: () => Promise<boolean>;
  dialog: ReactNode;
}

export function useSecurityGuard(reason?: string): SecurityGuard {
  const api = useApi(),
    tr = useT();
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [badCode, setBadCode] = useState(false);
  const waiting = useRef<((granted: boolean) => void) | undefined>(undefined);

  const settle = (granted: boolean) => {
    const resolve = waiting.current;
    waiting.current = undefined;
    resolve?.(granted);
  };
  // A screen that goes away while the dialog is open must not run its action later.
  useEffect(() => () => settle(false), []);

  const confirm = () =>
    new Promise<boolean>((resolve) => {
      settle(false);
      waiting.current = resolve;
      setError(undefined);
      setBadCode(false);
      setOpen(true);
    });

  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action();
    } catch (err) {
      if (!isStepUpRequired(err)) throw err;
    }
    if (!(await confirm())) return undefined;
    return action();
  };

  const submit = async ({ password, totpCode }: StepUpValues) => {
    setError(undefined);
    // The server would refuse the request shape without counting it; say what is wrong instead.
    setBadCode(!/^[0-9]{6}$/.test(totpCode ?? ''));
    if (!/^[0-9]{6}$/.test(totpCode ?? '')) return;
    setPending(true);
    try {
      await api.call('stepUp', {
        body: { strength: 'security', password, totpCode: totpCode ?? '' },
        userActivity: true,
      });
      setOpen(false);
      settle(true);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  const dialog = (
    <StepUpDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setOpen(false);
        settle(false);
      }}
      reason={reason ?? tr.t('settings.stepUp.reason')}
      needsTotp
      labels={{
        title: tr.t('stepUp.title'),
        password: tr.t('stepUp.password'),
        totp: tr.t('stepUp.totp'),
        submit: tr.t('stepUp.submit'),
        cancel: tr.t('common.cancel'),
        close: tr.t('common.close'),
      }}
      onSubmit={(values) => void submit(values)}
      pending={pending}
      error={
        badCode ? (
          <p role="alert" className="text-sm text-danger">
            {tr.t('settings.stepUp.totpShape')}
          </p>
        ) : error === undefined ? undefined : (
          <ErrorNote error={error} />
        )
      }
    />
  );
  return { run, confirm, dialog };
}
