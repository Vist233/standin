# @standin/session-store

Where a session's files live and the list of sessions.

- **Interface:** `createFileSessionStore({ root, now?, newId? })` returns a `SessionStore`: `create`, `get`, `list` (`{ sessions, damaged }`), `update` (title, status), `delete` (idempotent), `paths(id)` (`agentFile`, `journalDirectory`, `dataDirectory`). `@standin/session-store/testing` has `createTempSessionStore()`.
- **Layout:** `<root>/sessions/<id>/` holds `session.json` (the record), the framework's `agent.jsonl`, `journal/` and `data/`. Everything of a session is in one directory, so delete cannot leave anything behind, and there is no separate index that could disagree with the files.
- **Hides:** the layout on disk, atomic write of the record (temporary file and rename), id generation.
- **Never knows:** models, tools, plugins, what is inside the profile (it keeps it as JSON), the journal's format, the framework's file format.
