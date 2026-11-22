# agent-tools: the browser and the computer, from first principles

How this fits the whole system (Sakura, Vesper, Infinity) and the full mapping of "the bitter lesson": `../agent-framework/docs/52-architecture-philosophy-and-the-bitter-lesson.md`.

## 1. What is true about the problem
1. **An agent's strongest skill is writing code.** Its weakest is acting one small step per model call: every step costs a round trip and
   re-sends the state, and a mistake is seen only one step later.
2. **A browser page and a desktop are already programs with interfaces.** A page is a DOM that code can read and change; a desktop program
   publishes its widgets (the accessibility tree); every screen is pixels plus a pointer and keys. Nothing has to be invented, only exposed.
3. **Not everything has a usable interface.** Canvases have no elements, some programs publish no tree (LibreOffice's plain X11 build, Qt
   without its bridge). The picture and the pointer are the one interface that always exists, and the most expensive one.
4. **The best action uses no screen at all.** A file written directly, a program's own command line, an API: these beat any clicking.
5. **Models change; interfaces stay.** A tool that patches what one model does badly, or what one site or task needs, is wrong the
   next month. A tool that exposes what is true keeps working as models improve.

## 2. What follows from it
- **One tool per surface, whose only input is code.** `browser` takes JavaScript (Playwright), `computer` takes Python. One call can do
  a whole form, loop over 200 rows, wait for a condition and read back what it changed.
- **The session stays.** The runner keeps the agent's names (`page`, variables) between calls, as a notebook does.
- **Layers, best first, chosen by the agent's code; no layer falls back to another by itself.**

| Layer | browser | computer |
|---|---|---|
| no screen | `page.evaluate`, `fetch` in the page | files, `subprocess` |
| semantic | Playwright locators (`getByRole`, `getByLabel`), `snapshot()` | the accessibility tree: `tree()`, `find()`, `Element.click()` (the widget's own action), `set_text()` |
| pixels | `screenshot()`, `page.mouse` | `screenshot()`, `click(x, y)`, `drag`, `path`, `type_text`, `key` |
| raw | `cdp(method, params)` | (the X tools themselves, through `subprocess`) |

  This is the order Codex uses too (integrations, then the browser, then the screen); it is also why the article "the bitter lesson of browser
  use" ends at code: the general method beats the hand-built one.
- **Nothing for one task, one site, one program or one model.** The helpers know pages, widgets, pixels and keys. The benchmark measures;
  it is not a list of things to special-case.

## 3. The modules (each hides one thing)
```
core/code-tool.ts      a tool whose input is code: one runner per agent, one call at a time, timeout and cancel by killing the runner
                       (a promise or a Python call cannot be stopped from outside), what the model reads (where, printed, value, pictures)
browser/runner.ts      Node child: attaches to a browser over DevTools, keeps `page` and names, snapshot/screenshot/cdp helpers
browser/chrome.ts      starts a Chrome the tool owns (so a killed runner never leaves a browser behind)
browser/index.ts       the `browser` tool = core + this runner + the browser's lifetime
computer/runner/       Python child: runner.py (the session), a11y.py (tree), screen.py (pixels and input), programs.py (launch, windows),
                       desk.py (the names the code sees), start-desktop.sh (X + the accessibility bus, for hosts that have none)
computer/index.ts      the `computer` tool = core + this runner; calls run one at a time (one pointer)
```
The protocol between core and runner is one JSON line each way: `{id, code}` in, `{id, ok, value, logs, images, error, where}` out.
Where a runner runs is the host's choice (`spawn`), and its environment is exactly what the host passes (`env`): no keys reach the code.

## 4. Rules (each one learned by a failure)
- A timeout or cancel kills the runner and says what was lost (names) and what stays (the browser's tabs, the desktop's programs).
- An exit of a killed runner is heard only by the call that waited on it, never by the next one.
- A widget that is not on screen accepts an action and does nothing, so actions refuse it.
- `Element.click()` never moves the pointer and `set_text()` never types: a hidden switch of layer makes failures unreadable.
- Every browser reply starts with the tab's url and title: the cheapest guard against acting on a stale picture.
- Output is bounded (value 12,000 characters, logs 200 lines) and the cut is said.
- A desktop needs an accessibility bus (D-Bus session, AT-SPI launcher, `GTK_MODULES=gail:atk-bridge`, `NO_AT_BRIDGE=0` for programs).

## 5. Use
```ts
import { createBrowserTool } from "sakura-agent-tools/browser";
import { createComputerTool } from "sakura-agent-tools/computer";
const browser = createBrowserTool();                  // its own Chrome; or { cdpUrl } to attach to one
const computer = createComputerTool({ env: () => desktopEnv });
const agent = await createAgent({ model, tools: [browser, computer] });
// at the end: await browser.close(); await computer.close();
```

## 6. Tests and the benchmark
- `npm test`: the browser against a real headless Chrome and a local page; the computer runner without a desktop; the ten benchmark tasks solved
  by reference code (proves each task is solvable and each check is right, no model).
- `npm run test:desktop`: each computer layer on a real X desktop in a throwaway container of Vesper's box image.
- `npm run bench:browser -- --arm code|menu|both`: ten tasks on a local site, checked by what its server recorded. `menu` is the classic
  one-action-per-call tool on the same runner, for comparison. First run (DeepSeek, one round, 2026-11-17): code 9/10, menu 10/10; input tokens
  per passed task 50k vs 260k; 25 records entered with 8 model calls and 24k tokens vs 36 calls and 2.2M.
