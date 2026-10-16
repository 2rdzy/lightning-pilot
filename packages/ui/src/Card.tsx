// Cards and form fields (style guide §4): flat surfaces with a 1 px border, 12 px radius; labels above inputs.
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export function Card({
  title,
  actions,
  className,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx('rounded-card border border-border bg-surface p-4', className)}>
      {title || actions ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title ? <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// A page heading with its main action on the right (style guide §5: summary before detail).
export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
