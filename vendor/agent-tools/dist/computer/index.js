import { fileURLToPath } from "node:url";
import { createCodeTool } from "../core/code-tool.js";
export const COMPUTER_DESCRIPTION = `Runs Python on your desktop. The value of the last line is returned, with what was printed. The session stays between calls: names you define are still there next time. The helpers below are already imported.

Work in code, not one step per call: one call can open a program, wait for its window, fill a dialog and check the result.

Three layers, best first; none falls back to another by itself:
1. No screen: files and programs' own command lines (open(), subprocess). A document you can write as a file needs no clicks.
2. The accessibility tree, for programs that publish one: apps(); tree(app='name') lists widgets with refs; ref('a3'); find(name='Save', role='push button'); el.click() runs the widget's own action; el.set_text('...'); el.text; el.states; el.center; wait_for(lambda: find(name='Open')).
3. The picture and the input, for every program: screenshot() (shown to you), click(x, y), click(x, y, double=True), drag(x1, y1, x2, y2), path([(x, y), ...]), type_text('...'), key('ctrl+s'), scroll(dy=3).
Programs: launch('name'), windows(), activate('title').

After an action that matters (save, send, delete), check its effect in the same code and return that.`;
export const DESKTOP_RUNNER = fileURLToPath(new URL("./runner/runner.py", import.meta.url));
/** The `computer` tool: Python against one desktop; each agent has its own names, and calls run one at a time (one pointer). */
export function createComputerTool(options) {
    return createCodeTool({
        name: "computer",
        description: COMPUTER_DESCRIPTION,
        language: "Python",
        effect: "exec",
        runner: options.runner ?? { program: "python3", args: ["-u", DESKTOP_RUNNER] },
        spawn: options.spawn,
        env: options.env,
        oneAtATime: true,
        timeoutSeconds: options.timeoutSeconds,
        maxTimeoutSeconds: options.maxTimeoutSeconds,
        survives: "The desktop and its programs are as the stopped code left them (screenshot() or tree() to look).",
    });
}
