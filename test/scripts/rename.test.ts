import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSandboxRoot, runScript, writeIn } from "./helpers.ts";

describe("rename", () => {
  it("changes the scope in every text file, in scope.json and in the table, in one step", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/router/package.json", '{ "name": "@standin/router", "dependencies": { "@standin/contracts": "*" } }\n');
    writeIn(root, "packages/router/src/index.ts", 'import type { A } from "@standin/contracts";\n');
    writeIn(root, "docs/a.md", "uses @standin/router and an address me@ogbx.example\n");
    const result = runScript(root, "rename.mjs", ["acme"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "packages/router/package.json"), "utf8")).toContain("@acme/router");
    expect(readFileSync(join(root, "packages/router/src/index.ts"), "utf8")).toContain('"@acme/contracts"');
    expect(readFileSync(join(root, "docs/a.md"), "utf8")).toBe("uses @acme/router and an address me@ogbx.example\n");
    expect(JSON.parse(readFileSync(join(root, "scripts/scope.json"), "utf8"))).toEqual({ scope: "@acme" });
  });

  it("leaves the boundary check green after a rename", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/router/src/index.ts", 'import type { A } from "@standin/contracts";\n');
    runScript(root, "rename.mjs", ["@acme"]);
    expect(readFileSync(join(root, "packages/router/src/index.ts"), "utf8")).toContain("@acme/contracts");
    expect(runScript(root, "check-boundaries.mjs").status).toBe(0);
  });

  it("supports --dry-run, the same scope twice, and rejects an invalid scope", () => {
    const root = makeSandboxRoot();
    writeIn(root, "a.md", "@standin/x\n");
    expect(runScript(root, "rename.mjs", ["acme", "--dry-run"]).stdout).toContain("would change a.md");
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("@standin/x\n");
    expect(runScript(root, "rename.mjs", ["@standin"]).stdout).toContain("already");
    expect(runScript(root, "rename.mjs", ["Bad Scope"]).status).toBe(2);
    expect(runScript(root, "rename.mjs").status).toBe(2);
  });
});
