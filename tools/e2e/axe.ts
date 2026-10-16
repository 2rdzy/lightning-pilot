// axe-core in a Playwright page served by the real server. The CSP allows scripts from 'self' only, so axe is not
// added as a <script> tag (refused) and the CSP is not bypassed (that would hide the violations the console check
// catches): its source runs through Playwright's evaluate, which the page's CSP does not govern.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

interface Violation {
  id: string;
  help: string;
  nodes: { target: string[] }[];
}

export async function expectAccessible(page: Page, label: string): Promise<void> {
  await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async () => {
    const axe = (
      globalThis as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: unknown }> } }
    ).axe;
    const result = await axe.run((globalThis as unknown as { document: unknown }).document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return result.violations as Violation[];
  });
  const problems = violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  expect(problems, `${label}\n${problems.join('\n')}`).toEqual([]);
}
