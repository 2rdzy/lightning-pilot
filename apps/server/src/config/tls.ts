import { X509Certificate, createPrivateKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupProgress } from '@lightning-pilot/core';
import { ConfigError, type Config } from './config.ts';
import { assertProtectedFile } from './ownership.ts';
import type { Logger } from '../logging/logger.ts';

export function tlsPaths(config: Config): { certFile: string; keyFile: string } {
  if (config.tls.mode === 'self-signed')
    return {
      certFile: join(config.paths.dataDir, 'tls/cert.pem'),
      keyFile: join(config.paths.dataDir, 'tls/key.pem'),
    };
  if (!config.tls.certFile || !config.tls.keyFile) throw new ConfigError('TLS certificate and key paths are required');
  return { certFile: config.tls.certFile, keyFile: config.tls.keyFile };
}

export function inspectTls(
  config: Config,
  logger: Logger,
  dev = false,
  now = new Date(),
): SetupProgress['tlsCertificate'] {
  if (config.server.torPort !== undefined || config.tor.hostnameFile !== undefined)
    throw new ConfigError('the Tor listener is not supported in release 0.1');
  if (config.tls.mode === 'off') return undefined;
  const { certFile, keyFile } = tlsPaths(config);
  try {
    if (!dev) assertProtectedFile(keyFile, config.tls.mode === 'self-signed' ? process.getuid?.() : 0);
    const cert = new X509Certificate(readFileSync(certFile));
    if (!dev && config.tls.mode === 'self-signed' && (lstatSync(keyFile).mode & 0o077) !== 0)
      throw new Error('generated TLS key must be private');
    const keyBytes = readFileSync(keyFile);
    let key;
    try {
      key = createPrivateKey(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
    if (!cert.checkPrivateKey(key)) throw new Error('certificate does not match key');
    const expiresAt = new Date(cert.validTo).toISOString();
    if (now.getTime() < Date.parse(cert.validFrom) || now.getTime() >= Date.parse(expiresAt))
      throw new Error('certificate is not currently valid');
    const info = { fingerprintSha256: cert.fingerprint256, expiresAt };
    logger.info('TLS certificate', { certificate: info });
    if (Date.parse(expiresAt) - now.getTime() <= 30 * 86400000)
      logger.warn('TLS certificate expires soon', { expiresAt });
    return info;
  } catch {
    throw new ConfigError(`TLS certificate/key missing, unsafe, invalid or mismatched: ${certFile}, ${keyFile}`);
  }
}
