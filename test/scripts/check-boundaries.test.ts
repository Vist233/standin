import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSandboxRoot, repoRoot, runScript, writeIn } from "./helpers.ts";

describe("check-boundaries", () => {
  it("passes on the real repository", () => {
    const result = runScript(repoRoot, "check-boundaries.mjs");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("passes when every import follows the table", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/contracts/src/index.ts", "export type Id = string;\n");
    writeIn(root, "packages/router/src/index.ts", 'import type { Id } from "@vesper/contracts";\nexport type R = Id;\n');
    writeIn(root, "packages/router/test/a.test.ts", 'import { it } from "vitest";\nimport "@vesper/contracts/testing";\nit("x", () => {});\n');
    expect(runScript(root, "check-boundaries.mjs").status).toBe(0);
  });

  it("fails on a planted bad import: an edge that is not in the table", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/contracts/src/index.ts", 'import { x } from "@vesper/router";\nexport const y = x;\n');
    const result = runScript(root, "check-boundaries.mjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("edge 'contracts' -> 'router' is not in the allowed-dependency table");
  });

  it("fails when a package reaches into another package's src by relative path", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/router/src/index.ts", 'export * from "../../contracts/src/index.ts";\n');
    const result = runScript(root, "check-boundaries.mjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("relative import leaves the package");
  });

  it("fails on a deep import into another package, even for an allowed edge", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/router/src/index.ts", 'import { a } from "@vesper/contracts/src/internal.ts";\nexport const b = a;\n');
    expect(runScript(root, "check-boundaries.mjs").stderr).toContain("reaches into the internals");
  });

  it("fails when production code imports a test double", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/router/src/index.ts", 'import "@vesper/contracts/testing";\n');
    expect(runScript(root, "check-boundaries.mjs").stderr).toContain("test double");
  });

  it("fails on a node built-in in a pure package and on an unlisted external package", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/contracts/src/index.ts", 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n');
    writeIn(root, "packages/router/src/index.ts", 'import _ from "lodash";\nexport default _;\n');
    const result = runScript(root, "check-boundaries.mjs");
    expect(result.stderr).toContain("must not import node built-ins");
    expect(result.stderr).toContain("external package 'lodash' is not allowed");
  });

  it("catches dynamic imports and ignores commented-out imports", () => {
    const root = makeSandboxRoot();
    writeIn(
      root,
      "packages/contracts/src/index.ts",
      '// import "@vesper/router";\n/* import "@vesper/secrets"; */\nexport const load = () => import("@vesper/gateway");\n',
    );
    const result = runScript(root, "check-boundaries.mjs");
    expect(result.stderr).toContain("'contracts' -> 'gateway'");
    expect(result.stderr).not.toContain("'router'");
    expect(result.stderr).not.toContain("'secrets'");
  });

  it("lets a plugin use only the npm packages the table grants it by name, and ignores generated dist bundles", () => {
    const root = makeSandboxRoot();
    writeIn(root, "plugins/handoff/src/tools.ts", 'import { createHandoffTool } from "sakura-agent-tools/handoff";\nexport const x = createHandoffTool;\n');
    writeIn(root, "plugins/other/src/tools.ts", 'import { createHandoffTool } from "sakura-agent-tools/handoff";\nexport const x = createHandoffTool;\n');
    writeIn(root, "plugins/handoff/dist/tools.js", 'import "@vesper/gateway";\nimport "lodash";\n'); // a bundle is generated, not checked
    const result = runScript(root, "check-boundaries.mjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugins/other/src/tools.ts imports 'sakura-agent-tools/handoff'");
    expect(result.stderr).not.toContain("plugins/handoff");
  });

  it("does not mistake prose in a string for an import", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/contracts/src/index.ts", "export const message = \"'from' and 'to' must be ISO times\";\n");
    expect(runScript(root, "check-boundaries.mjs").status).toBe(0);
  });

  it("fails on a package that is missing from the table, and on a package.json that declares a forbidden edge", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/surprise/src/index.ts", "export {};\n");
    writeIn(root, "packages/router/package.json", JSON.stringify({ name: "@vesper/router", dependencies: { "@vesper/gateway": "*" } }));
    const result = runScript(root, "check-boundaries.mjs");
    expect(result.stderr).toContain("package 'surprise' is not in the allowed-dependency table");
    expect(result.stderr).toContain("package.json declares 'gateway'");
  });

  it("lets the gateway src use session-runtime, and workspace-client only from tests (the table lists what src really imports)", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/gateway/src/index.ts", 'import "@vesper/session-runtime";\n');
    writeIn(root, "packages/gateway/test/a.test.ts", 'import "@vesper/workspace-client";\nimport "@vesper/event-journal";\n');
    expect(runScript(root, "check-boundaries.mjs").status).toBe(0);
    writeIn(root, "packages/gateway/src/other.ts", 'import "@vesper/workspace-client";\n');
    const result = runScript(root, "check-boundaries.mjs");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("edge 'gateway' -> 'workspace-client' is allowed in tests only");
    const table = JSON.parse(readFileSync(join(root, "scripts/allowed-dependencies.json"), "utf8"));
    table.packages.gateway.testDependencies = [];
    writeIn(root, "packages/gateway/src/other.ts", "export {};\n");
    writeFileSync(join(root, "scripts/allowed-dependencies.json"), JSON.stringify(table));
    expect(runScript(root, "check-boundaries.mjs").stderr).toContain("edge 'gateway' -> 'workspace-client' is not in the allowed-dependency table");
  });

  it("does not let the gateway use the router: it only reaches it through session-runtime", () => {
    const root = makeSandboxRoot();
    writeIn(root, "packages/gateway/src/index.ts", 'import "@vesper/router";\n');
    expect(runScript(root, "check-boundaries.mjs").stderr).toContain("edge 'gateway' -> 'router' is not in the allowed-dependency table");
  });
});
