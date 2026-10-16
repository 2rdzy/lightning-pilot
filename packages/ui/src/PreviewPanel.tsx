// Preview → confirm (style guide §6): every spend shows a panel with the decoded destination, amount, maximum fee,
// total, the chain badge, the remaining 24 h limit and any warnings, then one confirm button that states the action
// and the total ("Pay 25 000 sat"). Values arrive formatted; costs are formatted exactly by the caller.
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

export interface PreviewRow {
  label: string;
  value: ReactNode;
  testId?: string;
  // The total is set apart from the rows above it.
  emphasis?: boolean;
}

export function PreviewPanel({
  title,
  chain,
  rows,
  warnings = [],
  notice,
  children,
  confirmLabel,
  onConfirm,
  confirmDisabled = false,
  destructive = false,
}: {
  title: string;
  chain: ReactNode;
  rows: readonly PreviewRow[];
  warnings?: readonly ReactNode[];
  // A note above the rows, e.g. "Opened from a link: check the details".
  notice?: ReactNode;
  // Extra controls before the confirm button (acknowledgements, a password field).
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4" data-testid="preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{title}</h2>
        {chain}
      </div>
      {notice}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className={row.emphasis ? 'contents font-semibold' : 'contents'}>
            <dt className={row.emphasis ? 'border-t border-border pt-2' : 'text-muted'}>{row.label}</dt>
            <dd
              className={
                row.emphasis ? 'border-t border-border pt-2 text-right tabular-nums' : 'text-right tabular-nums'
              }
              data-testid={row.testId}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="preview-warnings">
          {warnings.map((warning, i) => (
            <li key={i} className="flex items-start gap-2 rounded-control border border-warning p-2 text-sm">
              <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
      <Button
        variant={destructive ? 'danger' : 'primary'}
        icon={destructive ? <TriangleAlert size={16} /> : undefined}
        className="self-start"
        onClick={onConfirm}
        disabled={confirmDisabled}
      >
        {confirmLabel}
      </Button>
    </section>
  );
}
