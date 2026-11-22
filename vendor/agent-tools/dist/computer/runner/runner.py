"""The child process that runs the agent's Python code on a desktop.

One JSON request per line on stdin ({"id", "code"}), one JSON reply per line on stdout ({"id", "ok", "value", "logs", "images", "error"}).
The namespace stays between requests: what the code defines is there next time. If the last statement is an expression, its value is the
reply's value (as in a notebook). It ends when stdin ends. The desktop (DISPLAY, the accessibility bus) comes from its environment.
"""
import ast
import contextlib
import io
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screen  # noqa: E402

MAX_VALUE = 12_000
MAX_OUTPUT = 20_000

namespace = {"__name__": "__agent__"}
exec("from desk import *", namespace)


def cut(text, limit, hint):
    return text if len(text) <= limit else f"{text[:limit]}… [{len(text) - limit} more characters: {hint}]"


def run(request):
    reply = {"id": request.get("id"), "ok": True, "logs": [], "images": []}
    output = io.StringIO()
    screen._images.clear()
    try:
        tree = ast.parse(request.get("code", ""), "<agent>", "exec")
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(compile(tree, "<agent>", "exec"), namespace)
            value = eval(compile(ast.Expression(last.value), "<agent>", "eval"), namespace) if last is not None else None
        if value is not None:
            text = value if isinstance(value, str) else json.dumps(value, default=repr, ensure_ascii=False)
            reply["value"] = cut(text, MAX_VALUE, "return less")
    except BaseException as error:  # noqa: BLE001  (SystemExit and KeyboardInterrupt are the code's errors too)
        reply["ok"] = False
        frames = [f for f in traceback.extract_tb(error.__traceback__) if f.filename == "<agent>"]
        where = f" (line {frames[-1].lineno})" if frames else ""
        reply["error"] = f"{type(error).__name__}: {error}{where}"
    text = output.getvalue()
    if text:
        reply["logs"] = cut(text, MAX_OUTPUT, "print less").rstrip("\n").split("\n")
    reply["images"] = list(screen._images)
    return reply


def main():
    out = sys.stdout
    sys.stdout = sys.stderr  # nothing but replies goes to the real stdout
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        out.write(json.dumps(run(request), ensure_ascii=False) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
