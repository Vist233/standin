# browser (plugin)

The `browser` tool of agent-tools (`vendor/agent-tools`, its own repository; `scripts/sync-agent-tools.sh` copies it) on the workspace's
browser. The agent writes Playwright code in a session that stays; each agent has its own tab. Its runner runs as a program of the workspace
(`WorkspaceHandle.spawn`: the workspace's environment, no keys) and attaches over DevTools. Design: `vendor/agent-tools/README.md`.
