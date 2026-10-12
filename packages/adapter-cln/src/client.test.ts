// The clnrest HTTPS client against a local HTTPS server that answers like clnrest. Certificates are made with
// openssl for the test (installed on CI runners and developer machines).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdapterError } from '@lightning-pilot/core';
import { ClnRestClient } from './client.ts';

type Handler = (
  body: string,
  headers: Record<string, string | string[] | undefined>,
) => {
  status: number;
  body: string;
  delayMs?: number;
};

const dir = mkdtempSync(join(tmpdir(), 'lp-clnrest-'));
let handler: Handler = () => ({ status: 200, body: '{}' });
let server: Server;
let url: string;
let ca: string;
let otherCa: string;

function selfSigned(name: string, cn: string): { cert: string; key: string } {
  const cert = join(dir, `${name}.pem`);
  const key = join(dir, `${name}.key`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${cn}`,
      '-addext',
      `subjectAltName=DNS:${cn}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

beforeAll(async () => {
  const pair = selfSigned('server', 'localhost');
  ca = pair.cert;
  otherCa = selfSigned('other', 'localhost').cert;
  server = createServer({ cert: pair.cert, key: pair.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const reply = handler(Buffer.concat(chunks).toString('utf8'), { ...req.headers, path: req.url });
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const client = (
  options: Partial<{ caCertificate: string; serverName: string; maxResponseBytes: number; url: string }> = {},
) => new ClnRestClient({ url, caCertificate: ca, serverName: 'localhost', ...options });
const call = (c: ClnRestClient, params: Record<string, unknown> = {}, timeoutMs = 5000) =>
  c.call('getinfo', params, { rune: 'RUNE', timeoutMs });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as AdapterError,
  );

describe('clnrest client', () => {
  it('posts JSON with the rune header, sends bigint amounts exactly, and parses amounts losslessly', async () => {
    let seen: { body: string; headers: Record<string, unknown> } | undefined;
    handler = (body, headers) => {
      seen = { body, headers };
      return { status: 200, body: '{"amount_msat": 9007199254740993, "id": "x"}' };
    };
    const reply = await call(client(), { amount_msat: 9007199254740993n, label: 'l' });
    expect(reply).toEqual({ amount_msat: 9007199254740993n, id: 'x' });
    expect(seen?.body).toBe('{"amount_msat":9007199254740993,"label":"l"}');
    expect(seen?.headers.rune).toBe('RUNE');
    expect(seen?.headers.path).toBe('/v1/getinfo');
  });

  it('refuses a URL that is not https', () => {
    expect(() => client({ url: 'http://127.0.0.1:1' })).toThrow('https');
  });

  it('treats a rune refusal as definitive', async () => {
    handler = () => ({ status: 401, body: '{"code":1502,"data":null,"message":"Not permitted"}' });
    expect(await failure(call(client()))).toMatchObject({
      code: 'node_credential_revoked',
      sent: true,
      definitive: true,
      nodeCode: 1502,
      detail: 'Not permitted',
    });
    handler = () => ({ status: 401, body: '{}' });
    expect(await failure(call(client()))).toMatchObject({ code: 'node_credential_revoked', definitive: true });
  });

  it('reports other node errors as not definitive, with the node code', async () => {
    handler = () => ({ status: 500, body: '{"code":205,"data":null,"message":"no route"}' });
    expect(await failure(call(client()))).toMatchObject({
      code: 'node_error',
      sent: true,
      definitive: false,
      nodeCode: 205,
    });
    handler = () => ({ status: 500, body: '"odd"' });
    const odd = await failure(call(client()));
    expect(odd).toMatchObject({ code: 'node_error', definitive: false, nodeCode: undefined, detail: '"odd"' });
  });

  it('refuses unparsable and oversized replies', async () => {
    handler = () => ({ status: 200, body: 'not json' });
    expect(await failure(call(client()))).toMatchObject({ code: 'node_bad_response', sent: true, definitive: false });
    handler = () => ({ status: 200, body: JSON.stringify({ big: 'x'.repeat(5000) }) });
    expect(await failure(call(client({ maxResponseBytes: 1000 })))).toMatchObject({
      code: 'node_bad_response',
      detail: 'too large',
    });
  });

  it('times out after connecting as sent and not definitive', async () => {
    handler = () => ({ status: 200, body: '{}', delayMs: 500 });
    expect(await failure(call(client(), {}, 100))).toMatchObject({
      code: 'node_unreachable',
      sent: true,
      definitive: false,
    });
  });

  it('refuses another CA, another server name and a closed port before sending anything', async () => {
    handler = () => ({ status: 200, body: '{}' });
    expect(await failure(call(client({ caCertificate: otherCa })))).toMatchObject({
      code: 'node_unreachable',
      sent: false,
    });
    expect(await failure(call(client({ serverName: 'example.org' })))).toMatchObject({
      code: 'node_unreachable',
      sent: false,
    });
    expect(await failure(call(client({ url: 'https://127.0.0.1:1' })))).toMatchObject({
      code: 'node_unreachable',
      sent: false,
    });
  });
});
