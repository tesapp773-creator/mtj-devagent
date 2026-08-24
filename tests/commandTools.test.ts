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

  it("keeps the TAIL of very long output, not the head - the real error/summary is usually at the end", async () => {
    // Simulate a long test run: a huge wall of harmless "PASS" lines, followed by the
    // one line that actually matters - the final real failure summary.
    const script =
      "for (let i = 0; i < 3000; i++) { console.log('PASS test ' + i + ' - '.repeat(3)); } " +
      "console.log('FINAL_SUMMARY: 1 failed, 2999 passed');";
    const result = await runCommand.execute({ command: "node", args: ["-e", script] });
    expect(result.ok).toBe(true);
    const stdout = (result.data as any).stdout as string;
    // The output was long enough to be truncated...
    expect(stdout).toMatch(/truncated \d+ earlier chars/);
    // ...but the actually important final line must still be present.
    expect(stdout).toMatch(/FINAL_SUMMARY: 1 failed, 2999 passed/);
    // And the very early lines (now irrelevant) should have been cut.
    expect(stdout).not.toMatch(/PASS test 0 /);
  });
});
