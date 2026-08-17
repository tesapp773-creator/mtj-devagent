import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Workspace } from "../src/tools/workspace.js";
import { createCommandTools } from "../src/tools/commandTools.js";
import { createLogger } from "../src/logger/index.js";

describe("command tools", () => {
  let root: string;
  let runCommand: ReturnType<typeof createCommandTools>[number];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mtj-devagent-cmdtools-"));
    const workspace = new Workspace(root);
    const log = createLogger("test", "error");
    [runCommand] = createCommandTools(workspace, log);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("runs a successful command and captures stdout", async () => {
    const result = await runCommand.execute({ command: "node", args: ["-e", "console.log('hi')"] });
    expect(result.ok).toBe(true);
    expect((result.data as any).stdout.trim()).toBe("hi");
    expect((result.data as any).exitCode).toBe(0);
  });

  it("captures a non-zero exit and stderr without throwing", async () => {
    const result = await runCommand.execute({
      command: "node",
      args: ["-e", "console.error('boom'); process.exit(1)"],
    });
    expect(result.ok).toBe(false);
    expect((result.data as any).exitCode).toBe(1);
    expect((result.data as any).stderr).toMatch(/boom/);
  });

  it("runs commands with the workspace root as cwd", async () => {
    await fs.writeFile(path.join(root, "marker.txt"), "present");
    const result = await runCommand.execute({ command: "node", args: ["-e", "console.log(require('fs').existsSync('marker.txt'))"] });
    expect(result.ok).toBe(true);
    expect((result.data as any).stdout.trim()).toBe("true");
  });
});
