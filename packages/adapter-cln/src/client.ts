// HTTPS client for clnrest: POST /v1/<command> with a JSON body and the rune in the `Rune` header. The node's own
// certificate authority is pinned (and no other CA is trusted), the certificate must be issued for `serverName`,
// responses are size-capped and parsed losslessly. Errors become AdapterError with `sent` telling whether the
// request can have reached the node.
import { request, type RequestOptions } from 'node:https';
import { AdapterError, parseJsonLossless } from '@lightning-pilot/core';

export interface ClnRestOptions {
  url: string;
  caCertificate: string;
  serverName: string;
  // A full raw block in hex on mainnet fits easily (CLN's getrawblockbyheight returns the whole block).
  maxResponseBytes?: number;
}

export interface CallOptions {
  rune: string;
  // Deadline for the whole call, from connecting to the last byte of the reply.
  timeoutMs: number;
  // Aborts the request (an event stream being closed); the call then fails as not sent or not definitive.
  signal?: AbortSignal;
}

const DEFAULT_MAX_RESPONSE = 16 * 1024 * 1024;
// CLN's "Not permitted" code. clnrest answers HTTP 401 when the rune in the header does not allow the command; the
// same code with HTTP 500 is checkrune's answer about another rune, not a refusal of ours.
export const RUNE_REFUSED = 1502;

type RawJson = (text: string) => unknown;
const rawJson = (JSON as unknown as { rawJSON: RawJson }).rawJSON;

// bigint amounts are sent as plain JSON numbers, exactly (JSON.stringify cannot serialise bigint).
function serialise(params: Record<string, unknown>): string {
  return JSON.stringify(params, (_key, value: unknown) =>
    typeof value === 'bigint' ? rawJson(value.toString()) : value,
  );
}

export class ClnRestClient {
  readonly #url: URL;
  readonly #ca: string;
  readonly #serverName: string;
  readonly #maxBytes: number;

  constructor(options: ClnRestOptions) {
    this.#url = new URL(options.url);
    if (this.#url.protocol !== 'https:') throw new Error('clnrest URL must use https');
    this.#ca = options.caCertificate;
    this.#serverName = options.serverName;
    this.#maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE;
  }

  call(command: string, params: Record<string, unknown>, options: CallOptions): Promise<unknown> {
    const body = serialise(params);
    const requestOptions: RequestOptions = {
      method: 'POST',
      protocol: 'https:',
      hostname: this.#url.hostname.replace(/^\[|\]$/g, ''),
      port: this.#url.port || 443,
      path: `${this.#url.pathname.replace(/\/$/, '')}/v1/${encodeURIComponent(command)}`,
      ca: this.#ca,
      servername: this.#serverName,
      rejectUnauthorized: true,
      agent: false,
      headers: {
        Rune: options.rune,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    return new Promise((resolve, reject) => {
      // The request counts as sent once the TLS handshake with the pinned certificate has completed; before
      // that, nothing can have reached the node.
      let connected = false;
      let settled = false;
      // A wall-clock deadline: req.setTimeout only fires on an idle socket, so a reply that keeps arriving slowly
      // would stretch it.
      const deadline = setTimeout(() => {
        fail(new AdapterError({ code: 'node_unreachable', sent: connected, definitive: false, detail: 'timeout' }));
        req.destroy();
      }, options.timeoutMs);
      const fail = (err: AdapterError) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(err);
      };

      const req = request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.#maxBytes) {
            fail(new AdapterError({ code: 'node_bad_response', sent: true, definitive: false, detail: 'too large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => fail(new AdapterError({ code: 'node_unreachable', sent: true, definitive: false })));
        res.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = parseJsonLossless(text);
          } catch {
            fail(new AdapterError({ code: 'node_bad_response', sent: true, definitive: false, detail: text }));
            return;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            settled = true;
            clearTimeout(deadline);
            resolve(parsed);
            return;
          }
          const nodeError = parsed as { code?: unknown; message?: unknown } | null;
          const nodeCode = typeof nodeError?.code === 'number' ? nodeError.code : undefined;
          const detail = typeof nodeError?.message === 'string' ? nodeError.message : text;
          // A refused or invalid rune: the node did nothing.
          if (status === 401) {
            fail(
              new AdapterError({
                code: 'node_credential_revoked',
                sent: true,
                definitive: true,
                ...(nodeCode === undefined ? {} : { nodeCode }),
                detail,
              }),
            );
            return;
          }
          fail(
            new AdapterError({
              code: 'node_error',
              sent: true,
              definitive: false,
              ...(nodeCode === undefined ? {} : { nodeCode }),
              detail,
            }),
          );
        });
      });

      req.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          connected = true;
        });
      });
      req.on('error', (err) => {
        fail(new AdapterError({ code: 'node_unreachable', sent: connected, definitive: false, detail: err.message }));
      });
      const signal = options.signal;
      if (signal) {
        const abort = () => {
          fail(new AdapterError({ code: 'node_unreachable', sent: connected, definitive: false, detail: 'aborted' }));
          req.destroy();
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', abort));
      }
      req.end(body);
    });
  }
}
