// A choice of two or three options shown side by side (the Basic/Advanced toggle, the theme switch). Base UI's
// toggle group gives it the keyboard behaviour of a toolbar; exactly one option is always pressed.
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  // Show only the icon; the label stays as the accessible name and tooltip.
  iconOnly?: boolean;
}

export function SegmentedControl<V extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  tone = 'surface',
}: {
  label: string;
  value: V;
  options: readonly SegmentOption<V>[];
  onChange: (value: V) => void;
  testId?: string;
  // On the phone's dark-red top bar the control is drawn in white.
  tone?: 'surface' | 'bar';
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const chosen = next[0] as V | undefined;
        if (chosen !== undefined && chosen !== value) onChange(chosen);
      }}
      className={cx(
        'inline-flex rounded-control border p-0.5',
        tone === 'bar' ? 'border-white/40' : 'border-border bg-surface',
      )}
      data-testid={testId}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          aria-label={option.iconOnly ? option.label : undefined}
          title={option.iconOnly ? option.label : undefined}
          className={cx(
            'inline-flex min-h-9 min-w-9 items-center justify-center gap-1 rounded-[6px] px-2 text-xs font-medium',
            tone === 'bar'
              ? 'text-white data-[pressed]:bg-white data-[pressed]:text-bar'
              : 'text-muted hover:text-text data-[pressed]:bg-brand data-[pressed]:text-white',
          )}
        >
          {option.icon ? (
            <span aria-hidden="true" className="inline-flex">
              {option.icon}
            </span>
          ) : null}
          {option.iconOnly ? null : option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
