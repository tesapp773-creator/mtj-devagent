import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Workspace } from "../src/tools/workspace.js";
import { createInspectTools } from "../src/tools/inspectTools.js";
import { createLogger } from "../src/logger/index.js";

describe("inspect_project tool", () => {
  let root: string;
  let inspectProject: ReturnType<typeof createInspectTools>[number];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mtj-devagent-inspect-"));
    const workspace = new Workspace(root);
    const log = createLogger("test", "error");
    [inspectProject] = createInspectTools(workspace, log);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports an empty tree for an empty workspace", async () => {
    const result = await inspectProject.execute({});
    expect(result.ok).toBe(true);
    expect((result.data as any).fileCount).toBe(0);
    expect((result.data as any).packageJson).toBeNull();
  });

  it("finds and parses package.json when present", async () => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "test-project", version: "1.0.0" })
    );
    const result = await inspectProject.execute({});
    expect(result.ok).toBe(true);
    expect((result.data as any).packageJson).toEqual({ name: "test-project", version: "1.0.0" });
  });

  it("excludes node_modules and .git from the tree", async () => {
    await fs.mkdir(path.join(root, "node_modules", "some-pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "some-pkg", "index.js"), "x");
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "real-file.ts"), "x");

    const result = await inspectProject.execute({});
    const tree: string[] = (result.data as any).tree;
    expect(tree.some((t) => t.includes("node_modules"))).toBe(false);
    expect(tree.some((t) => t.includes(".git"))).toBe(false);
    expect(tree).toContain("real-file.ts");
  });
});
