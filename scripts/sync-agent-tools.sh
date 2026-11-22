#!/bin/sh
# Copies the browser and computer tools (../agent-tools, their own repository) into vendor/agent-tools: the code the image runs.
# What is copied is what npm would install: the compiled dist/ (no sources, tests or benchmark). Run it after changing agent-tools, then npm install and the tests.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
source="${1:-$here/../agent-tools}"
target="$here/vendor/agent-tools"
rm -rf "$target" && mkdir -p "$target"
( cd "$source" && npm run build >/dev/null )
( cd "$source" && tar --exclude='__pycache__' -cf - package.json README.md LICENSE dist ) | ( cd "$target" && tar -xf - )
echo "agent-tools $(cd "$source" && git rev-parse --short HEAD 2>/dev/null || echo '(no git)') copied to vendor/agent-tools"
