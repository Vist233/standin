"""The names the agent's Python code sees for the desktop, in three layers, best first:
  1. code without the screen: files, programs' own command lines (ordinary Python; subprocess is there);
  2. a11y.py, the accessibility tree: apps(), tree(), ref(), find(), Element (.click(), .set_text(), .text, .states, .center), wait_for();
  3. screen.py, the picture and the input: screenshot(), click(x, y), drag, path, type_text, key, scroll, screen_size().
programs.py starts programs and finds windows. A layer never falls back to another by itself: the code chooses.
"""
import time

from a11y import Element, apps, find, ref, tree, wait_for
from programs import activate, launch, windows
from screen import click, drag, key, move, path, screen_size, screenshot, scroll, type_text

sleep = time.sleep

__all__ = [
    "Element", "apps", "tree", "ref", "find", "wait_for",
    "screenshot", "screen_size", "move", "click", "drag", "path", "type_text", "key", "scroll",
    "launch", "windows", "activate", "sleep",
]
