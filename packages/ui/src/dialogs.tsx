// Dialogs (style guide §6, §9): Base UI traps focus inside and returns it on close; Escape and the close button
// close them. A dialog that starts an action has its own route (§7), so the screen controls `open` from the URL.
// Three kinds: a plain dialog, the destructive confirmation (a second step that repeats what will happen) and the
// step-up dialog (password, and the authenticator code where required, with the reason).
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { TriangleAlert, X } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Field } from './Card.tsx';

const BACKDROP = 'fixed inset-0 z-40 bg-black/40';
const POPUP =
  'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 ' +
  '-translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-card border border-border bg-surface p-6 text-text shadow-float';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  closeLabel: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={BACKDROP} />
        <BaseDialog.Popup className={POPUP} data-testid={testId}>
          <div className="flex items-start justify-between gap-4">
            <BaseDialog.Title className="text-xl font-semibold">{title}</BaseDialog.Title>
            <BaseDialog.Close
              aria-label={closeLabel}
              title={closeLabel}
              className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted hover:text-text"
            >
              <X size={20} aria-hidden="true" />
            </BaseDialog.Close>
          </div>
          {description ? (
            <BaseDialog.Description className="text-sm text-muted">{description}</BaseDialog.Description>
          ) : null}
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

// The second confirmation of a destructive action: it repeats what will happen, and the confirm button is --danger
// with an icon and the explicit action ("Force close channel"). Cancel holds the initial focus, not the danger button.
export function DestructiveConfirm({
  open,
  onOpenChange,
  title,
  consequences,
  confirmLabel,
  cancelLabel,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  consequences: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={BACKDROP} />
        <AlertDialog.Popup className={POPUP} initialFocus={cancel} data-testid="destructive-confirm">
          <AlertDialog.Title className="flex items-center gap-2 text-xl font-semibold">
            <TriangleAlert size={20} aria-hidden="true" className="text-danger" />
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm">{consequences}</AlertDialog.Description>
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialog.Close
              ref={cancel}
              className="inline-flex min-h-11 items-center rounded-control border border-border bg-surface px-4 py-2 text-sm"
            >
              {cancelLabel}
            </AlertDialog.Close>
            <Button
              variant="danger"
              icon={<TriangleAlert size={16} />}
              onClick={onConfirm}
              disabled={pending}
              data-testid="destructive-confirm-button"
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export interface StepUpLabels {
  title: string;
  password: string;
  totp: string;
  submit: string;
  cancel: string;
  close: string;
}

export interface StepUpValues {
  password: string;
  totpCode?: string;
}

// Asks for the password (and the authenticator code when `needsTotp`) before a sensitive action, and says why
// ("Payments above 100 000 sat need your password"). The caller sends the values and passes any refusal back as
// `error`, already translated; the fields are cleared when the dialog closes, so a secret never stays in the page.
export function StepUpDialog({
  open,
  onOpenChange,
  reason,
  needsTotp,
  labels,
  onSubmit,
  pending = false,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: string;
  needsTotp: boolean;
  labels: StepUpLabels;
  onSubmit: (values: StepUpValues) => void;
  pending?: boolean;
  error?: ReactNode;
}) {
  const id = useId();
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const change = (next: boolean) => {
    if (!next) {
      setPassword('');
      setTotpCode('');
    }
    onOpenChange(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(needsTotp ? { password, totpCode } : { password });
  };
  return (
    <Dialog open={open} onOpenChange={change} title={labels.title} description={reason} closeLabel={labels.close}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate data-testid="step-up">
        <Field label={labels.password} htmlFor={`${id}-password`}>
          <input
            id={`${id}-password`}
            type="password"
            className="input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {needsTotp ? (
          <Field label={labels.totp} htmlFor={`${id}-totp`}>
            <input
              id={`${id}-totp`}
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
            />
          </Field>
        ) : null}
        {error}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => change(false)}>{labels.cancel}</Button>
          <Button type="submit" variant="primary" disabled={pending || password === ''}>
            {labels.submit}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
