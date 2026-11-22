# @standin/contracts

Types, the versioned event schema and the error kinds that every other module shares.

- **Interface:** `SessionEvent` / `EventDraft` / `EVENT_SCHEMA_VERSION` / `isSessionEvent`; `Signal`, `SignalDraft`, `Delivery`, `Decision`; `OgbError` with a closed list of `ErrorKind`s; `JsonValue`. `@standin/contracts/testing` has small builders.
- **Hides:** nothing. It is data and one structural check, on purpose.
- **Never knows:** files, time, HTTP, agents, other modules. It imports nothing (not even node built-ins); `check-boundaries` enforces that.
- **Rules for change:** adding an event type is free; changing the shape of a stored event means raising `EVENT_SCHEMA_VERSION` and teaching the journal to read the old one.
