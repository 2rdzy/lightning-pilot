// @lightning-pilot/adapter-kit: the fake in-memory adapter and the adapter contract suite. Depends only on core.
// The contract suite imports vitest, so only test files import `./contract.ts` (through '@lightning-pilot/adapter-kit/contract').
export { FakeAdapter, FakeNetwork, type FakeNodeOptions } from './fake.ts';
