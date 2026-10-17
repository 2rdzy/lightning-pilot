import { describe, expect, it, vi } from 'vitest';
import { connectLive, retryDelay, type EventSourceLike } from './live.ts';
import { hrefOf, isActive, isAdvancedOnly, NAV_ITEMS, phoneLayout, visibleItems, type NavItem } from './navigation.ts';
import { applyTheme, effectiveView, readPreferences, writePreferences } from './preferences.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const blocked = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('display preferences', () => {
  it('defaults to Advanced on a desktop and Basic on a phone until a view is chosen', () => {
    const prefs = readPreferences(memoryStorage());
    expect(prefs).toEqual({ view: undefined, theme: 'system' });
    expect(effectiveView(prefs, false)).toBe('advanced');
    expect(effectiveView(prefs, true)).toBe('basic');
    expect(effectiveView({ ...prefs, view: 'advanced' }, true)).toBe('advanced');
  });

  it('keeps choices per device and drops unknown stored values', () => {
    const storage = memoryStorage();
    writePreferences(storage, { view: 'basic', theme: 'dark' });
    expect(readPreferences(storage)).toEqual({ view: 'basic', theme: 'dark' });
    writePreferences(storage, { view: undefined, theme: 'system' });
    expect(storage.data.size).toBe(0);
    expect(readPreferences(memoryStorage({ 'lp.view': 'expert', 'lp.theme': 'pink' }))).toEqual({
      view: undefined,
      theme: 'system',
    });
  });

  it('works with storage blocked or missing', () => {
    expect(readPreferences(blocked)).toEqual({ view: undefined, theme: 'system' });
    expect(() => writePreferences(blocked, { view: 'basic', theme: 'light' })).not.toThrow();
    expect(readPreferences(undefined)).toEqual({ view: undefined, theme: 'system' });
  });

  it('sets data-theme only for a chosen theme', () => {
    const root = { dataset: {} as DOMStringMap };
    applyTheme(root, 'dark');
    expect(root.dataset.theme).toBe('dark');
    applyTheme(root, 'system');
    expect(root.dataset.theme).toBeUndefined();
  });
});

describe('navigation', () => {
  const ids = (items: NavItem[]) => items.map((i) => i.id);
  const all = NAV_ITEMS.map((item) => ({ ...item, built: true }));

  it('shows only built screens, and hides Advanced-only ones in the Basic view', () => {
    expect(ids(visibleItems('advanced'))).toEqual([
      'dashboard',
      'channels',
      'peers',
      'payments',
      'node',
      'pay',
      'receive',
      'settings',
    ]);
    expect(ids(visibleItems('basic', all))).toEqual([
      'dashboard',
      'channels',
      'payments',
      'pay',
      'receive',
      'settings',
    ]);
    expect(ids(visibleItems('advanced', all))).toEqual(NAV_ITEMS.map((i) => i.id));
  });

  it('puts Home · Channels · Pay · Receive on the phone tab bar and the rest under More', () => {
    expect(ids(phoneLayout('basic', all).tabs)).toEqual(['dashboard', 'channels', 'pay', 'receive']);
    expect(ids(phoneLayout('basic', all).more)).toEqual(['payments', 'settings']);
    expect(ids(phoneLayout('advanced', all).more)).toEqual(['peers', 'payments', 'onchain', 'node', 'settings']);
  });

  it('links node screens below /n/:node and marks the active one', () => {
    const node = '7d3f4b4e-2a7f-4c1e-9d3a-1b2c3d4e5f60';
    const byId = (id: string) => NAV_ITEMS.find((i) => i.id === id) as NavItem;
    expect(hrefOf(byId('dashboard'), node)).toBe(`/n/${node}`);
    expect(hrefOf(byId('pay'), node)).toBe(`/n/${node}/pay`);
    expect(hrefOf(byId('settings'), node)).toBe('/settings/export');
    expect(isActive(byId('dashboard'), node, `/n/${node}`)).toBe(true);
    expect(isActive(byId('dashboard'), node, `/n/${node}/`)).toBe(true);
    expect(isActive(byId('dashboard'), node, `/n/${node}/pay`)).toBe(false);
    expect(isActive(byId('channels'), node, `/n/${node}/channels/123x1x0`)).toBe(true);
    expect(isActive(byId('pay'), node, `/n/${node}/payments`)).toBe(false);
  });

  it('marks an Advanced-only screen opened in the Basic view', () => {
    const node = '7d3f4b4e-2a7f-4c1e-9d3a-1b2c3d4e5f60';
    expect(isAdvancedOnly('basic', node, `/n/${node}/peers`)).toBe(true);
    expect(isAdvancedOnly('basic', node, `/n/${node}/onchain/tx/abc`)).toBe(true);
    expect(isAdvancedOnly('advanced', node, `/n/${node}/peers`)).toBe(false);
    expect(isAdvancedOnly('basic', node, `/n/${node}/channels`)).toBe(false);
    expect(isAdvancedOnly('basic', node, `/n/${node}`)).toBe(false);
  });
});

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

describe('live connection', () => {
  it('backs off after a refused stream, up to a minute', () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 60_000]);
  });

  it('reports connecting, live and reconnecting, and opens again after the server refused the stream', () => {
    const sources: FakeSource[] = [];
    const timers: { run: () => void; ms: number }[] = [];
    const states: string[] = [];
    const messages: unknown[] = [];
    const stop = connectLive({
      onState: (s) => states.push(s),
      eventTypes: ['block.new'],
      onEvent: (type, e) => messages.push(`${type} ${String(e.data)}`),
      open: (url) => {
        expect(url).toBe('/api/v1/events');
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      setTimer: (run, ms) => timers.push({ run, ms }),
      clearTimer: () => {},
    });
    const first = sources[0] as FakeSource;
    first.onopen?.(new Event('open'));
    first.listeners.get('block.new')?.({ data: 'x' } as MessageEvent);
    // A dropped connection the browser retries by itself: no timer of ours.
    first.readyState = 0;
    first.onerror?.(new Event('error'));
    expect(timers).toHaveLength(0);
    // Refused (closed for good): a new EventSource after the delay.
    first.readyState = 2;
    first.onerror?.(new Event('error'));
    expect(timers.map((t) => t.ms)).toEqual([2_000]);
    timers[0]?.run();
    expect(sources).toHaveLength(2);
    sources[1]?.onopen?.(new Event('open'));
    expect(states).toEqual(['connecting', 'live', 'reconnecting', 'reconnecting', 'live']);
    expect(messages).toEqual(['block.new x']);
    // A replaced source no longer delivers.
    first.listeners.get('block.new')?.({ data: 'late' } as MessageEvent);
    expect(messages).toEqual(['block.new x']);
    stop();
    expect(sources[1]?.closed).toBe(true);
  });

  it('stays stopped: no reconnect after stop, and a pending retry is cancelled', () => {
    const sources: FakeSource[] = [];
    const cleared = vi.fn();
    const timers: (() => void)[] = [];
    const stop = connectLive({
      onState: () => {},
      open: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      setTimer: (run) => {
        timers.push(run);
        return 7;
      },
      clearTimer: cleared,
    });
    const first = sources[0] as FakeSource;
    first.readyState = 2;
    first.onerror?.(new Event('error'));
    stop();
    expect(cleared).toHaveBeenCalledWith(7);
    timers[0]?.();
    first.onerror?.(new Event('error'));
    expect(sources).toHaveLength(1);
  });
});
