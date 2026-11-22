# computer (plugin)

The `computer` tool of agent-tools (`vendor/agent-tools`) on the workspace's desktop. The agent writes Python against three layers (no
screen, the accessibility tree, the picture and the input); calls run one at a time. The runner runs as a program of the workspace, whose
environment names the display and its accessibility bus (the desk-daemon starts one D-Bus session per display). Design:
`vendor/agent-tools/README.md`.
