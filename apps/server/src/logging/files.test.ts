import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSink } from './files.ts';
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()) }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(destination: 'files' | 'both' = 'files', maxTotalMB = 10) {
  const root = mkdtempSync(join(tmpdir(), 'lp-log-'));
  roots.push(root);
  const directory = join(root, 'logs');
  let date = new Date('2026-10-15T23:59:59Z');
  const output: string[] = [];
  const sink = createFileSink({
    directory,
    destination,
    retentionDays: 2,
    maxTotalMB,
    stdout: (line) => output.push(line),
    now: () => date,
  });
  return {
    root,
    directory,
    output,
    sink,
    date: (value: string) => {
      date = new Date(value);
    },
  };
}
describe('file logging', () => {
  it('appends and rotates at UTC midnight with private files and directories', () => {
    const s = setup('both');
    s.sink.write('one');
    s.sink.write('two');
    const first = join(s.directory, '2026/10/20261015.jsonl');
    expect(readFileSync(first, 'utf8')).toBe('one\ntwo\n');
    expect(statSync(first).mode & 0o777).toBe(0o640);
    expect(statSync(join(s.directory, '2026/10')).mode & 0o777).toBe(0o750);
    s.date('2026-10-16T00:00:00Z');
    s.sink.write('three');
    expect(readlinkSync(join(s.directory, 'latest.jsonl'))).toBe('2026/10/20261016.jsonl');
    expect(s.output).toEqual(['one', 'two', 'three']);
  });
  it('deletes the whole boundary day at the retention cutoff, preserving unrelated files', () => {
    const s = setup();
    s.date('2026-10-13T00:00:00Z');
    s.sink.write('old');
    writeFileSync(join(s.directory, '2026/10/notes'), 'keep');
    s.date('2026-10-14T23:59:59.999Z');
    s.sink.prune();
    expect(existsSync(join(s.directory, '2026/10/20261013.jsonl'))).toBe(true);
    s.date('2026-10-15T00:00:00.000Z');
    s.sink.prune();
    expect(existsSync(join(s.directory, '2026/10/20261013.jsonl'))).toBe(false);
    expect(readFileSync(join(s.directory, '2026/10/notes'), 'utf8')).toBe('keep');
  });
  it.each(['2026-10-15T00:00:00.001Z', '2026-10-15T12:00:00.000Z'])(
    'removes the boundary day after cutoff, including UTC midday (%s)',
    (now) => {
      const s = setup();
      s.date('2026-10-13T23:59:59.999Z');
      s.sink.write('boundary day');
      s.date('2026-10-14T00:00:00.000Z');
      s.sink.write('next day');
      s.date(now);
      s.sink.prune();
      expect(existsSync(join(s.directory, '2026/10/20261013.jsonl'))).toBe(false);
      expect(readFileSync(join(s.directory, '2026/10/20261014.jsonl'), 'utf8')).toBe('next day\n');
    },
  );
  it('caps oldest files first, including oversized current day, reopening the next write', () => {
    const s = setup('files', 8 / 1048576);
    s.sink.write('123');
    s.date('2026-10-16T00:00:00Z');
    s.sink.write('456');
    expect(existsSync(join(s.directory, '2026/10/20261015.jsonl'))).toBe(true);
    s.sink.write('7');
    expect(existsSync(join(s.directory, '2026/10/20261015.jsonl'))).toBe(false);
    s.sink.write('oversized');
    expect(existsSync(join(s.directory, '2026/10/20261016.jsonl'))).toBe(false);
    s.sink.write('ok');
    expect(readFileSync(join(s.directory, '2026/10/20261016.jsonl'), 'utf8')).toBe('ok\n');
    expect(readlinkSync(join(s.directory, 'latest.jsonl'))).toBe('2026/10/20261016.jsonl');
  });
  it.each(['files', 'both'] as const)(
    'falls back once per line, warns once and retries after ten minutes (%s)',
    (destination) => {
      const s = setup(destination);
      writeFileSync(s.directory, 'blocked');
      s.sink.write('one');
      s.sink.write('two');
      expect(s.output.filter((line) => line === 'one')).toHaveLength(1);
      expect(s.output.filter((line) => line === 'two')).toHaveLength(1);
      expect(s.output.filter((line) => line.includes('file logging unavailable'))).toHaveLength(1);
      rmSync(s.directory);
      s.date('2026-10-16T00:09:58Z');
      s.sink.write('three');
      expect(existsSync(s.directory)).toBe(false);
      s.date('2026-10-16T00:09:59Z');
      s.sink.write('four');
      expect(readFileSync(join(s.directory, '2026/10/20261016.jsonl'), 'utf8')).toBe('four\n');
    },
  );
  it('never follows day-file or directory symlinks and preserves symlinks during pruning', () => {
    const s = setup();
    const target = join(s.root, 'target');
    writeFileSync(target, 'untouched');
    mkdirSync(s.directory, { mode: 0o750 });
    mkdirSync(join(s.directory, '2026'), { mode: 0o750 });
    mkdirSync(join(s.directory, '2026/10'), { mode: 0o750 });
    symlinkSync(target, join(s.directory, '2026/10/20261015.jsonl'));
    s.sink.write('secret');
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    s.date('2026-10-16T00:10:00Z');
    s.sink.prune();
    expect(readlinkSync(join(s.directory, '2026/10/20261015.jsonl'))).toBe(target);
    rmSync(join(s.directory, '2026'), { recursive: true });
    symlinkSync(s.root, join(s.directory, '2026'));
    s.sink.write('secret');
    expect(existsSync(join(s.root, '10'))).toBe(false);
  });
  it('refuses unsafe existing file permissions without changing ancestor modes', () => {
    const s = setup();
    s.sink.write('safe');
    const file = join(s.directory, '2026/10/20261015.jsonl');
    const mode = statSync(s.root).mode;
    chmodSync(file, 0o660);
    s.sink.write('unsafe');
    expect(readFileSync(file, 'utf8')).toBe('safe\n');
    expect(s.output).toContain('unsafe');
    expect(statSync(s.root).mode).toBe(mode);
  });
  it.each(['', '2026', '2026/10'])('refuses unsafe managed directory %s without changing its mode', (relative) => {
    const s = setup();
    s.sink.write('safe');
    const path = join(s.directory, relative);
    chmodSync(path, 0o777);
    s.sink.write('unsafe');
    expect(s.output).toContain('unsafe');
    expect(readFileSync(join(s.directory, '2026/10/20261015.jsonl'), 'utf8')).toBe('safe\n');
    expect(statSync(path).mode & 0o777).toBe(0o777);
  });
  it('refuses unsafe managed historical directories during pruning', () => {
    const s = setup();
    s.sink.write('safe');
    const historical = join(s.directory, '2025');
    mkdirSync(historical, { mode: 0o750 });
    chmodSync(historical, 0o770);
    s.sink.prune();
    expect(s.output.some((line) => line.includes('file logging unavailable'))).toBe(true);
    expect(existsSync(historical)).toBe(true);
  });
  it('allows sticky shared ancestors and refuses writable nonsticky ancestors', () => {
    const s = setup();
    const mode = statSync(tmpdir()).mode;
    s.sink.write('safe');
    expect(s.output).toEqual([]);
    expect(statSync(tmpdir()).mode).toBe(mode);
    chmodSync(s.root, 0o777);
    s.sink.write('unsafe');
    expect(s.output).toContain('unsafe');
    expect(statSync(s.root).mode & 0o777).toBe(0o777);
  });
  it('refuses unknown owners on managed directories and files', () => {
    const s = setup();
    s.sink.write('safe');
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike) => {
      const stat = original(path);
      return String(path) === s.directory ? Object.assign(stat, { uid: 2147483647 }) : stat;
    }) as typeof fs.lstatSync);
    s.sink.write('unsafe');
    expect(s.output).toContain('unsafe');
    vi.restoreAllMocks();
    s.date('2026-10-16T00:10:00Z');
    const originalFstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) =>
      Object.assign(originalFstat(fd), { uid: 2147483647 })) as typeof fs.fstatSync);
    s.sink.write('unsafe-file');
    expect(s.output).toContain('unsafe-file');
  });
  it('swallows even stdout failures', () => {
    const s = setup();
    writeFileSync(s.directory, 'blocked');
    const sink = createFileSink({
      directory: s.directory,
      destination: 'both',
      retentionDays: 2,
      maxTotalMB: 10,
      stdout: () => {
        throw new Error('broken pipe');
      },
    });
    expect(() => sink.write('line')).not.toThrow();
    expect(() => sink.prune()).not.toThrow();
  });
});
