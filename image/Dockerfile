# Version 1 box: Ubuntu 24.04, Node 26, s6-overlay with two services (runtime, desk-daemon), Playwright's Chromium,
# Xvfb, openbox, x11vnc, the owner's browser tool with its pinned agent-browser. Architecture neutral: the same file builds linux/amd64 and linux/arm64
# (the target is x86_64; the developer's Mac builds arm64 natively). Build with the repository root as context:
#   docker build -f image/Dockerfile -t ogb-box:dev .
FROM ubuntu:24.04

ARG NODE_VERSION=26.13.0
ARG S6_OVERLAY_VERSION=3.2.3.2
ARG PLAYWRIGHT_VERSION=1.65.0
# Runs the whole `npm run check` inside the image (decision D-N-1); set to 0 only to rebuild faster while debugging the image.
ARG RUN_CHECK=1
# Optional mirrors for slow networks (default: the official sources). APT_MIRROR_BASE is a host such as http://mirrors.example.org (http: the base image has no CA certificates yet; apt checks signatures itself) that serves
# /ubuntu and /ubuntu-ports. NPM_REGISTRY replaces the public npm registry. PLAYWRIGHT_DOWNLOAD_HOST replaces Playwright's CDN.
ARG APT_MIRROR_BASE=
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG PLAYWRIGHT_DOWNLOAD_HOST=
# Where the Node tarball comes from. Its checksum is always taken from the official nodejs.org list, so a mirror cannot change what is accepted.
ARG NODE_DIST_BASE=https://nodejs.org/dist

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# --- system packages -------------------------------------------------------------------------------------------
# procps: `ps` (the daemon checks the command line of recorded processes). dbus: machine id and the library Chromium
# looks for; no bus daemon is started (the desktop tools' README warns against injecting a session bus address).
# fonts: Latin, CJK, emoji, so pages render in the screenshots. No websockify and no noVNC: the bridge is the daemon's own
# (D-T3-6) and the page vendors its own noVNC (docs/11 D1).
RUN if [ -n "${APT_MIRROR_BASE}" ]; then \
      sed -i -e "s#http://archive.ubuntu.com/ubuntu#${APT_MIRROR_BASE}/ubuntu#g" -e "s#http://ports.ubuntu.com/ubuntu-ports#${APT_MIRROR_BASE}/ubuntu-ports#g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils libatomic1 procps psmisc iproute2 git \
      xvfb openbox x11vnc xdotool imagemagick ffmpeg \
      dbus dbus-x11 at-spi2-core python3 python3-pyatspi python3-pil python3-websocket \
      fonts-liberation fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && dbus-uuidgen > /etc/machine-id

# --- Node (official tarball, checked against the published SHASUMS256.txt) ----------------------------------------
RUN set -eux; \
    case "$(dpkg --print-architecture)" in amd64) arch=x64;; arm64) arch=arm64;; *) echo "unsupported architecture" >&2; exit 1;; esac; \
    base="${NODE_DIST_BASE}/v${NODE_VERSION}"; \
    curl --retry 8 --retry-delay 3 --retry-all-errors -fsSLO "${base}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl --retry 8 --retry-delay 3 --retry-all-errors -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " node-v${NODE_VERSION}-linux-${arch}.tar.xz\$" | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-${arch}.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    node --version | grep -q "^v${NODE_VERSION}\$"

# --- s6-overlay (init and supervisor; checked against the release's .sha256 files) --------------------------------
RUN set -eux; \
    case "$(dpkg --print-architecture)" in amd64) arch=x86_64;; arm64) arch=aarch64;; esac; \
    base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
    for name in "s6-overlay-noarch.tar.xz" "s6-overlay-${arch}.tar.xz"; do \
      curl --retry 8 --retry-delay 3 --retry-all-errors -fsSLO "${base}/${name}"; curl --retry 8 --retry-delay 3 --retry-all-errors -fsSL "${base}/${name}.sha256" | sed "s#  .*#  ${name}#" | sha256sum -c -; \
      tar -C / -Jxpf "${name}"; rm "${name}"; \
    done

