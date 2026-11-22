# @standin/plugin-host

Loads plugins (docs/08): manifest, catalogue, install, the one `PluginContext`. It knows no session.

- **Interface:**
  - `parseManifest(json)`: `plugin.json` in the Codex shape (name, version, description, license, ... ; Codex-only fields are ignored) plus our block `extensions.vesper` (`tools`, `sources`, `config`, `secrets`, `effects`, `approval`, `requires`, `defaultEnabled`, `onboardingSkill`). Unknown keys inside our block are errors.
  - `loadPluginDirectory(dir)`: manifest, skills (`skills/<name>/SKILL.md`), `mcp.json` servers, content hash. Runs no plugin code.
  - `parseMarketplace(json)` and `installFromMarketplace({ marketplace, baseDir, cacheDir })`: `local` sources are copied to `<cache>/<marketplace>/<plugin>/<version>/`, checked against the optional `sha256` pin, made read-only and loaded from there; other source types are kept in the file and skipped with a reason. A changed plugin is refused until the owner updates the pin.
  - `createPluginHost(plugins).instantiate({ plugins, contextFor })` returns a frozen `SessionPlugins` snapshot: `tools`, `toolOwners` (with approval mode), `sources`, `skills`, `mcpServers`, `promptSections`, `fingerprint`.
  - `PluginContext` (in contracts) is `{ workspace, secrets, signals, dataDir, log }`, the only thing a plugin receives.
- **Prompt sections:** `extensions.vesper.promptSection` names a markdown file in the plugin; its text (first line `# Title` is the heading) is carried in the snapshot and the runtime hands it to `agents-md`. A plugin that needs to teach the agent something (the handoff plugin's tuned prompt) does it this way.
- **The rule "a session's tool list never changes between turns":** the snapshot is frozen and `setEnabled` only affects snapshots made afterwards; the runtime keeps the snapshot for the life of the session and may compare `fingerprint`.
- **Checks on tools:** the effect of each tool must be declared in the manifest; names are `[a-z][a-z0-9_]*`, not reserved (`read`, `write`, `edit`, `bash`, `tool_search`, `tool_call`, `send_to_user`, `ask_human`), and unique across plugins. Default approval: `irreversible` asks (through `ask_human`), everything else is auto (the review plugin still judges exec and network calls), unless the manifest says otherwise.
- **Hides:** hashing, copying, the dynamic import of plugin modules. **Never knows:** sessions, the router, models, the web page.
- **Trust, stated plainly:** a plugin with native tools runs in our process with our rights. The hash pin and the read-only cache protect against change after review, not against a malicious first version; install only from the owner's marketplace.
