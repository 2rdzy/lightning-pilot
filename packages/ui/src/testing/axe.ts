// Runs axe-core (MPL-2.0, development only: dependencies §1 rule 4 exception) on a rendered component and fails with
// the rule ids and the offending nodes. WCAG 2.0–2.2 A and AA rules, as the style guide requires (§1, §9).
import axe from 'axe-core';
import { expect } from 'vitest';

export async function expectAccessible(context: Element | Document = document): Promise<void> {
  const result = await axe.run(context, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    resultTypes: ['violations'],
  });
  const problems = result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  );
  expect(problems, problems.join('\n')).toEqual([]);
}
