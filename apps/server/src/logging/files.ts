import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

interface Options {
  directory: string;
  destination: 'files' | 'both';
  retentionDays: number;
  maxTotalMB: number;
  stdout: (line: string) => void;
  now?: () => Date;
}

// Synchronous writes preserve ordering; no descriptor survives rotation or pruning.
export function createFileSink(options: Options): { write(line: string): void; prune(): void } {
  const logRoot = resolve(options.directory);
  const serviceUid = process.getuid?.() ?? 0;
  const owned = (uid: number) => uid === 0 || uid === serviceUid;
  const now = options.now ?? (() => new Date());
  let retryAt = 0;
  let failed = false;
  let latestDay = '';
  let totalBytes: number | undefined;
  const stdout = (line: string) => {
    try {
      options.stdout(line);
    } catch {
      /* Logging cannot break requests. */
    }
  };
  function failure(date: Date) {
    totalBytes = undefined;
    retryAt = date.getTime() + 600_000;
    if (!failed)
      stdout(
        JSON.stringify({
          time: date.toISOString(),
          level: 'warn',
          module: 'logging',
          msg: 'file logging unavailable; falling back to stdout',
        }),
      );
    failed = true;
  }
  function validateDirectory(path: string, managed: boolean) {
    const stat = lstatSync(path);
    // Sticky shared ancestors such as /tmp are allowed, never managed log directories.
    const unsafeMode = managed ? (stat.mode & 0o027) !== 0 : (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0;
    if (!stat.isDirectory() || !owned(stat.uid) || unsafeMode) throw new Error('unsafe log directory');
  }
  function directory(path: string, managed = true) {
    try {
      mkdirSync(path, { mode: 0o750 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    validateDirectory(path, managed);
  }
  function root() {
    let path = '/';
    validateDirectory(path, logRoot === path);
    for (const part of logRoot.split('/').filter(Boolean)) {
      path = join(path, part);
      directory(path, path === logRoot);
    }
  }
  function pruneUnsafe(date: Date) {
    root();
    const files: { path: string; day: string; size: number }[] = [];
    for (const year of readdirSync(logRoot)) {
      const yp = join(logRoot, year);
      if (!/^\d{4}$/.test(year) || !lstatSync(yp).isDirectory()) continue;
      validateDirectory(yp, true);
      for (const month of readdirSync(yp)) {
        const mp = join(yp, month);
        if (!/^(0[1-9]|1[0-2])$/.test(month) || !lstatSync(mp).isDirectory()) continue;
        validateDirectory(mp, true);
        for (const file of readdirSync(mp)) {
          const day = file.slice(0, 8);
          if (!/^\d{8}\.jsonl$/.test(file) || !day.startsWith(year + month)) continue;
          const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
          const parsed = new Date(iso);
          if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) continue;
          const path = join(mp, file);
          const stat = lstatSync(path);
          if (stat.isFile()) files.push({ path, day, size: stat.size });
        }
      }
    }
    files.sort((a, b) => a.day.localeCompare(b.day));
    const cutoff = date.getTime() - options.retentionDays * 86_400_000;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      const timestamp = Date.parse(`${file.day.slice(0, 4)}-${file.day.slice(4, 6)}-${file.day.slice(6, 8)}T00:00:00Z`);
      if (timestamp <= cutoff || total > options.maxTotalMB * 1024 * 1024) {
        unlinkSync(file.path);
        total -= file.size;
      }
    }
    totalBytes = total;
    for (const year of readdirSync(logRoot)) {
      const yp = join(logRoot, year);
      if (!/^\d{4}$/.test(year) || !lstatSync(yp).isDirectory()) continue;
      validateDirectory(yp, true);
      for (const month of readdirSync(yp)) {
        const mp = join(yp, month);
        if (/^(0[1-9]|1[0-2])$/.test(month) && lstatSync(mp).isDirectory()) {
          validateDirectory(mp, true);
          if (readdirSync(mp).length === 0) rmdirSync(mp);
        }
      }
      if (readdirSync(yp).length === 0) rmdirSync(yp);
    }
  }
  return {
    write(line) {
      const date = now();
      if (options.destination === 'both') stdout(line);
      if (date.getTime() < retryAt) {
        if (options.destination === 'files') stdout(line);
        return;
      }
      try {
        root();
        const day = date.toISOString().slice(0, 10).replaceAll('-', '');
        const year = day.slice(0, 4),
          month = day.slice(4, 6);
        directory(join(logRoot, year));
        directory(join(logRoot, year, month));
        const path = join(logRoot, year, month, `${day}.jsonl`);
        const fd = openSync(
          path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          0o640,
        );
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || !owned(stat.uid) || (stat.mode & 0o027) !== 0) throw new Error('unsafe log file');
          const data = Buffer.from(line + '\n');
          let offset = 0;
          while (offset < data.length) {
            const written = writeSync(fd, data, offset, data.length - offset);
            if (written === 0) throw new Error('incomplete log write');
            offset += written;
          }
          if (totalBytes !== undefined) totalBytes += data.length;
        } finally {
          closeSync(fd);
        }
        const rotated = latestDay !== day;
        if (rotated) {
          const temporary = join(logRoot, `.latest-${process.pid}-${Math.random().toString(16).slice(2)}`);
          try {
            symlinkSync(`${year}/${month}/${day}.jsonl`, temporary);
            renameSync(temporary, join(logRoot, 'latest.jsonl'));
          } finally {
            try {
              unlinkSync(temporary);
            } catch {
              /* Already renamed. */
            }
          }
          latestDay = day;
        }
        if (rotated || totalBytes === undefined || totalBytes > options.maxTotalMB * 1024 * 1024) pruneUnsafe(date);
        failed = false;
        retryAt = 0;
      } catch {
        failure(date);
        if (options.destination === 'files') stdout(line);
      }
    },
    prune() {
      const date = now();
      if (date.getTime() < retryAt) return;
      try {
        pruneUnsafe(date);
      } catch {
        failure(date);
      }
    },
  };
}
