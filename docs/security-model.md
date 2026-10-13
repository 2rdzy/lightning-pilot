# Security model

This page will describe, for people running Lightning Pilot, what it protects, how, and what it does not protect
against. It is written as release 0.1 is built.

Release 0.1 is not finished, and an early build should not hold real funds or real node credentials. What the
code does today and what is decided but not built yet are listed separately below, so a protection is never
assumed before it exists.

Implemented now:

- Node credentials are kept on the server, encrypted with a vault key held outside the database, and never sent to
  the browser.
- Login needs the owner's password; sessions live on the server and end at logout.
- It checks that the node is on the chain you chose (Bitcoin BLAKE2b or Bitcoin SHA256d) and refuses to spend if not,
  including a refusal that arrives while a payment is being started.

Decided, not built yet:

- Login will need a TOTP code as well as the password, and login attempts will be throttled.
- Payments above a limit you choose will need your password again (step-up).
- **Spending limits will apply to payments made through Lightning Pilot only.** Other apps that talk to the same node
  (for example ZEUS or scripts) are not limited by them.
- Lightning Pilot will refuse node credentials that are not **restricted** to the commands it needs. Until then,
  creating restricted credentials is up to the person adding the node.
