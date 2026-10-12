// Licence check for everything that ships (dependency policy rule 4): runtime dependencies of every workspace
// package must be MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0 or Unlicense (a public-domain dedication,
// more permissive than MIT; used by `isbot`, which TanStack Router needs). Development tools are not shipped and are
// not checked here.
import { execFileSync } from 'node:child_process';

const allowed = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'Unlicense']);

const output = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json', '--recursive'], { encoding: 'utf8' });
const byLicence = JSON.parse(output);

const refused = [];
let count = 0;
for (const [licence, packages] of Object.entries(byLicence)) {
  for (const pkg of packages) {
    count += 1;
    if (!allowed.has(licence)) refused.push(`${pkg.name}@${pkg.versions?.join(',') ?? pkg.version} (${licence})`);
  }
}

if (refused.length > 0) {
  console.error(`Licence check failed for ${refused.length} runtime package(s):\n  ${refused.join('\n  ')}`);
  process.exit(1);
}
console.log(`Licence check passed: ${count} runtime packages, all with an allowed licence.`);
