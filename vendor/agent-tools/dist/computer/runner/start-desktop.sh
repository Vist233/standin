#!/bin/sh
# Starts an X desktop with an accessibility bus, for tests and for hosts that have none, and prints the environment the runner (and the
# programs it starts) need, as KEY=value lines. Usage: start-desktop.sh :7 [1280x800]
# What it does, and why: Xvfb (the screen), openbox (windows can be focused and moved), a D-Bus session and the AT-SPI bus launcher
# (where programs publish their widgets). GTK programs join the bus with GTK_MODULES=gail:atk-bridge and NO_AT_BRIDGE=0 set in their environment.
set -eu
display="${1:-:7}"
size="${2:-1280x800}"
runtime="/tmp/computer-use-xdg-${display#:}"
mkdir -p "$runtime" && chmod 700 "$runtime"
Xvfb "$display" -screen 0 "${size}x24" -nolisten tcp >/dev/null 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10; do DISPLAY="$display" xdotool getdisplaygeometry >/dev/null 2>&1 && break; sleep 0.3; done
DISPLAY="$display" openbox >/dev/null 2>&1 &
bus=$(DISPLAY="$display" XDG_RUNTIME_DIR="$runtime" dbus-launch --sh-syntax | sed -n "s/^DBUS_SESSION_BUS_ADDRESS='\(.*\)';$/\1/p")
launcher=$(ls /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher 2>/dev/null | head -1)
DISPLAY="$display" XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="$bus" "$launcher" --launch-immediately >/dev/null 2>&1 &
sleep 1
echo "DISPLAY=$display"
echo "XDG_RUNTIME_DIR=$runtime"
echo "DBUS_SESSION_BUS_ADDRESS=$bus"
echo "GTK_MODULES=gail:atk-bridge"
echo "NO_AT_BRIDGE=0"
