# @standin/event-journal

A per-session, append-only log of events with sequence numbers. It is the commit point of a session: when `append` resolves, the event is on disk (flushed, unless `fsync: false`).

- **Interface** (`EventJournal`): `append(sessionId, draft)`, `read(sessionId, after?)`, `subscribe(sessionId, after?)` (replay then follow; `after` is the page's `Last-Event-ID`), `lastSeq`, `close`. Implementation: `createFileJournal({ directory, now?, fsync? })`. `@standin/event-journal/testing` has `createMemoryJournal` (with `failNextAppends` for a full disk) and `journalContract`, the suite that both implementations pass.
- **Hides:** the file format (JSON Lines, one file per session), the flush policy, repair of an interrupted last write, the ordering of concurrent appends, how replay and live events are joined without gaps or repeats.
- **Never knows:** who reads it, what the event types mean, sessions' contents, HTTP, agents.
- **Faults:** a crash in the middle of a write leaves a last line without a newline; it is dropped and the file repaired on first use. A failed write stores nothing and leaves no half line. Damage in the middle of a file, a wrong sequence number or a newer schema version is an error (`corrupt`, `unsupported_version`); nothing is guessed. Bad ids and payloads are `invalid_input`; environment problems are `unavailable`.
- **Limits (stated, not hidden):** one writer process per directory (no lock file yet); `read` parses the whole file (fine for a session's size now; an index or segment files are a later change behind the same interface); no compaction.
