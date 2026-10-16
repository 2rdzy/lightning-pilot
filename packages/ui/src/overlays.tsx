// Toasts and help tips (style guide §6). Toasts are short confirmations ("Invoice created"); an error that needs
// action stays on the page instead. The "?" help tip opens a one-paragraph explanation of a node term.
import { Popover } from '@base-ui/react/popover';
import { Toast } from '@base-ui/react/toast';
import { CircleHelp, X } from 'lucide-react';
import type { ReactNode } from 'react';

export function ToastProvider({ closeLabel, children }: { closeLabel: string; children: ReactNode }) {
  return (
    <Toast.Provider timeout={5000} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-20 z-50 flex w-[calc(100vw-2rem)] flex-col gap-2 sm:w-96 md:bottom-4">
          <ToastList closeLabel={closeLabel} />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts, close } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className="toast flex items-start gap-3 rounded-card border border-border bg-surface p-3 text-sm text-text shadow-float"
      data-testid="toast"
    >
      <Toast.Content className="flex min-w-0 flex-1 flex-col gap-1">
        <Toast.Title className="font-medium" />
        <Toast.Description className="text-muted" />
      </Toast.Content>
      {/* A plain button, not Toast.Close: Base UI hides that from screen readers until the stack is expanded while
          it stays focusable (axe aria-hidden-focus). */}
      <button
        type="button"
        onClick={() => close(toast.id)}
        aria-label={closeLabel}
        title={closeLabel}
        className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted hover:text-text"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </Toast.Root>
  ));
}

// Shows a toast from any component inside ToastProvider.
export function useToast(): (title: string, description?: string) => void {
  const manager = Toast.useToastManager();
  return (title, description) => {
    manager.add(description === undefined ? { title } : { title, description });
  };
}

export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        title={label}
        className="inline-flex size-6 items-center justify-center rounded-full align-middle text-muted hover:text-text"
      >
        <CircleHelp size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="z-50">
          <Popover.Popup className="max-w-xs rounded-card border border-border bg-surface p-3 text-sm text-text shadow-float">
            <Popover.Title className="mb-1 font-medium">{label}</Popover.Title>
            <Popover.Description>{children}</Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
