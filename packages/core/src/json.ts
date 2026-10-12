// Lossless parsing of node responses. Nodes send msat amounts as JSON numbers, which JSON.parse would round above
// 2^53. The reviver reads each number's source text (Node 22+), so amounts (`*_msat` fields) and any other integer
// too large for a double become bigint, exactly as the node sent them.

type ReviverContext = { source?: string };
type LosslessReviver = (this: unknown, key: string, value: unknown, context?: ReviverContext) => unknown;

const reviver: LosslessReviver = (key, value, context) => {
  if (typeof value !== 'number' || context?.source === undefined) return value;
  const source = context.source;
  const isInteger = /^-?[0-9]+$/.test(source);
  if (key.endsWith('_msat')) {
    if (!isInteger) throw new SyntaxError(`amount field ${key} is not an integer`);
    return BigInt(source);
  }
  if (isInteger && !Number.isSafeInteger(value)) return BigInt(source);
  return value;
};

export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, reviver as (this: unknown, key: string, value: unknown) => unknown);
}
