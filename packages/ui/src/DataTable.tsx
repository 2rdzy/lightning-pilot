// Tables (style guide §6): sticky header, sortable columns, amounts right-aligned, a row opens its detail route. On a
// phone (below 768 px) each row becomes a stacked item of two lines. Sorting and filtering are controlled by the
// screen, which keeps them in the URL; this component only renders and reports clicks.
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import { nextSort, type Sort } from './helpers.ts';
import { EmptyState, SkeletonRows } from './states.tsx';

export interface Column<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  // On a phone: the first line holds the primary columns, the second the rest; hidden columns are left out there.
  phone?: 'primary' | 'secondary' | 'hidden';
}

export interface DataTableProps<Row> {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[] | undefined;
  rowKey: (row: Row) => string;
  sort?: Sort | undefined;
  onSort?: (sort: Sort) => void;
  // Opening a row: usually a router navigation to its detail route. The first column should hold a real link too,
  // so the row also opens with the keyboard and by a middle click.
  onRowClick?: (row: Row) => void;
  empty: { title: string; body: string; action?: ReactNode };
  loadingLabel: string;
  sortLabels: { ascending: string; descending: string; none: string };
  footer?: ReactNode;
  testId?: string;
}

export function DataTable<Row>(props: DataTableProps<Row>) {
  const { caption, columns, rows, rowKey, sort, onSort, onRowClick, empty, loadingLabel, sortLabels, footer } = props;
  if (rows === undefined) return <SkeletonRows label={loadingLabel} rows={5} />;
  if (rows.length === 0) return <EmptyState title={empty.title} body={empty.body} action={empty.action} />;
  const primary = columns.filter((c) => (c.phone ?? 'secondary') === 'primary');
  const secondary = columns.filter((c) => (c.phone ?? 'secondary') === 'secondary');
  return (
    <div className="rounded-card border border-border bg-surface" data-testid={props.testId}>
      <table className="hidden w-full border-collapse text-sm md:table">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-[1] bg-surface">
          <tr>
            {columns.map((column) => {
              const active = sort?.column === column.key ? sort.direction : undefined;
              const ariaSort = active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={column.sortable ? (ariaSort ?? 'none') : undefined}
                  className={cx(
                    'border-b border-border px-3 py-2 text-xs font-semibold text-muted',
                    column.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {column.sortable && onSort ? (
                    <button
                      type="button"
                      className={cx(
                        'inline-flex min-h-8 items-center gap-1 hover:text-text',
                        column.align === 'right' && 'flex-row-reverse',
                      )}
                      onClick={() => onSort(nextSort(sort, column.key))}
                      title={
                        active === 'asc'
                          ? sortLabels.ascending
                          : active === 'desc'
                            ? sortLabels.descending
                            : sortLabels.none
                      }
                    >
                      {column.header}
                      <span aria-hidden="true" className="inline-flex">
                        {active === 'asc' ? (
                          <ArrowUp size={14} />
                        ) : active === 'desc' ? (
                          <ArrowDown size={14} />
                        ) : (
                          <ArrowUpDown size={14} />
                        )}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={cx('border-b border-border last:border-b-0', onRowClick && 'cursor-pointer hover:bg-bg')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx('px-3 py-2', column.align === 'right' ? 'text-right tabular-nums' : 'text-left')}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-border md:hidden" aria-label={caption}>
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className={cx('flex flex-col gap-1 px-3 py-3', onRowClick && 'cursor-pointer')}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            <div className="flex items-center justify-between gap-2 text-sm font-medium">
              {primary.map((column) => (
                <span key={column.key} className={column.align === 'right' ? 'tabular-nums' : undefined}>
                  {column.cell(row)}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted">
              {secondary.map((column) => (
                <span key={column.key} className={column.align === 'right' ? 'tabular-nums' : undefined}>
                  <span className="sr-only">{column.header}: </span>
                  {column.cell(row)}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {footer ? <div className="border-t border-border px-3 py-2">{footer}</div> : null}
    </div>
  );
}
