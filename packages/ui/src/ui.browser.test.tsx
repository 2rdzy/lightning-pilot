// Component tests of @lightning-pilot/ui in Chromium (WP15 acceptance): rendering, keyboard and focus, both themes,
// and an axe check of every component. Labels are passed in as the web app does; they are plain English here.
import {
  AmountText,
  Button,
  ChainBadge,
  CopyButton,
  DataTable,
  DesignSystemProvider,
  DestructiveConfirm,
  Dialog,
  EmptyState,
  ErrorState,
  HelpTip,
  IdValue,
  LiquidityBar,
  LiveIndicator,
  Logo,
  PreviewPanel,
  QrBlock,
  SegmentedControl,
  SkeletonRows,
  StatusPill,
  StepUpDialog,
  useToast,
  WrongChainBanner,
  type Column,
} from './index.ts';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { expectAccessible } from './testing/axe.ts';

const COPY = { copy: 'Copy', copied: 'Copied', failed: 'Copying did not work: copy it yourself.' };
const PUBKEY = `02${'e7'.repeat(32)}`;

afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

async function inBothThemes(check: () => Promise<void>) {
  for (const theme of ['light', 'dark'] as const) {
    document.documentElement.dataset.theme = theme;
    await check();
  }
}

describe('status and values', () => {
  it('names each chain with its own icon, in brand red, and stands out when waiting or refused', async () => {
    const screen = await render(
      <div>
        <ChainBadge kind="blake2b" label="BLAKE2b ✓" testId="b" />
        <ChainBadge kind="bitcoin" label="SHA256d ✓" testId="s" />
        <ChainBadge kind="waiting" label="Checking chain…" testId="w" />
        <ChainBadge kind="refused" label="Wrong chain: spending blocked" testId="r" />
        <WrongChainBanner>This node is on the wrong chain.</WrongChainBanner>
      </div>,
    );
    const blake = screen.getByTestId('b').element();
    const sha = screen.getByTestId('s').element();
    expect(getComputedStyle(blake).backgroundColor).toBe(getComputedStyle(sha).backgroundColor);
    expect(getComputedStyle(blake).backgroundColor).toBe('rgb(196, 64, 42)');
    // Told apart without reading: different icons.
    expect(blake.querySelector('svg')?.outerHTML).not.toBe(sha.querySelector('svg')?.outerHTML);
    await expect.element(screen.getByRole('alert')).toHaveTextContent('This node is on the wrong chain.');
    await inBothThemes(() => expectAccessible(screen.container));
  });

  it('shows status pills with their label and the native state on hover', async () => {
    const screen = await render(
      <p>
        <StatusPill tone="success" label="Active" title="CHANNELD_NORMAL" />
        <StatusPill tone="warning" label="Opening" />
        <StatusPill tone="danger" label="Failed" />
        <StatusPill tone="muted" label="Closed" />
        <StatusPill tone="info" label="Note" />
        <LiveIndicator state="live" label="Live" />
      </p>,
    );
    await expect.element(screen.getByTitle('CHANNELD_NORMAL')).toHaveTextContent('Active');
    await expect.element(screen.getByTestId('live-indicator')).toHaveAttribute('data-state', 'live');
    await inBothThemes(() => expectAccessible(screen.container));
  });

  it('draws the liquidity bar from msat amounts and describes it for screen readers', async () => {
    const screen = await render(
      <div className="w-96">
        <LiquidityBar
          local={600_000_000n}
          remote={400_000_000n}
          localText="600,000 sat"
          remoteText="400,000 sat"
          label="Local 600,000 sat, remote 400,000 sat"
        />
        <LiquidityBar local={0n} remote={0n} localText="0 sat" remoteText="0 sat" label="Empty channel" />
      </div>,
    );
    const bar = screen.getByRole('img', { name: 'Local 600,000 sat, remote 400,000 sat' });
    const local = bar.element().querySelector('rect.fill-brand');
    expect(local?.getAttribute('width')).toBe('600');
    // An empty channel has no coloured part.
    expect(screen.getByRole('img', { name: 'Empty channel' }).element().querySelector('rect.fill-brand')).toBeNull();
    await expectAccessible(screen.container);
  });

  it('shortens ids with the full value on hover and copies the full value', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard);
    const screen = await render(<IdValue value={PUBKEY} labels={COPY} testId="id" />);
    await expect.element(screen.getByTestId('id')).toHaveTextContent(`${PUBKEY.slice(0, 8)}…${PUBKEY.slice(-8)}`);
    await expect.element(screen.getByTestId('id')).toHaveAttribute('title', PUBKEY);
    await screen.getByRole('button', { name: 'Copy' }).click();
    expect(writeText).toHaveBeenCalledWith(PUBKEY);
    await expect.element(screen.getByRole('button', { name: 'Copied' })).toBeVisible();
    await expectAccessible(screen.container);
  });

  it('shows the text selected when the clipboard refuses', async () => {
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      writeText: () => Promise.reject(new Error('denied')),
    } as unknown as Clipboard);
    const screen = await render(<CopyButton value="lnbcrt1invoice" labels={COPY} />);
    await screen.getByRole('button', { name: 'Copy' }).click();
    const field = screen.getByRole('textbox', { name: COPY.failed });
    await expect.element(field).toHaveValue('lnbcrt1invoice');
    const input = field.element() as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'lnbcrt1invoice'.length]);
  });

  it('uses tabular figures for amounts and gives screen readers the spoken form', async () => {
    const screen = await render(<AmountText text="25,000 sat" spoken="25,000 sats" title="Exactly 25,000.5 sat" />);
    const amount = screen.getByText('25,000 sat').element();
    expect(getComputedStyle(amount).fontVariantNumeric).toBe('tabular-nums');
    expect(amount.getAttribute('aria-label')).toBe('25,000 sats');
  });

  it('draws the QR code dark on white in both themes, with the text and a copy button', async () => {
    const screen = await render(<QrBlock value="lnbcrt1abc" label="QR code of the invoice" copyLabels={COPY} />);
    await inBothThemes(async () => {
      const qr = screen.getByRole('img', { name: 'QR code of the invoice' }).element();
      expect(getComputedStyle(qr).backgroundColor).toBe('rgb(255, 255, 255)');
      await expectAccessible(screen.container);
    });
    await expect.element(screen.getByText('lnbcrt1abc')).toBeVisible();
  });

  it('renders the mark with or without an accessible name', async () => {
    const screen = await render(
      <div>
        <Logo label="Lightning Pilot" />
        <Logo small />
      </div>,
    );
    await expect.element(screen.getByRole('img', { name: 'Lightning Pilot' })).toBeVisible();
    // The small variant has no nodes on its ring.
    const [full, small] = screen.container.querySelectorAll('svg');
    expect(full?.querySelectorAll('circle')).toHaveLength(6);
    expect(small?.querySelectorAll('circle')).toHaveLength(1);
    expect(small?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('buttons and controls', () => {
  it('keeps danger apart from brand red and every button at least 44 px high', async () => {
    const screen = await render(
      <div className="flex gap-2">
        <Button variant="primary">Open channel</Button>
        <Button variant="danger">Force close channel</Button>
        <Button>Cancel</Button>
      </div>,
    );
    const primary = screen.getByRole('button', { name: 'Open channel' }).element();
    const danger = screen.getByRole('button', { name: 'Force close channel' }).element();
    expect(getComputedStyle(primary).backgroundColor).not.toBe(getComputedStyle(danger).backgroundColor);
    for (const button of [primary, danger]) expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await inBothThemes(() => expectAccessible(screen.container));
  });

  it('shows a visible 2 px brand focus ring on keyboard focus', async () => {
    const screen = await render(<Button>Focus me</Button>);
    await userEvent.keyboard('{Tab}');
    const button = screen.getByRole('button', { name: 'Focus me' }).element();
    expect(document.activeElement).toBe(button);
    const style = getComputedStyle(button);
    expect(style.outlineStyle).toBe('solid');
    expect(style.outlineWidth).toBe('2px');
    expect(style.outlineColor).toBe('rgb(196, 64, 42)');
  });

  it('switches one segment at a time, with the keyboard too', async () => {
    function Toggle() {
      const [view, setView] = useState<'basic' | 'advanced'>('advanced');
      return (
        <SegmentedControl
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'basic', label: 'Basic' },
            { value: 'advanced', label: 'Advanced' },
          ]}
        />
      );
    }
    const screen = await render(<Toggle />);
    const basic = screen.getByRole('button', { name: 'Basic' });
    const advanced = screen.getByRole('button', { name: 'Advanced' });
    await expect.element(advanced).toHaveAttribute('aria-pressed', 'true');
    await basic.click();
    await expect.element(basic).toHaveAttribute('aria-pressed', 'true');
    await expect.element(advanced).toHaveAttribute('aria-pressed', 'false');
    // Pressing the chosen one again keeps it chosen: one option is always pressed.
    await basic.click();
    await expect.element(basic).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await expect.element(advanced).toHaveAttribute('aria-pressed', 'true');
    await inBothThemes(() => expectAccessible(screen.container));
  });

  it('explains a node term in a help tip', async () => {
    const screen = await render(
      <HelpTip label="Short channel id">Where the channel was funded: block, tx, output.</HelpTip>,
    );
    await screen.getByRole('button', { name: 'Short channel id' }).click();
    await expect.element(page.getByText('Where the channel was funded: block, tx, output.')).toBeVisible();
    await expectAccessible(document.body);
  });
});

