# mail-temp (plugin)

Every bot gets its own mail address on the owner's domain, through the owner's deployment of cloudflare_temp_email (Cloudflare Email
Routing into a Worker and D1). The address is made the first time the bot starts with the plugin (`bot-<workspace>@<domain>`) and kept for
that bot; its token stays in the plugin's data directory of that session (`address/account.json`, mode 600) and never reaches the model.

- **On only when configured:** `OGB_TEMP_MAIL_URL` (the Worker's API address) and `OGB_TEMP_MAIL_DOMAIN`. Without them the built-in
  profiles do not list the plugin at all. Secrets: `OGB_TEMP_MAIL_ADMIN` (needed once per address) and `OGB_TEMP_MAIL_SITE_PASSWORD` (when
  the deployment has a site password); the app takes both out of the environment at start.
- **Tools:** `mail_list`, `mail_read`, `mail_send` from `@vesper/connectors` (the address is in their descriptions). New mail is a signal
  (polled every 15 s; `OGB_TEMP_MAIL_POLL_MS` changes it).
- **Sending** needs a sending method on the deployment (Resend, SMTP or Cloudflare's binding) and send balance for the address; without
  them a send fails with the deployment's own message.
- **Read state** is kept here (`address/read.json`): the deployment has none.
- **Tests:** the shared provider contract against a stand-in deployment (`@vesper/connectors/testing`), and this plugin's own file.
  A real deployment is tested by hand (the Desktop handbook).
