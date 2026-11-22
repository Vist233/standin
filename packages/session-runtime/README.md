# @standin/session-runtime

One framework `Agent` per session, driven through the router and recorded in the journal.

- **Interface:** `createSessionRuntime(deps)` returns `createSession(request)`, `openSession(id)`, `resumeAll()`, `send(sessionId, text, id?)`, `signal(sessionId, draft)`, `stop(sessionId)`, `status`, `events(sessionId, after)` / `read` (journal), `whenIdle`, `list`, `closeSession`, `deleteSession`, `close`. Dependencies are injected (`SessionRuntimeDeps`): store, model registry, profile config, plugin host, a `WorkspaceProvider` (`ensure` / `destroy`), secrets, optional journal factory, safety-plugin factory, `createAgent`, router options, logger. `@standin/session-runtime/testing` has `createRig` (real files, the framework's scripted model, fake workspaces), `createFakeWorkspaces`, `lastUserText`.
- **Order of work for every input (per session, one at a time):** write the router input to the journal, let the router decide, carry out the deliveries (`start-run` -> `agent.run(text)`, `steer` -> `agent.steer(text)`, `stop` -> `agent.cancel()`). A failed journal write refuses the input and leaves no trace.
- **Acknowledgement of a steer** is the framework's `message_end` event of a user message with the steered text (found by the lead in `kernel/src/loop.ts`); a steer the run ends without reading goes back to the router.
- **Opening a session** rebuilds the router by replaying the journalled inputs, then settles what a crash left in flight: a delivery whose text is already in the conversation counts as read; a run that was going is continued by the framework; unread steers go back to the queue.
- **Safety floor:** the session's profile says which of review and redaction are on; `defaultSafetyPlugins` builds the framework's plugins (redaction wraps the reviewer's model too). They are put before the framework's core plugins. Sub-agents share them (framework default).
- **Rules enforced here:** only `send` can use the source `user`; `signal` refuses `user` and `system`; a plugin's signal sink only accepts its own `plugin:<name>` source; a plugin gets only its `PluginContext`; one session failing to open never stops `resumeAll` for the others.
- **Hides:** the framework wiring, journal event mapping (`run.started`, `message.user`, `tool.call`, ...), crash recovery. **Never knows:** HTTP, the page, the desk-daemon (only the `WorkspaceProvider` interface).
- **Tools:** the original four, our `tool_search` and `tool_call`, the tools the profile asks to declare, and the framework's sub-agent tools. Everything else (core tools `send_to_user`, `ask_human`, `workspace_info`, and every plugin tool) is found with search. `tool_call` reviews the inner call under its own name through the review plugin's `authorize`, and each tool is wrapped by the approval mode of its manifest (`auto`, `ask` through `pendingApprovals` / `decideApproval`, `never`). Plugins' prompt sections go into `AGENTS.md`. `PluginContext.helpers.run` starts a nested framework agent (the session's model and safety plugins, its own memory log, a turn limit) and returns only its final text.
- **Not here yet:** skills and MCP servers of plugins, streaming deltas in the journal, the real workspace provider (workspace-client).

## Take-over and the person

State is journalled (`takeover.opened`, `takeover.viewer_connected`, `takeover.closed`), never kept in the gateway. Signatures on `SessionRuntime` (frozen in WP0; implemented in WP3):

```ts
openTakeover(sessionId: string): Promise<{ since: number; workspaceId: string }>; // holds the session, journals takeover.opened
reportTakeoverViewer(sessionId: string): Promise<void>;                          // journals takeover.viewer_connected
closeTakeover(sessionId: string, note?: string): Promise<void>;                  // journals takeover.closed {note?, viewed}, sends the true hand-back text
takeoverState(sessionId: string): Promise<{ since: number; viewed: boolean } | null>; // derived from the journal (works now)
deleteSession(sessionId: string): Promise<void>;                                 // already on the interface
```

The hand-back texts are the exported constants `HANDBACK_VIEWED` and `HANDBACK_NOT_VIEWED`; `waitingFrom(events)` (waiting.ts) is the one pure fold of what waits for the person: open questions, pending approvals, the take-over, texts queued during it and the last run's end; `status()` returns `pending` and `lastRunEnd` from it.

**WP3 behaviour.** `openTakeover` holds the session (like Stop) after a running tool call has finished, at most 5 s; `closeTakeover` journals `takeover.closed {note?, viewed}`, answers open questions `by: "takeover"` only if a viewer connected, and sends the true hand-back text as the person's message (which also ends the hold). A session opened after a restart writes `takeover.closed`, `approval.expired` (reason `restart`) and `tool.result` with outcome `interrupted` for whatever the restart left open (`repairAfterRestart`, pure). Deciding an approval that does not exist is a `conflict`.

**Waiting for the person.** `ask_human` with kind `login` or `code` returns `details.pause = "input"`; `waitingForPersonPlugin` turns that into the framework's `turn.end` pause, the run ends, and the actor holds the session until the person's next message (which writes `human.answered`). `where` is a model-supplied argument.

**Journal words.** `tool.call` carries `tool {name, action?, target?}` with `tool_call` unwrapped; the review of an inner call (`<id>/inner`) carries `parentCallId`; `tool.result.outcome` is `ok|error|refused|needs_approval|interrupted`; `run.finished` is written from the run's result with `reason` `end|pause|cancelled|error` (the fixtures' words) and `pause {reason, detail?}`; a failed or quota-paused run also writes `session.error {kind, message, retryable}` with the cause cut to one line and credentials removed.

**Limits.** The runtime replaces the framework's limits plugin with its own (`maxRunSeconds` 900) and, before every run, sets `maxTurns` to the replies used so far plus 40 (`SessionRuntimeDeps.limits` overrides both). The fingerprint stuck detector is deferred.

**Layout.** `runtime.ts` is the public interface and the lifecycle; `session-assembly.ts` builds one session (workspace, plugins, AGENTS.md, tools, agent, wait limits, actor); `actor.ts` serialises everything that happens to it; `waiting.ts`, `repair.ts` and `waits.ts` are pure functions of the journal; `takeover.ts` holds the hand-back texts and how a take-over ends.
