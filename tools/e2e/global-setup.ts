// Starts one development server per Playwright project on a fresh database and reads its setup token from the log
// (the server prints it to stdout, as in production). Each server's whole log is kept in test-results/ so the test
// can check that no secret reached it. Returns the teardown that stops the servers (by their own process ids); if
// any server fails to start, every server started so far is stopped before the error is reported.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_PORTS } from '../../playwright.config.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const LOG_DIR = join(ROOT, 'test-results', 'e2e-server');
const STOP_GRACE_MS = 10_000;

const spawned: ChildProcess[] = [];

// SIGTERM, then SIGKILL if the server has not exited within the grace period.
function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const force = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function start(project: string, port: number): Promise<ChildProcess> {
  const nodes = process.env.E2E_NODES ?? 'fake';
  const child = spawn(
    process.execPath,
    ['tools/dev/server.ts', '--nodes', nodes, '--port', String(port), '--web', 'apps/web/dist'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  spawned.push(child);
  const log = createWriteStream(join(LOG_DIR, `${project}.log`));
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`${project} server did not start; see ${LOG_DIR}`)), 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${project} server exited with ${code}; see ${LOG_DIR}`));
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('"setupToken"')) {
          // Handed to the tests through the environment (workers inherit it). Not an LP_ name: the server's
          // config loader refuses unknown LP_ variables.
          process.env[`E2E_SETUP_TOKEN_${project.toUpperCase()}`] = (
            JSON.parse(line) as { setupToken: string }
          ).setupToken;
        }
        if (line.includes('development server ready')) {
          clearTimeout(timer);
          resolve(child);
        }
      }
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) throw new Error('build the web app first: pnpm build:web');
  mkdirSync(LOG_DIR, { recursive: true });
  const started = await Promise.allSettled(Object.entries(E2E_PORTS).map(([project, port]) => start(project, port)));
  const teardown = async () => {
    await Promise.all(spawned.map(stop));
  };
  const failed = started.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    await teardown();
    throw failed.reason;
  }
  return teardown;
}
