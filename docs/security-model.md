# Security model

This page will describe, for people running Lightning Pilot, what it protects, how, and what it does not protect
against. It is written as release 0.1 is built.

Already decided, in short:

- Lightning Pilot keeps node credentials on the server, encrypted, and never sends them to the browser.
- It connects to the node with **restricted** credentials that allow only the commands it needs.
- Login needs a password and a TOTP code; payments above a limit you choose need your password again.
- **Spending limits apply to payments made through Lightning Pilot only.** Other apps that talk to the same node
  (for example ZEUS or scripts) are not limited by them.
- It checks that the node is on the chain you chose (Bitcoin BLAKE2b or Bitcoin SHA256d) and refuses to spend if not.
