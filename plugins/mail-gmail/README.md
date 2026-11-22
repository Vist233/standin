# mail-gmail (plugin)

The person's Gmail through IMAP and SMTP with an **app password** (no OAuth app, no token that expires after 7 days). Any other IMAP and
SMTP mailbox works the same way with other hosts. **One bot holds it:** the bot whose `gmail_connect` the person approved.

- **Set up once (the owner):** 2-step verification on the Google account, then an app password (Google account, Security, App passwords).
  `OGB_GMAIL_ADDRESS=<address>` and the secret `OGB_GMAIL_APP_PASSWORD`; other servers: `OGB_GMAIL_IMAP_HOST` and `OGB_GMAIL_SMTP_HOST`
  (`host` or `host:port`; defaults `imap.gmail.com:993`, `smtp.gmail.com:465`). Without the address the built-in profiles do not list the
  plugin, and the libraries (imapflow, nodemailer, mailparser) are never loaded.
- **An app password reaches the whole mailbox.** It cannot be limited to reading; the plugin only promises what its tools do.
- **Connect (in the chat):** the bot calls `gmail_connect`; the person approves it; the login is checked; `owner.json` in the plugin's
  shared directory names the bot. Delete it to give the mailbox to another bot.
- **Tools:** `gmail_connect`, `gmail_list` (the words are AND, one server search per word), `gmail_read` (marks read), `gmail_send` (Gmail
  files the sent copy itself; other servers get it appended). New mail is a signal (every 30 s).
- **Tests:** the shared provider contract over a memory IMAP store (`test/memory-store.ts`), the claiming by one bot, the settings. The
  imapflow adapter (`src/imap.ts`) is tested against a real account by hand.