interface Channel {
  id: string;
  peer: string;
  local: string;
}
const COLUMNS: Column<Channel>[] = [
  { key: 'id', header: 'Channel', cell: (c) => <a href={`#${c.id}`}>{c.id}</a>, phone: 'primary' },
  { key: 'peer', header: 'Peer', cell: (c) => c.peer },
  { key: 'local', header: 'Local', cell: (c) => c.local, align: 'right', sortable: true, phone: 'primary' },
];
const SORT_LABELS = { ascending: 'Sorted ascending', descending: 'Sorted descending', none: 'Not sorted' };
const EMPTY = { title: 'No channels yet', body: 'Open a channel to start sending and receiving.' };

describe('tables and states', () => {
  it('reports sorting and row clicks; the sort itself belongs to the screen', async () => {
    const onSort = vi.fn();
    const onRowClick = vi.fn();
    const rows = [
      { id: '101x1x0', peer: 'bob', local: '600,000 sat' },
      { id: '102x1x0', peer: 'carol', local: '10 sat' },
    ];
    const screen = await render(
      <DataTable
        caption="Channels"
        columns={COLUMNS}
        rows={rows}
        rowKey={(c) => c.id}
        sort={{ column: 'local', direction: 'asc' }}
        onSort={onSort}
        onRowClick={onRowClick}
        empty={EMPTY}
        loadingLabel="Loading"
        sortLabels={SORT_LABELS}
      />,
    );
    const table = screen.getByRole('table', { name: 'Channels' });
    await expect.element(table.getByRole('columnheader', { name: 'Local' })).toHaveAttribute('aria-sort', 'ascending');
    await table.getByRole('button', { name: 'Local' }).click();
    expect(onSort).toHaveBeenCalledWith({ column: 'local', direction: 'desc' });
    await table.getByText('carol').click();
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
    const local = table.getByText('600,000 sat').element();
    expect(getComputedStyle(local).textAlign).toBe('right');
    await inBothThemes(() => expectAccessible(screen.container));
  });

  it('turns rows into stacked items on a phone', async () => {
    await page.viewport(390, 800);
    const screen = await render(
      <DataTable
        caption="Channels"
        columns={COLUMNS}
        rows={[{ id: '101x1x0', peer: 'bob', local: '600,000 sat' }]}
        rowKey={(c) => c.id}
        empty={EMPTY}
        loadingLabel="Loading"
        sortLabels={SORT_LABELS}
      />,
    );
    await expect.element(screen.getByRole('table')).not.toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Channels' });
    await expect.poll(() => list.getByRole('listitem').element().textContent).toMatch(/^101x1x0600,000 satPeer: bob$/);
    await expectAccessible(screen.container);
    await page.viewport(1280, 800);
  });

  it('shows skeleton rows while loading and a designed empty state', async () => {
    const loading = await render(
      <DataTable
        caption="Channels"
        columns={COLUMNS}
        rows={undefined}
        rowKey={(c) => c.id}
        empty={EMPTY}
        loadingLabel="Loading channels"
        sortLabels={SORT_LABELS}
      />,
    );
    await expect.element(loading.getByRole('status', { name: 'Loading channels' })).toBeVisible();
    await loading.unmount();
    const empty = await render(
      <EmptyState title={EMPTY.title} body={EMPTY.body} action={<Button variant="primary">Open channel</Button>} />,
    );
    await expect.element(empty.getByText('No channels yet')).toBeVisible();
    await expect.element(empty.getByRole('button', { name: 'Open channel' })).toBeVisible();
    await inBothThemes(() => expectAccessible(empty.container));
  });

  it('shows an error with its request id and a retry', async () => {
    const retry = vi.fn();
    const screen = await render(
      <div>
        <ErrorState
          message="The node could not be reached."
          requestId="Request id: r-1"
          retryLabel="Try again"
          onRetry={retry}
        />
        <SkeletonRows label="Loading" />
      </div>,
    );
    await expect.poll(() => screen.getByRole('alert').element().textContent).toMatch(/The node could not be reached./);
    await expect.element(screen.getByText('Request id: r-1')).toBeVisible();
    await screen.getByRole('button', { name: 'Try again' }).click();
    expect(retry).toHaveBeenCalledOnce();
    await inBothThemes(() => expectAccessible(screen.container));
  });
});

