import { type CodeToolOptions } from "../core/code-tool.ts";
export declare const COMPUTER_DESCRIPTION = "Runs Python on your desktop. The value of the last line is returned, with what was printed. The session stays between calls: names you define are still there next time. The helpers below are already imported.\n\nWork in code, not one step per call: one call can open a program, wait for its window, fill a dialog and check the result.\n\nThree layers, best first; none falls back to another by itself:\n1. No screen: files and programs' own command lines (open(), subprocess). A document you can write as a file needs no clicks.\n2. The accessibility tree, for programs that publish one: apps(); tree(app='name') lists widgets with refs; ref('a3'); find(name='Save', role='push button'); el.click() runs the widget's own action; el.set_text('...'); el.text; el.states; el.center; wait_for(lambda: find(name='Open')).\n3. The picture and the input, for every program: screenshot() (shown to you), click(x, y), click(x, y, double=True), drag(x1, y1, x2, y2), path([(x, y), ...]), type_text('...'), key('ctrl+s'), scroll(dy=3).\nPrograms: launch('name'), windows(), activate('title').\n\nAfter an action that matters (save, send, delete), check its effect in the same code and return that.";
export declare const DESKTOP_RUNNER: string;
export interface ComputerToolOptions extends Pick<CodeToolOptions, "spawn" | "timeoutSeconds" | "maxTimeoutSeconds"> {
    /**
     * The runner's environment for this desktop: DISPLAY, and for the accessibility tree XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS, GTK_MODULES and
     * NO_AT_BRIDGE (runner/start-desktop.sh prints them); COMPUTER_USE_SHOTS for pictures.
     */
    env: () => Promise<Record<string, string>> | Record<string, string>;
    /** How to start the runner (default: python3 with runner/runner.py). */
    runner?: {
        program: string;
        args: string[];
    } | undefined;
}
/** The `computer` tool: Python against one desktop; each agent has its own names, and calls run one at a time (one pointer). */
export declare function createComputerTool(options: ComputerToolOptions): import("sakura-agent").Tool & {
    close(): Promise<void>;
};
