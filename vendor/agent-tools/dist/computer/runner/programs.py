"""Programs and windows: start a program, list and raise windows (by title, through the window manager)."""
import os
import shutil
import subprocess

from screen import _xdotool


def launch(program, *args):
    """Starts a desktop program that keeps running after this call; wait for its window with wait_for(lambda: windows('name'))."""
    if shutil.which(program) is None and not os.path.exists(program):
        raise FileNotFoundError(f"No program {program!r} here.")
    subprocess.Popen([program, *map(str, args)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return program


def windows(name=None):
    """The visible windows (id and title), those whose title contains name if given."""
    result = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", name or "."], capture_output=True, text=True, timeout=15)
    found = []
    for wid in result.stdout.split():
        title = subprocess.run(["xdotool", "getwindowname", wid], capture_output=True, text=True, timeout=15).stdout.strip()
        if title:
            found.append({"id": int(wid), "title": title})
    return found


def activate(name):
    """Brings the first window whose title contains name to the front and focuses it."""
    found = windows(name)
    if not found:
        raise RuntimeError(f"No visible window with {name!r} in its title. Windows: {[w['title'] for w in windows()]}")
    _xdotool("windowactivate", "--sync", found[0]["id"])
    return found[0]


