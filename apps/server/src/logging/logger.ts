// The service log: one JSON object per line (JSONL) on stdout. Fields: time, level, module, msg (fixed text, no
// values interpolated), requestId, then named fields, all redacted (redact.ts). Log files with daily rotation come
// later; stdout is what container runtimes and journald collect.
import type { ChannelId, FundingOutpoint, PaymentHash, Pubkey, Txid } from '@lightning-pilot/core';
import { redact } from './redact.ts';

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
}

const rank = (level: Level) => LEVELS.indexOf(level);
const defaultSink: Sink = (line) => process.stdout.write(line + '\n');

export function createLogger(options: LoggerOptions = {}, module = 'server'): Logger {
  const sink = options.sink ?? defaultSink;
  const stdout = options.stdout ?? sink;
  const now = options.now ?? (() => new Date());
  const threshold = rank(options.modules?.[module] ?? options.level ?? 'info');

  const write = (level: Level, msg: string, fields: LogFields = {}) => {
    if (rank(level) > threshold) return;
    const { requestId, ...rest } = fields;
    const entry = {
      time: now().toISOString(),
      level,
      module,
      msg,
      ...(requestId === undefined ? {} : { requestId }),
      ...(redact(rest) as object),
    };
    sink(JSON.stringify(entry));
  };

  return {
    error: (msg, fields) => write('error', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    debug: (msg, fields) => write('debug', msg, fields),
    child: (name) => createLogger(options, name),
    setupToken: (token, url) => {
      stdout(
        JSON.stringify({
          time: now().toISOString(),
          level: 'warn',
          module,
          msg: 'setup required: open the setup URL and enter the setup token',
          setupUrl: url,
          setupToken: token,
        }),
      );
    },
  };
}
