# Contributing

Lightning Pilot is a TypeScript monorepo managed with pnpm.

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm through Corepack: `corepack enable` (the version is pinned in `package.json`)

## Everyday commands

```sh
pnpm install --frozen-lockfile
pnpm check          # formatting, lint (including module boundaries), type-check, tests, licence check
```

## Layout

| Directory                                      | Contents                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/core`                                | Domain types and schemas, money, errors, ports, the API contract                   |
| `packages/chain`                               | Chain profiles (BLAKE2b and SHA256d): identity rules, feature bits, header parsing |
| `packages/adapter-cln`, `packages/adapter-lnd` | Node adapters                                                                      |
| `packages/adapter-kit`                         | Fake adapter and the adapter contract tests                                        |
| `packages/ui`                                  | Design system                                                                      |
| `apps/server`                                  | HTTP API and server modules                                                        |
| `apps/web`                                     | Web app                                                                            |

Module boundaries are enforced by lint: `core` depends on nothing of ours; `chain` and the adapters only on `core`;
the web app only on `core` and `ui`; the server on everything except `ui`.

## Rules for changes

- One change per pull request, with tests. The pull request runs the same checks as `pnpm check`.
- Dependencies are exact versions, at least 7 days old, with MIT, ISC, BSD, Apache-2.0 or Unlicense licences for
  anything that ships. Adding one needs a justification in the pull request.
- No install scripts except the ones allowed in `pnpm-workspace.yaml`.
- Never paste node credentials, seeds or real invoices into issues, tests or logs.
