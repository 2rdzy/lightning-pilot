// Proves that the lint rules of eslint.config.js enforce the module boundaries of the architecture (§4):
// a forbidden import fails lint whether it uses the package name or a relative path, and an allowed one passes.
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const eslint = new ESLint();

async function errorsFor(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId ?? 'parse-error');
}

describe('module boundaries', () => {
  beforeAll(async () => {
    // Cold ESLint configuration and the server's TypeScript program can exceed five seconds on CI.
    // Keep initialization separate from the assertions, which retain their normal test timeout.
    await errorsFor('apps/web/src/probe.ts', '');
    await errorsFor('apps/server/src/probe.ts', '');
  }, 30000);

  it('refuses an adapter imported by package name from the web app', async () => {
    const errors = await errorsFor('apps/web/src/probe.ts', "import '@lightning-pilot/adapter-cln';\n");
    expect(errors).toContain('no-restricted-imports');
  });

  it('refuses an adapter imported by relative path from the web app', async () => {
    const errors = await errorsFor('apps/web/src/probe.ts', "import '../../../packages/adapter-cln/src/index.ts';\n");
    expect(errors).toContain('boundaries/dependencies');
  });

  it('refuses any of our packages in core', async () => {
    const errors = await errorsFor('packages/core/src/probe.ts', "import '@lightning-pilot/chain';\n");
    expect(errors).toContain('no-restricted-imports');
  });

  it('refuses the UI package in the server', async () => {
    const errors = await errorsFor('apps/server/src/probe.ts', "import '@lightning-pilot/ui';\n");
    expect(errors).toContain('no-restricted-imports');
  });

  it('allows core from the web app and from an adapter', async () => {
    expect(await errorsFor('apps/web/src/probe.ts', "import '@lightning-pilot/core';\n")).toEqual([]);
    expect(await errorsFor('packages/chain/src/probe.ts', "import '../../core/src/index.ts';\n")).toEqual([]);
  });

  it('refuses dangerouslySetInnerHTML', async () => {
    const errors = await errorsFor(
      'packages/ui/src/probe.tsx',
      'export const X = () => <div dangerouslySetInnerHTML={{ __html: "" }} />;\n',
    );
    expect(errors).toContain('no-restricted-syntax');
  });
});
