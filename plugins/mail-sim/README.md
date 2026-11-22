# mail-sim (plugin)

A simulated mailbox and calendar in plain files: the test double and the demo of every mail provider plugin (the real ones, `mail-imap-smtp` and the OAuth ones, follow the same interfaces and pass the same contract suite). Mail is a tool, not the product: nothing here needs a domain or an account.

- **Make mail arrive:** drop a JSON file `{ "from": "...", "subject": "...", "body": "...", "date": <ms, optional> }` into `<session data>/mail-sim/mailbox/inbox/` (write it to a temporary name and rename it, so it appears whole). The file name is the message id. Events dropped into `calendar/` as `{ "title", "start", "end", "attendees" }` (times in ms) arrive the same way. Sent mail is written to `sent/`; events the agent creates get a `self-` id and do not come back as signals.
- **Poll interval:** 1000 ms; `OGB_MAIL_SIM_POLL_MS` changes it (the tests use 15).
- **One mailbox per session** (in the session's own data directory). Routing one real account to the right sessions is a later design question (open-questions 11).
- **What the agent gets:** the tools of `@standin/connectors` and a prompt section about mail (data from outside, approvals); a new mail or event is a signal that steers a running agent or starts a run (router rules).
- **Tests:** the shared provider contract suite; the file behaviours; and through the whole system with the framework's real agent loop (`test/plugins/mail-sim.integration.test.ts`).
