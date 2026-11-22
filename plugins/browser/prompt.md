# Using the browser

The `browser` tool runs JavaScript (Playwright) against this workspace's browser, which keeps the person's logins. Use it when a command or an API cannot do the job.
- Work in code: one call can do a whole form, a list or several pages, and read back what changed. Return evidence (a count, a text, a value), not "clicked".
- Find things with locators first (`getByRole`, `getByLabel`, `getByText`), look with `snapshot()` when you do not know the page, use `screenshot()` and the mouse only where there are no elements.
- After a hand-back from the person, your `page` may show something else: look before acting.
- Logins, one-time codes, CAPTCHAs, payments and anything needing the person's identity: ask with `ask_human` and stop. Never type a password you were not given.
