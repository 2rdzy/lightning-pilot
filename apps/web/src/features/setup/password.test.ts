import { expect, it } from 'vitest';
import { Password } from '@lightning-pilot/core';
import { generatePassword } from './password.ts';
it('generates distinct passwords that always meet the shared policy', () => {
  const values = Array.from({ length: 100 }, () => generatePassword());
  expect(new Set(values).size).toBe(100);
  for (const value of values) expect(Password.safeParse(value).success).toBe(true);
});
