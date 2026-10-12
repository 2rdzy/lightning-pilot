# Lightning Pilot

A self-hosted web app to manage Lightning nodes on **Bitcoin BLAKE2b** and **Bitcoin (SHA256d)**: channels, peers,
liquidity, payments and on-chain funds, from a desktop browser or a phone.

**Status: early development.** Nothing here is ready to use yet. Release 0.1 will manage one Core Lightning node on
either chain, with a security-first design: restricted node credentials, two-factor login, spending limits with a
preview before every payment, and a check that the node is on the chain you chose. LND support follows in 0.2.

- How Lightning Pilot protects your node and what it does not protect against: [docs/security-model.md](docs/security-model.md)
- Reporting a security problem: [SECURITY.md](SECURITY.md)
- Working on the code: [CONTRIBUTING.md](CONTRIBUTING.md)

Licence: [MIT](LICENSE).