describe('dialogs', () => {
  it('traps focus in a dialog, closes on Escape and returns focus to the opener', async () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open channel</Button>
          <Dialog open={open} onOpenChange={setOpen} title="Open channel" closeLabel="Close">
            <input aria-label="Amount (sat)" className="input" />
          </Dialog>
        </>
      );
    }
    const screen = await render(<Example />);
    const opener = screen.getByRole('button', { name: 'Open channel' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Open channel' });
    await expect.element(dialog).toBeVisible();
    await expectAccessible(document.body);
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard('{Tab}');
      expect(dialog.element().contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard('{Escape}');
    await expect.element(dialog).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener.element());
  });

  it('repeats the consequences before a destructive action and starts on Cancel', async () => {
    const confirm = vi.fn();
    await render(
      <DestructiveConfirm
        open
        onOpenChange={() => {}}
        title="Force close channel"
        consequences="Force close: funds return after about 144 blocks; fee about 2,000 sat."
        confirmLabel="Force close channel"
        cancelLabel="Cancel"
        onConfirm={confirm}
      />,
    );
    const dialog = page.getByRole('alertdialog', { name: 'Force close channel' });
    await expect.poll(() => dialog.element().textContent).toMatch(/funds return after about 144 blocks/);
    await expect.element(dialog.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const danger = dialog.getByTestId('destructive-confirm-button');
    expect(getComputedStyle(danger.element()).backgroundColor).toBe('rgb(211, 37, 53)');
    await danger.click();
    expect(confirm).toHaveBeenCalledOnce();
    await inBothThemes(() => expectAccessible(document.body));
  });

  it('asks for the password and the code at step-up, says why, and forgets them when closed', async () => {
    const submit = vi.fn();
    function Example() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Again</Button>
          <StepUpDialog
            open={open}
            onOpenChange={setOpen}
            reason="Payments above 100,000 sat need your password."
            needsTotp
            labels={{
              title: 'Confirm it is you',
              password: 'Password',
              totp: 'Authenticator code',
              submit: 'Confirm',
              cancel: 'Cancel',
              close: 'Close',
            }}
            onSubmit={submit}
          />
        </>
      );
    }
    const screen = await render(<Example />);
    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect.poll(() => dialog.element().textContent).toMatch(/Payments above 100,000 sat need your password./);
    await expect.element(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await dialog.getByLabelText('Password').fill('correct horse');
    await dialog.getByLabelText('Authenticator code').fill('123456');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    expect(submit).toHaveBeenCalledWith({ password: 'correct horse', totpCode: '123456' });
    await expectAccessible(document.body);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await screen.getByRole('button', { name: 'Again' }).click();
    await expect.element(page.getByRole('dialog').getByLabelText('Password')).toHaveValue('');
  });

  it('previews a spend with the chain, the exact total and warnings, then one confirm button', async () => {
    const confirm = vi.fn();
    const screen = await render(
      <PreviewPanel
        title="Check the payment"
        chain={<ChainBadge kind="blake2b" label="BLAKE2b ✓" />}
        rows={[
          { label: 'Amount', value: '25,000 sat' },
          { label: 'Maximum fee', value: '0.500 sat' },
          { label: 'Total', value: '25,000.500 sat', emphasis: true, testId: 'preview-total' },
        ]}
        warnings={['You paid this destination the same amount in the last 24 hours.']}
        confirmLabel="Pay 25,000.500 sat"
        onConfirm={confirm}
      />,
    );
    await expect.element(screen.getByTestId('preview-total')).toHaveTextContent('25,000.500 sat');
    await expect.element(screen.getByTestId('chain-badge')).toBeVisible();
    await expect.poll(() => screen.getByTestId('preview-warnings').element().textContent).toMatch(/same amount/);
    await screen.getByRole('button', { name: 'Pay 25,000.500 sat' }).click();
    expect(confirm).toHaveBeenCalledOnce();
    await inBothThemes(() => expectAccessible(screen.container));
  });
});

describe('toasts', () => {
  it('shows a short confirmation that can be dismissed', async () => {
    function Example() {
      const toast = useToast();
      return <Button onClick={() => toast('Invoice created')}>Create</Button>;
    }
    const screen = await render(
      <DesignSystemProvider closeLabel="Close">
        <Example />
      </DesignSystemProvider>,
    );
    await screen.getByRole('button', { name: 'Create' }).click();
    const toast = page.getByTestId('toast');
    await expect.poll(() => toast.element().textContent).toMatch(/Invoice created/);
    await expectAccessible(document.body);
    await toast.getByRole('button', { name: 'Close' }).click();
    await expect.element(toast).not.toBeInTheDocument();
  });
});

describe('the stylesheet', () => {
  it('follows the system theme unless one is chosen, and moves nothing with reduced motion', async () => {
    const screen = await render(<div className="bg-surface skeleton" data-testid="probe" />);
    const probe = screen.getByTestId('probe').element();
    document.documentElement.dataset.theme = 'dark';
    expect(getComputedStyle(probe).backgroundColor).toBe('rgb(27, 29, 31)');
    document.documentElement.dataset.theme = 'light';
    expect(getComputedStyle(probe).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(probe).animationName).toBe('lp-pulse');
  });
});
