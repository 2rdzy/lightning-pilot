import { expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { createTranslator } from '../i18n/messages.ts';
import { MESSAGES_EN } from '../app/i18n.tsx';
import { errorText } from './parts.tsx';

const tr = createTranslator(MESSAGES_EN, 'en');

it('says how long to wait when a request is throttled', () => {
  const early = (details: unknown) =>
    new ApiError('too_early', 'Wait before trying to log in again.', 429, 'r', details);
  expect(errorText(tr, early({ retryAfter: 1 }))).toBe('Too many attempts. Wait 1 second before trying again.');
  expect(errorText(tr, early({ retryAfter: 900 }))).toBe('Too many attempts. Wait 900 seconds before trying again.');
  // Without a usable value the server's own message is shown.
  expect(errorText(tr, early(undefined))).toBe('Wait before trying to log in again.');
  expect(errorText(tr, early({ retryAfter: 'soon' }))).toBe('Wait before trying to log in again.');
  expect(errorText(tr, new ApiError('busy', 'Busy.', 503))).toBe('The server is busy. Try again shortly.');
});
