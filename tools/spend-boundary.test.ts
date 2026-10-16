import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';
it('refuses every adapter spend method outside spend, including aliases, destructuring and dynamic access', async () => {
  const file = resolve('apps/server/src/wp09-boundary-fixture.ts');
  try {
    writeFileSync(
      file,
      `import type { NodeAdapter } from '@lightning-pilot/core';
      import type { NodesService } from './modules/nodes/index.ts';
      declare const nodes: NodesService;
      void nodes.spendingAdapter;
      const {spendingAdapter} = nodes; void spendingAdapter;
      import { createClnAdapter } from '@lightning-pilot/adapter-cln';
      declare const adapter: NodeAdapter;
      void adapter.peer.connect; void adapter.peer.disconnect;
      void adapter.channel.openChannel; void adapter.channel.closeChannel; void adapter.channel.setPolicy;
      void adapter.pay.pay; const { keysend } = adapter.pay; void keysend;
      void adapter.onchain.prepare; void adapter.onchain['send']; void adapter.onchain.discard; void adapter.onchain.unreserve;
      const port = adapter.pay; void port.pay;
      declare const key: keyof NodeAdapter['onchain']; void adapter.onchain[key];
      const concrete = createClnAdapter({ url:'https://localhost', caCertificate:'test', serverName:'localhost', viewRune:'view' });
      void concrete.pay.pay; void concrete.onchain.prepare; void concrete.pay.getPayment;
      void adapter.pay.getPayment; void adapter.receive.createInvoice; void adapter.node.getInfo;
    `,
    );
    const output = await new ESLint().lintFiles([file]);
    expect(output[0]?.messages.filter((m) => m.ruleId === 'spend/boundary')).toHaveLength(17);
  } finally {
    rmSync(file, { force: true });
  }
}, 30000);
