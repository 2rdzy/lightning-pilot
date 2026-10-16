// Wraps the app once. Base UI's scroll area and select would render inline <style> elements, which the server's CSP
// (style-src 'self') refuses with a console error; they are turned off here and their one rule is in theme.css.
// Also hosts the toast viewport.
import { CSPProvider } from '@base-ui/react/csp-provider';
import { Popover } from '@base-ui/react/popover';
import type { ReactNode } from 'react';
import { ToastProvider } from './overlays.tsx';

export function DesignSystemProvider({ closeLabel, children }: { closeLabel: string; children: ReactNode }) {
  return (
    <CSPProvider disableStyleElements>
      <ToastProvider closeLabel={closeLabel}>{children}</ToastProvider>
    </CSPProvider>
  );
}

// A panel that opens from a button and holds links and controls (the phone's "More" tab). Base UI moves focus into
// it, closes it on Escape or an outside click and returns focus to the button.
export function MenuPanel({
  open,
  onOpenChange,
  trigger,
  triggerClassName,
  triggerLabel,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Popover.Trigger className={triggerClassName} aria-label={triggerLabel}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={8} className="z-50">
          <Popover.Popup
            className="flex max-h-[70dvh] w-72 flex-col gap-3 overflow-y-auto rounded-card border border-border bg-surface p-3 text-text shadow-float"
            data-testid="menu-panel"
          >
            <Popover.Title className="sr-only">{title}</Popover.Title>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
