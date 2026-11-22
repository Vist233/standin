"""Layer 2: the accessibility tree. Widgets as programs publish them: read their names, roles, states and text, and run their own
actions. Nothing here moves the pointer or presses keys; a widget that cannot do what is asked says so, and the caller decides to use the
pointer layer (screen.py). Needs pyatspi and an AT-SPI bus (runner/start-desktop.sh); a program without a tree is simply absent from apps().
A widget that is not on screen accepts an action and does nothing, so actions refuse such a widget.
"""
import time

try:
    import pyatspi
except Exception:  # pragma: no cover  (no accessibility stack on this machine)
    pyatspi = None

MAX_NODES = 4000
_refs = {}


class Element:
    """One widget. Read: name, role, states, bounds, text, actions, children. Act: click(), set_text(text), focus(), action(name)."""

    def __init__(self, node):
        self.node = node

    def __repr__(self):
        b = self.bounds
        where = f" at {b['x']},{b['y']} {b['w']}x{b['h']}" if b else " (not on screen)"
        return f"<{self.role} {self.name!r}{where}>"

    @property
    def name(self):
        try:
            return self.node.name or ""
        except Exception:
            return ""

    @property
    def role(self):
        try:
            return self.node.getRoleName()
        except Exception:
            return "?"

    @property
    def states(self):
        try:
            return sorted(pyatspi.stateToString(s) for s in self.node.getState().getStates())
        except Exception:
            return []

    @property
    def bounds(self):
        try:
            e = self.node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        except Exception:
            return None
        if e.x <= -100000 or e.y <= -100000 or e.width < 1 or e.height < 1:
            return None
        return {"x": e.x, "y": e.y, "w": e.width, "h": e.height}

    @property
    def center(self):
        b = self.bounds
        return None if b is None else (b["x"] + b["w"] // 2, b["y"] + b["h"] // 2)

    @property
    def text(self):
        try:
            t = self.node.queryText()
            return t.getText(0, t.characterCount)
        except Exception:
            return self.name

    @property
    def actions(self):
        try:
            a = self.node.queryAction()
            return [a.getName(i) for i in range(a.nActions)]
        except Exception:
            return []

    @property
    def children(self):
        try:
            return [Element(c) for c in self.node]
        except Exception:
            return []

    def action(self, name=None):
        """Runs the widget's own action (its first one, or the one named), without the pointer."""
        if self.bounds is None:
            raise RuntimeError(f"{self!r} is not on screen: an action on it would do nothing. Open its window or menu first.")
        a = self.node.queryAction()
        names = [a.getName(i) for i in range(a.nActions)]
        if not names:
            raise RuntimeError(f"{self!r} has no action; use click() to press it with the pointer.")
        index = names.index(name) if name in names else 0
        if not a.doAction(index):
            raise RuntimeError(f"{self!r} refused the action {names[index]!r}.")
        return names[index]

    def click(self):
        """Runs the widget's own first action (press, click, activate). It never moves the pointer: for a widget without an action,
        use the pointer layer yourself, click(*el.center)."""
        self.action()
        return self

    def set_text(self, value):
        """Replaces the text of an editable widget through the tree. A widget that is not editable this way says so; then
        focus it and type: el.focus(); key('ctrl+a'); type_text(value)."""
        try:
            editable = self.node.queryEditableText()
        except Exception:
            raise RuntimeError(f"{self!r} has no editable text in the tree; focus it and use type_text().") from None
        if not editable.setTextContents(value):
            raise RuntimeError(f"{self!r} refused the new text.")
        return self

    def focus(self):
        """Gives the widget the keyboard focus through the tree."""
        try:
            if self.node.queryComponent().grabFocus():
                return self
        except Exception:
            pass
        raise RuntimeError(f"{self!r} cannot take the focus through the tree; click it with the pointer: click(*el.center).")


def _need_tree():
    if pyatspi is None:
        raise RuntimeError("No accessibility stack here (pyatspi is missing): use screenshot() and the pointer.")


def apps():
    """The programs that have an accessibility tree, by name. A running program missing here has none: use the picture."""
    _need_tree()
    desktop = pyatspi.Registry.getDesktop(0)
    return [desktop.getChildAtIndex(i).name for i in range(desktop.childCount)]


def _walk(root, limit):
    out, stack = [], [(root, 0)]
    seen = 0
    while stack and seen < MAX_NODES:
        node, depth = stack.pop()
        seen += 1
        out.append((node, depth))
        try:
            kids = list(node)
        except Exception:
            kids = []
        for kid in reversed(kids):
            stack.append((kid, depth + 1))
    return out, bool(stack)


def _roots(app):
    _need_tree()
    desktop = pyatspi.Registry.getDesktop(0)
    roots = [desktop.getChildAtIndex(i) for i in range(desktop.childCount)]
    if app:
        roots = [r for r in roots if app.lower() in (r.name or "").lower()]
        if not roots:
            raise RuntimeError(f"No program named like {app!r} has an accessibility tree. Programs with one: {apps()}")
    return roots


def tree(app=None, limit=150, all=False):
    """The widgets on screen as text, one per line: ref, role, name, and what it can do. Pass app to look at one program.
    all=True also lists widgets with neither an action nor a name (panels, fillers). Refs (a1, ...) are valid until the next tree()."""
    _refs.clear()
    lines, shown, total, cut = [], 0, 0, False
    for root in _roots(app):
        nodes, more = _walk(root, limit)
        cut = cut or more
        for node, depth in nodes:
            el = Element(node)
            b = el.bounds
            if depth > 0 and b is None:
                continue
            acts = el.actions
            role = el.role
            # one rule for every program: a widget is listed when you can act on it or it says something (all=True lists every one)
            if not (depth == 0 or acts or el.name or all):
                continue
            total += 1
            if shown >= limit:
                continue
            shown += 1
            ref = f"a{shown}"
            _refs[ref] = node
            extra = f" [{', '.join(acts)}]" if acts else ""
            checked = " (checked)" if "checked" in el.states else ""
            lines.append(f"{'  ' * min(depth, 6)}{ref} {role} {el.name!r}{checked}{extra}")
    if total > shown or cut:
        lines.append(f"… {total - shown} more not shown: pass app=..., or use find(name=..., role=...)")
    return "\n".join(lines)


def ref(name):
    """The Element of a ref from the last tree()."""
    node = _refs.get(name)
    if node is None:
        raise KeyError(f"No ref {name!r} in the last tree(); call tree() again.")
    return Element(node)


def find(name=None, role=None, app=None, exact=False, on_screen=True):
    """Widgets whose name contains `name` (any case; exact=True for the whole name) and whose role is `role`."""
    found = []
    for root in _roots(app):
        for node, _depth in _walk(root, MAX_NODES)[0]:
            el = Element(node)
            if role and el.role != role:
                continue
            if name is not None:
                n = el.name
                if (n != name) if exact else (name.lower() not in n.lower()):
                    continue
            if on_screen and el.bounds is None:
                continue
            found.append(el)
    return found


def wait_for(condition, timeout=10, every=0.25):
    """Calls condition() until it returns something true, and returns that; raises after timeout seconds."""
    end = time.time() + timeout
    last_error = None
    while time.time() < end:
        try:
            value = condition()
            if value:
                return value
        except Exception as error:  # the widget may not exist yet
            last_error = error
        time.sleep(every)
    raise TimeoutError(f"not true within {timeout} s" + (f" (last error: {last_error})" if last_error else ""))


