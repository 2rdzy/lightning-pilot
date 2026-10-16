// Buttons (style guide §4, §6): 44 px touch targets, 8 px radius, the focus ring from the base styles. Brand red is
// for the main action; a destructive action uses --danger with an icon and explicit wording, never brand red.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover',
  secondary: 'border border-border bg-surface text-text hover:border-muted',
  // No lighter or translucent hover: it would drop the label below AA contrast.
  danger: 'bg-danger text-on-danger hover:underline',
  ghost: 'text-text hover:bg-bg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', icon, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-medium',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}

// A button that shows only an icon: the label is required and becomes its accessible name and tooltip.
export function IconButton({
  label,
  icon,
  className,
  type = 'button',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { label: string; icon: ReactNode }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-11 items-center justify-center rounded-control text-current hover:bg-black/10',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
    </button>
  );
}