# --- Chromium (Playwright's build) --------------------------------------------------------------
# `playwright install --with-deps` pulls the libraries Chromium needs on Ubuntu 24.04. The daemon launches the binary
# itself (no Playwright library at run time); the owner's browser tool (below) attaches to it over the DevTools port. There is exactly one agent-browser in the image: the version that tool pins (D-APP-8).
RUN set -eux; \
    export NPM_CONFIG_REGISTRY="${NPM_REGISTRY}"; \
    if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then export PLAYWRIGHT_DOWNLOAD_HOST; fi; \
    npm install -g "playwright@${PLAYWRIGHT_VERSION}"; \
    apt-get update; \
    playwright install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/*; \
    chrome="$(find "${PLAYWRIGHT_BROWSERS_PATH}" -path '*/chromium-*/chrome-linux*/chrome' -type f | head -n 1)"; \
    test -n "${chrome}"; \
    ln -s "${chrome}" /usr/local/bin/ogb-chromium

# --- everyday programs of the agents (owner's request of 2026-11-15) ---------------------------------------------
# What a person's computer usually has, so a bot can draw by hand (mtpaint, GIMP), edit video and pictures (ffmpeg and
# ImageMagick above), work with office files (LibreOffice Writer and Calc, pandoc), download media (yt-dlp), handle data and
# archives (jq, sqlite3, zip, 7z) and script in Python (numpy, matplotlib, requests). A separate layer: the base layer above
# stays cached when this list changes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      mtpaint gimp libreoffice-writer libreoffice-calc pandoc yt-dlp \
      jq sqlite3 zip unzip p7zip-full wget xclip xsel \
      python3-pip python3-venv python3-numpy python3-matplotlib python3-requests \
    && rm -rf /var/lib/apt/lists/*

# --- the owner's browser tool (`sakura-browser-worker`) ---------------------------------------------------------------
# A local package of the owner, vendored unchanged (image/vendor/ORIGIN.md). The hash is checked before anything is installed; its
# npm-shrinkwrap pins its dependencies, which come from NPM_REGISTRY.
COPY image/vendor/browser-tool /tmp/vendor/browser-tool
COPY image/vendor/SHA256SUMS /tmp/vendor/SHA256SUMS
RUN set -eux; \
    cd /tmp/vendor; \
    grep ' ./browser-tool/sakura-browser-tool-0.2.0.tgz$' SHA256SUMS | sha256sum -c -; \
    npm install -g --registry="${NPM_REGISTRY}" ./browser-tool/sakura-browser-tool-0.2.0.tgz; \
    command -v sakura-browser-worker; \
    rm -rf /tmp/vendor

# --- the application ----------------------------------------------------------------------------------------------
WORKDIR /opt/ogb
COPY package.json package-lock.json tsconfig.json tsconfig.base.json biome.json vitest.config.ts ./
COPY scripts ./scripts
COPY packages ./packages
COPY plugins ./plugins
COPY test ./test
COPY relay ./relay
COPY image ./image
COPY vendor/agent-tools ./vendor/agent-tools
RUN npm ci --registry="${NPM_REGISTRY}"
# The first-party plugins are bundled to dist/ (the plugin host loads them from a cache that has no node_modules); the check builds them too, this makes it independent of RUN_CHECK.
RUN node scripts/build-plugins.mjs
# The check runs as an ordinary user: tests of unwritable and read-only paths mean nothing for root, which ignores permission bits.
# The product itself runs as root in the container (see image/README.md).
RUN if [ "${RUN_CHECK}" = "1" ]; then \
      useradd --create-home --uid 1001 checker && chown -R checker /opt/ogb \
      && runuser -u checker -- env HOME=/home/checker npm run check; \
    fi

# --- services -----------------------------------------------------------------------------------------------------
COPY image/rootfs/ /
ENV OGB_DESK_DATA_DIR=/data/desk \
    OGB_DESK_SOCKET=/run/ogb/desk-daemon.sock \
    OGB_X11_DIR=/tmp/.X11-unix \
    OGB_CHROMIUM_PATH=/usr/local/bin/ogb-chromium \
    OGB_APP_ROOT=/opt/ogb \
    OGB_HOST=0.0.0.0 \
    OGB_PORT=8787 \
    OGB_LISTEN_OPEN=1 \
    OGB_DATA_DIR=/data \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_KILL_GRACE_TIME=20000
# OGB_LISTEN_OPEN: the page listens on all interfaces of the container with no login because compose publishes the port on the host's
# 127.0.0.1 only (owner decision 11). Run the image with another port mapping and this is no longer true.
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=6s --start-period=20s --retries=3 CMD ["node", "/opt/ogb/image/healthcheck.mjs"]
ENTRYPOINT ["/init"]
