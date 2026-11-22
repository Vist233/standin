# @standin/workspace-client

The runtime's typed client of the desk-daemon. It is a `WorkspaceHost` (the interface in `@standin/contracts`, file `workspace-host.ts`, written for T3): `ensure`, `destroy`, `health`, `takeover.open`, `takeover.close`.

- **Interface:** `createWorkspaceClient({ socketPath, requestTimeoutMs?, retries?, backoffMs?, sleep? })` returns the host plus `close()`. `@standin/workspace-client/testing` has `createFakeWorkspaceHost` (obeys the contract rules, real directories), `serveWorkspaceHost(host, socketPath)` (any host on a Unix socket in the wire format, with hooks to drop connections, stay silent or send nonsense), `createSocketRig()` (fake + server + client) and `workspaceHostContract(name, create)`, the rules of a host as a test suite.
- **Hides:** the socket protocol (JSON lines, version 1, request ids, overlapping requests), reconnecting, timeouts.
- **Never knows:** sessions, agents, models, processes of the daemon.
- **Faults:** a broken connection, a refused connection or a silent daemon is repeated with doubling pauses (default 5 repeats from 200 ms), because every call is idempotent; an answer from the daemon, success or error, is final and never repeated. Garbage from the daemon drops that connection. After the repeats are used up: `unavailable`, saying how many tries were made. An error kind from a newer daemon becomes `internal`.
- **Contract suite:** runs against the fake host directly and against the client talking to the fake host over a real socket. The desk-daemon's own tests can run the same suite against the real host when it exists (its package may not import this one, so copy or move the suite then).
