"""Layer 3: the picture, the pointer and the keys (xdotool and ImageMagick on the X display in DISPLAY). Works for every program,
with or without an accessibility tree; it knows nothing about widgets.
"""
import os
import subprocess
import time

SHOTS = os.environ.get("COMPUTER_USE_SHOTS") or os.path.join(os.getcwd(), ".computer-use", "shots")
_images = []  # screenshots taken during the current piece of code; the runner sends them with the reply
_shot_count = 0


def _xdotool(*args):
    result = subprocess.run(["xdotool", *[str(a) for a in args]], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"xdotool {args[0]} failed: {result.stderr.strip()[:300]}")
    return result.stdout


def screenshot(region=None):
    """Takes a picture of the whole screen (or region=(x, y, w, h)); it is shown to you with the reply. Returns its path."""
    global _shot_count
    os.makedirs(SHOTS, exist_ok=True)
    _shot_count += 1
    path = os.path.join(SHOTS, f"screen-{os.getpid()}-{int(time.time() * 1000)}-{_shot_count}.png")
    command = ["import", "-window", "root"]
    if region:
        x, y, w, h = region
        command += ["-crop", f"{w}x{h}+{x}+{y}", "+repage"]
    result = subprocess.run([*command, path], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"the screenshot failed: {result.stderr.strip()[:300]}")
    _images.append(path)
    return path


def screen_size():
    w, h = _xdotool("getdisplaygeometry").split()
    return int(w), int(h)


def move(x, y):
    _xdotool("mousemove", round(x), round(y))


def click(x, y, button=1, double=False):
    """Clicks the point (x, y) of the screen."""
    _xdotool("mousemove", round(x), round(y), "click", *(["--repeat", 2] if double else []), button)


def drag(x1, y1, x2, y2, steps=20):
    """Holds the left button from (x1, y1) to (x2, y2)."""
    path([(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps) for i in range(steps + 1)])


def path(points):
    """Holds the left button along a list of (x, y) points: a stroke for drawing by hand."""
    points = [(round(x), round(y)) for x, y in points]
    if len(points) < 2:
        raise ValueError("path needs at least two points")
    args = ["mousemove", *points[0], "mousedown", 1]
    for x, y in points[1:]:
        args += ["mousemove", x, y, "sleep", 0.01]
    _xdotool(*args, "mouseup", 1)


def type_text(text, delay_ms=12):
    """Types text into the focused widget, as keys."""
    _xdotool("type", "--clearmodifiers", "--delay", delay_ms, "--", text)


def key(*combos):
    """Presses keys, such as key('ctrl+s') or key('Tab', 'Tab', 'Return')."""
    _xdotool("key", "--clearmodifiers", "--", *combos)


def scroll(dy=0, dx=0, x=None, y=None):
    """Scrolls by wheel steps (positive dy: down), at (x, y) if given."""
    if x is not None and y is not None:
        move(x, y)
    for _ in range(min(50, abs(int(dy)))):
        _xdotool("click", 5 if dy > 0 else 4)
    for _ in range(min(50, abs(int(dx)))):
        _xdotool("click", 7 if dx > 0 else 6)


