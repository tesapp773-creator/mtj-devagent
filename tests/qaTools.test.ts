import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Workspace } from "../src/tools/workspace.js";
import { createQaWriteTool } from "../src/tools/qaTools.js";
import { createLogger } from "../src/logger/index.js";

describe("write_qa_file tool (QA agent's only write capability)", () => {
  let root: string;
  let tool: ReturnType<typeof createQaWriteTool>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mtj-devagent-qatools-"));
    const workspace = new Workspace(root);
    const log = createLogger("test", "error");
    tool = createQaWriteTool(workspace, log);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes a plain filename under qa/", async () => {
    const result = await tool.execute({ path: "check.js", content: "console.log(1)" });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(path.join(root, "qa", "check.js"), "utf-8");
    expect(written).toBe("console.log(1)");
  });

  it("SECURITY: strips a directory-traversal attempt so it cannot escape qa/ or overwrite app files", async () => {
    // Simulate the exact attack this tool exists to prevent: the QA agent trying
    // to "fix" its own review by overwriting the real app.js at the workspace root.
    await fs.writeFile(path.join(root, "app.js"), "ORIGINAL APP CODE");

    const result = await tool.execute({ path: "../../app.js", content: "TAMPERED" });
    expect(result.ok).toBe(true);

    // The real app.js at the workspace root must be untouched.
    const realAppJs = await fs.readFile(path.join(root, "app.js"), "utf-8");
    expect(realAppJs).toBe("ORIGINAL APP CODE");

    // The write must have landed inside qa/ instead, under just the basename.
    const qaFile = await fs.readFile(path.join(root, "qa", "app.js"), "utf-8");
    expect(qaFile).toBe("TAMPERED");
  });

  it("SECURITY: strips an absolute path attempt down to just the filename", async () => {
    const result = await tool.execute({ path: "/etc/passwd", content: "irrelevant" });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(path.join(root, "qa", "passwd"), "utf-8");
    expect(written).toBe("irrelevant");
  });

  it("falls back to a safe default filename when path is empty", async () => {
    const result = await tool.execute({ path: "", content: "x" });
    expect(result.ok).toBe(true);
    const written = await fs.readFile(path.join(root, "qa", "unnamed.txt"), "utf-8");
    expect(written).toBe("x");
  });
});
