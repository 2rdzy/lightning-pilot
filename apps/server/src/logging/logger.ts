// Shared JSONL destinations for the administrator, with redaction before any output.
import type { ChannelId, FundingOutpoint, PaymentHash, Pubkey, Txid } from '@lightning-pilot/core';
import { redact, redactString } from './redact.ts';
import { createFileSink } from './files.ts';

export const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type Level = (typeof LEVELS)[number];

// The exempt identifier fields take only values made by the parsers in core (a preimage has the shape of a txid).
export interface LogFields {
  requestId?: string;
  paymentHash?: PaymentHash;
  txid?: Txid;
  channelId?: ChannelId;
  fundingOutpoint?: FundingOutpoint;
  pubkey?: Pubkey;
  [field: string]: unknown;
}

export type Sink = (line: string) => void;

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  child(module: string): Logger;
  pruneFiles(): void;
  // The one deliberate exception to redaction: the one-time setup token, printed once with the setup URL. It
  // always goes to stdout, whatever the log destination, so the service manager's log shows it.
  setupToken(token: string, url: string): void;
}

export interface LoggerOptions {
  level?: Level;
  modules?: Record<string, Level>;
  sink?: Sink;
  stdout?: Sink;
  now?: () => Date;
  destination?: 'files' | 'stdout' | 'both';
  directory?: string;
  retentionDays?: number;
  maxTotalMB?: number;
}

const rank = (level: Level) => LEVELS.indexOf(level);
const defaultSink: Sink = (line) => process.stdout.write(line + '\n');

export function createLogger(options: LoggerOptions = {}, module = 'server'): Logger {
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? options.sink ?? defaultSink;
  const files =
    options.destination && options.destination !== 'stdout' && !options.sink
      ? createFileSink({
          directory: options.directory ?? '/var/log/lightning-pilot',
          destination: options.destination,
          retentionDays: options.retentionDays ?? 365,
          maxTotalMB: options.maxTotalMB ?? 1024,
          stdout,
          now,
        })
      : undefined;
  const sink = options.sink ?? files?.write ?? stdout;
  let failed = false;
  const output = (target: Sink, line: string) => {
    try {
      target(line);
    } catch {
      try {
        if (!failed)
          stdout(
            JSON.stringify({
              time: now().toISOString(),
              level: 'warn',
              module: 'logging',
              msg: 'log sink unavailable',
            }),
          );
        if (target !== stdout) stdout(line);
      } catch {
        /* No functioning destination: logging cannot fail the request. */
      }
      failed = true;
    }
  };
  const child = (name: string): Logger => {
    const threshold = rank(options.modules?.[name] ?? options.level ?? 'info');
    const write = (level: Level, msg: string, fields: LogFields = {}) => {
      if (rank(level) > threshold) return;
      output(
        sink,
        JSON.stringify({
          ...(redact(fields) as object),
          time: now().toISOString(),
          level,
          module: redactString(name),
          msg: redactString(msg),
        }),
      );
    };
    return {
      error: (msg, fields) => write('error', msg, fields),
      warn: (msg, fields) => write('warn', msg, fields),
      info: (msg, fields) => write('info', msg, fields),
      debug: (msg, fields) => write('debug', msg, fields),
      child,
      pruneFiles: () => files?.prune(),
      setupToken: (token, url) =>
        output(
          stdout,
          JSON.stringify({
            time: now().toISOString(),
            level: 'warn',
            module: name,
            msg: 'setup required: open the setup URL and enter the setup token',
            setupUrl: url,
            setupToken: token,
          }),
        ),
    };
  };
  return child(module);
}
