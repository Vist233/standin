# mail-outlook (plugin)

The person's own Outlook mailbox (Outlook.com or Microsoft 365) through Microsoft Graph. **One bot holds it:** the first bot the person
signs in with. Other bots that have the plugin are told it belongs to another bot.

- **Set up once (the owner):** an app registration in Microsoft Entra: "personal Microsoft accounts" (or work accounts) allowed, "allow
  public client flows" on, delegated permissions `User.Read`, `Mail.ReadWrite`, `Mail.Send` (`offline_access` is asked at sign-in). No
  client secret, no redirect address. Then `OGB_OUTLOOK_CLIENT_ID=<application id>` and, for Outlook.com only, `OGB_OUTLOOK_TENANT=consumers`.
  Without the id the built-in profiles do not list the plugin.
- **Connect (the person, in the chat):** the bot calls `outlook_connect` and passes a page and a code; the person signs in; the bot is told
  by a signal when it is connected. Tokens: the plugin's shared directory (`tokens.json`, mode 600; Microsoft replaces the refresh token
  on every use and the newest is written back), and `owner.json` names the bot. To move the account to another bot, delete both files.
- **Tools:** `outlook_connect`, `outlook_list`, `outlook_read` (marks read), `outlook_send` (a draft, then send; ids are immutable). New mail is a
  signal (every 30 s).
- **Tests:** the shared provider contract against stand-ins of Microsoft's sign-in and Graph (`@vesper/connectors/testing`); the device
  code, declined sign-in, refresh with a replaced refresh token; one owner among two bots. A real account is tested by hand.
