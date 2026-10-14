// Resolve port declarations so aliases, destructuring and computed access cannot bypass spend admission.
import ts from 'typescript';
import { resolve } from 'node:path';
let program;
const methods = {
  PeerPort: ['connect', 'disconnect'],
  ChannelPort: ['openChannel', 'closeChannel', 'setPolicy'],
  PayPort: ['pay', 'keysend'],
  OnchainPort: ['prepare', 'send', 'discard', 'unreserve'],
};
function spending(symbol) {
  return symbol?.declarations?.some((d) => {
    const file = d.getSourceFile().fileName;
    if (ts.isMethodSignature(d) && ts.isInterfaceDeclaration(d.parent) && file.endsWith('/packages/core/src/ports.ts'))
      return methods[d.parent.name.text]?.includes(d.name.getText());
    // Inferred concrete adapter types retain their implementation declarations instead of the interface methods.
    const callable =
      ts.isMethodDeclaration(d) ||
      ((ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) &&
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)));
    return (
      callable &&
      /\/packages\/adapter-(cln|kit|lnd)\/src\/(adapter|fake)\.ts$/.test(file) &&
      Object.values(methods).flat().includes(d.name.getText())
    );
  });
}
export const spendBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { boundary: 'Only the spend module may access adapter spend methods. Use the spend admission pipeline.' },
  },
  create(context) {
    return {
      Program() {
        if (!program) {
          const config = ts.readConfigFile(resolve('apps/server/tsconfig.json'), ts.sys.readFile);
          const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('apps/server'));
          program = ts.createProgram(parsed.fileNames, parsed.options);
        }
        const file = program.getSourceFile(resolve(context.filename));
        if (!file) return;
        const checker = program.getTypeChecker();
        const visit = (node) => {
          let forbidden = false;
          if (ts.isPropertyAccessExpression(node)) forbidden = spending(checker.getSymbolAtLocation(node.name));
          if (ts.isElementAccessExpression(node)) {
            const type = checker.getTypeAtLocation(node.expression);
            forbidden = ts.isStringLiteralLike(node.argumentExpression)
              ? spending(type.getProperty(node.argumentExpression.text))
              : type.getProperties().some(spending);
          }
          if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
            const name = node.propertyName ?? node.name;
            if (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
              forbidden = spending(checker.getTypeAtLocation(node.parent).getProperty(name.text));
          }
          if (forbidden)
            context.report({ loc: context.sourceCode.getLocFromIndex(node.getStart(file)), messageId: 'boundary' });
          ts.forEachChild(node, visit);
        };
        visit(file);
      },
    };
  },
};
