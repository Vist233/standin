# @standin/agents-md

Generates the `AGENTS.md` that is written into each session's files directory (docs/07 section 8).

- **Interface:** `renderAgentsMd({ profile, sessionName, workspace, findableTools }) -> string`; `SECTIONS` (ids and headings in order); `headingsOf(text)`; `@standin/agents-md/testing` has `sampleAgentsMdInput()`.
- **Sections:** who you are; channel order; your tools (original tools plus `tool_search`/`tool_call` plus the profile's always-declared tools); messages that arrive while you work (the signal header and the `| ` quoting of the router); safety; speaking (quiet by default); the memo folder rules; the sections the session's plugins contribute (`pluginSections`; agents-md knows no plugin by name); this session (name, profile, directory, display, browser, findable tools, notes from the box).
- **Stable text first:** everything that differs per session is in the last section, so a prompt cache can reuse the rest across sessions.
- **Hides:** the wording. **Never knows:** the runtime, files (it returns a string; the caller writes it), models, how plugins are loaded. Pure: no node built-ins.
