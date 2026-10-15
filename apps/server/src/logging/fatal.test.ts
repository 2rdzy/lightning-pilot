import { expect, it, vi } from 'vitest';
import { createLogger } from './logger.ts';
import { fatalError } from './fatal.ts';

it('redacts an uncaught error stack and exits with status 1', () => {
  const lines: string[] = [];
  const exit = vi.fn();
  const secret = 'ab'.repeat(32);
  fatalError(createLogger({ sink: (line) => lines.push(line) }), new Error(`failed ${secret}`), exit);
  expect(lines.join('\n')).toContain('uncaught error');
  expect(lines.join('\n')).not.toContain(secret);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
it('does not serialize an arbitrary rejection reason', () => {
  const lines: string[] = [];
  const exit = vi.fn();
  fatalError(createLogger({ sink: (line) => lines.push(line) }), { password: 'short-sensitive' }, exit);
  expect(lines.join('\n')).not.toContain('short-sensitive');
  expect(exit).toHaveBeenCalledWith(1);
});
it('still exits when even a replaced logger method throws', () => {
  const logger = createLogger({ sink: () => undefined });
  const exit = vi.fn();
  vi.spyOn(logger, 'error').mockImplementation(() => {
    throw new Error('broken logger');
  });
  expect(() => fatalError(logger, new Error('unexpected'), exit)).not.toThrow();
  expect(exit).toHaveBeenCalledWith(1);
});
