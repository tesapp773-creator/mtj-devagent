import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Workspace } from "../src/tools/workspace.js";
import { createFileTools } from "../src/tools/fileTools.js";
import { createLogger } from "../src/logger/index.js";

describe("file tools", () => {
  let root: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mtj-devagent-filetools-"));
    const workspace = new Workspace(root);
    const log = createLogger("test", "error");
    tools = createFileTools(workspace, log);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function getTool(name: string) {
    const t = tools.find((t) => t.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  it("writes and reads back a file", async () => {
    const write = getTool("write_file");
    const read = getTool("read_file");

    const writeResult = await write.execute({ path: "hello.txt", content: "hello world" });
    expect(writeResult.ok).toBe(true);

    const readResult = await read.execute({ path: "hello.txt" });
    expect(readResult.ok).toBe(true);
    expect((readResult.data as any).content).toBe("hello world");
  });

  it("creates parent directories automatically", async () => {
    const write = getTool("write_file");
    const result = await write.execute({ path: "nested/dir/file.txt", content: "x" });
    expect(result.ok).toBe(true);
    const exists = await fs.readFile(path.join(root, "nested", "dir", "file.txt"), "utf-8");
    expect(exists).toBe("x");
  });

  it("lists directory contents", async () => {
    const write = getTool("write_file");
    const list = getTool("list_dir");

    await write.execute({ path: "one.txt", content: "1" });
    await write.execute({ path: "sub/two.txt", content: "2" });

    const result = await list.execute({ path: "." });
    expect(result.ok).toBe(true);
    const entries = (result.data as any).entries as Array<{ name: string; type: string }>;
    expect(entries.some((e) => e.name === "one.txt" && e.type === "file")).toBe(true);
    expect(entries.some((e) => e.name === "sub" && e.type === "dir")).toBe(true);
  });

  it("returns ok:false (not a throw) when reading a missing file", async () => {
    const read = getTool("read_file");
    const result = await read.execute({ path: "does-not-exist.txt" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("deletes a file", async () => {
    const write = getTool("write_file");
    const del = getTool("delete_file");
    const read = getTool("read_file");

    await write.execute({ path: "temp.txt", content: "x" });
    const delResult = await del.execute({ path: "temp.txt" });
    expect(delResult.ok).toBe(true);

    const readResult = await read.execute({ path: "temp.txt" });
    expect(readResult.ok).toBe(false);
  });

  it("refuses to write outside the workspace sandbox", async () => {
    const write = getTool("write_file");
    const result = await write.execute({ path: "../outside.txt", content: "escape" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes workspace sandbox/);
  });
});
