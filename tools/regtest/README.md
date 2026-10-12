# tools/regtest

A regtest test environment with two separate chains side by side, used by CI (the `contract-blake2b` and
`contract-sha256d` jobs) and by developers:

| Chain     | Bitcoin node                                      | Lightning nodes                             | Lightning Pilot profile |
| --------- | ------------------------------------------------- | ------------------------------------------- | ----------------------- |
| `blake2b` | Bitcoin Knots, BLAKE2b proof of work from block 1 | `cln-a`, `cln-b`, `cln-c`: BLAKE2b CLN fork | `blake2b`               |
| `sha256d` | Bitcoin Core                                      | `cln-a`, `cln-b`, `cln-c`: Core Lightning   | `bitcoin`               |

The two chains never connect: separate data, separate ports, no DNS seeds, bound to `127.0.0.1`. LND nodes are added
with the LND adapter.

## Use

Requirements: Linux x86-64, `bash`, `curl`, `python3`, `tar` with xz support, and the libraries the Core Lightning
release needs (`libpq5 libsodium23 libsqlite3-0` on Ubuntu).

```sh
tools/regtest/regtest all fetch          # download, verify and unpack the pinned binaries
tools/regtest/regtest blake2b init       # start the nodes, fund them, open the channels, make sample payments
tools/regtest/regtest blake2b check      # quick smoke test (PASS/FAIL lines, non-zero exit on failure)
LP_REGTEST_CHAIN=blake2b pnpm test:regtest   # adapter contract tests and the end-to-end API test
tools/regtest/regtest blake2b status
tools/regtest/regtest blake2b pay cln-a cln-c 20000
tools/regtest/regtest blake2b cli cln-a listfunds
tools/regtest/regtest blake2b creds cln-a view    # URL, CA certificate and a restricted rune
tools/regtest/regtest all down           # stop everything, keep the data
tools/regtest/regtest sha256d reset --yes # delete that chain's data (downloads and binaries are kept)
```

Run `tools/regtest/regtest` without arguments for the full command list. `init` is safe to re-run.

Environment variables:

- `LP_REGTEST_HOME`: where downloads (`cache/`), binaries (`<chain>/bin/`) and node data (`<chain>/data/`) live.
  Default: `.regtest/` at the repository root (ignored by git).
- `LP_REGTEST_PORT_OFFSET`: added to every port, to run next to another environment that uses the same ports.

## Ports and channels

| Node                                        | `blake2b`                     | `sha256d`                     |
| ------------------------------------------- | ----------------------------- | ----------------------------- |
| `btc` P2P / RPC / ZMQ block / ZMQ tx        | 19100 / 19102 / 19104 / 19105 | 19300 / 19302 / 19304 / 19305 |
| `cln-a` / `cln-b` / `cln-c` P2P             | 19110 / 19112 / 19114         | 19310 / 19312 / 19314         |
| `cln-a` / `cln-b` / `cln-c` clnrest (HTTPS) | 19120 / 19122 / 19124         | 19320 / 19322 / 19324         |

Knots binds an onion listener on P2P + 1, so every P2P port leaves a gap after it.

After `init`: `cln-a` → `cln-b` 2,000,000 sat (1,000,000 pushed), `cln-b` → `cln-c` 1,500,000 sat, `cln-c` → `cln-a`
1,000,000 sat. Every node has two channels and can both pay and receive.

## Credentials

`creds <node> <level>` creates a rune once and then reuses it. The runes carry exactly the method lists of Lightning
Pilot's credential scopes (`view`, `spend`, `full`), each starting with `["id!"]` so they work over clnrest only, never
over commando from a peer. The tests read the connection details from this output, so they use the same restricted
credentials a real installation would. `packages/adapter-cln` checks its method table against these lists.

## Pinned versions

`versions.json` pins, per chain, the release archive of each node: URL and SHA-256. `fetch` refuses any archive whose
SHA-256 differs from the pin and removes it; there is no fallback. Archives are cached under their SHA-256, so a second
`fetch` (and most CI runs) downloads nothing.

The SHA-256 pin is the security check at download time. The release signature is checked once, by hand, when a pin is
changed; `signers` records the fingerprints of the keys that signed the pinned release.

### Updating a pin

One entry per pull request. CI then shows whether the adapters still work with the new version.

1. Download the new archive and its checksum files from the project's release page (Knots and CLN-fork releases on
   GitHub, Bitcoin Core from `bitcoincore.org/bin/bitcoin-core-<version>/`, Core Lightning on GitHub):
   `SHA256SUMS` and `SHA256SUMS.asc` (Knots, Bitcoin Core), `SHA256SUMS-<version>` and `SHA256SUMS-<version>.asc`
   (Core Lightning and the CLN fork).
2. Import the signers' public keys into a separate keyring and check the signature:

   ```sh
   export GNUPGHOME=$(mktemp -d)
   gpg --import <keys>   # the CLN fork ships its key as privkeyio-signing-key.asc in the release
   gpg --verify --status-fd 1 SHA256SUMS.asc SHA256SUMS | grep VALIDSIG
   ```

   Each `VALIDSIG` line ends with the primary key fingerprint of a signer. Compare them with `signers` in
   `versions.json`, and confirm any new signer through a second source (the project's own key list or release notes).

3. Take the archive's line from the verified checksum file, check the download against it (`sha256sum -c`), and
   update `version`, `url` and `sha256` (and `signers` if they changed) in `versions.json`.
4. Run `tools/regtest/regtest <chain> reset --yes`, `fetch`, `init`, `check` and `LP_REGTEST_CHAIN=<chain> pnpm
test:regtest`, and update `TESTED_VERSIONS` in `packages/chain/src/profile.ts`.

## Caveat

On regtest the chain identity check is a convenience, not a guarantee: regtest options can make a chain look like
either profile. Lightning Pilot accepts regtest nodes only when started with `--dev`.
