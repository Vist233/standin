# @standin/secrets

References in, values out, at the moment of use.

- **Interface:** `SecretProvider.resolve(reference) -> Promise<string>` (the `SecretResolver` of contracts). `createEnvironmentProvider({ env, allowed })` (the container's environment, only the listed names), `createOnePasswordSlot()` (a RESERVED slot the owner asked to keep: fails with `unavailable` until the real provider exists), `createSecretRegistry({ scheme: provider })` (routes `env:KEY`, later `op:vault/item/field` or `op://...`). `@standin/secrets/testing` has `createFakeSecrets`.
- **Hides:** where values live, the file format, permission checks.
- **Never knows:** which tool or model uses a value, sessions, the review plugin.
- **Values are never logged:** error messages hold the reference name or a line number, never a value or a line of the file; nothing is cached, so an edited key takes effect at once and memory holds a value only while a caller does.
- **Not here:** masking resolved values in tool output is the redaction plugin's job (docs/07 section 9).
