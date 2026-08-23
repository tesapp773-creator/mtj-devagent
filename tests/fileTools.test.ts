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

describe("edit_file tool (targeted find-and-replace, avoids full-file rewrites)", () => {
  let root: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mtj-devagent-editfile-"));
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

  it("replaces a unique snippet, leaving the rest of the file untouched", async () => {
    const write = getTool("write_file");
    const edit = getTool("edit_file");
    const read = getTool("read_file");

    await write.execute({
      path: "app.js",
      content: "function add(a, b) {\n  return a - b; // BUG\n}\n",
    });

    const editResult = await edit.execute({
      path: "app.js",
      old_str: "return a - b; // BUG",
      new_str: "return a + b;",
    });
    expect(editResult.ok).toBe(true);

    const readResult = await read.execute({ path: "app.js" });
    expect((readResult.data as any).content).toBe(
      "function add(a, b) {\n  return a + b;\n}\n"
    );
  });

  it("fails clearly, without modifying the file, when old_str is not found", async () => {
    const write = getTool("write_file");
    const edit = getTool("edit_file");
    const read = getTool("read_file");

    await write.execute({ path: "app.js", content: "const x = 1;\n" });

    const editResult = await edit.execute({
      path: "app.js",
      old_str: "const y = 2;",
      new_str: "const y = 3;",
    });
    expect(editResult.ok).toBe(false);
    expect(editResult.error).toMatch(/not found/);

    const readResult = await read.execute({ path: "app.js" });
    expect((readResult.data as any).content).toBe("const x = 1;\n");
  });

  it("fails clearly, without modifying the file, when old_str matches more than once", async () => {
    const write = getTool("write_file");
    const edit = getTool("edit_file");
    const read = getTool("read_file");

    await write.execute({ path: "app.js", content: "foo();\nfoo();\n" });

    const editResult = await edit.execute({
      path: "app.js",
      old_str: "foo();",
      new_str: "bar();",
    });
    expect(editResult.ok).toBe(false);
    expect(editResult.error).toMatch(/more than one place/);

    const readResult = await read.execute({ path: "app.js" });
    expect((readResult.data as any).content).toBe("foo();\nfoo();\n");
  });

  it("succeeds once more context is added to make the match unique", async () => {
    const write = getTool("write_file");
    const edit = getTool("edit_file");
    const read = getTool("read_file");

    await write.execute({ path: "app.js", content: "foo();\nfoo(); // second\n" });

    const editResult = await edit.execute({
      path: "app.js",
      old_str: "foo(); // second",
      new_str: "bar(); // second",
    });
    expect(editResult.ok).toBe(true);

    const readResult = await read.execute({ path: "app.js" });
    expect((readResult.data as any).content).toBe("foo();\nbar(); // second\n");
  });

  it("can delete a snippet by replacing it with an empty string", async () => {
    const write = getTool("write_file");
    const edit = getTool("edit_file");
    const read = getTool("read_file");

    await write.execute({ path: "app.js", content: "console.log('debug');\nrealCode();\n" });

    const editResult = await edit.execute({
      path: "app.js",
      old_str: "console.log('debug');\n",
      new_str: "",
    });
    expect(editResult.ok).toBe(true);

    const readResult = await read.execute({ path: "app.js" });
    expect((readResult.data as any).content).toBe("realCode();\n");
  });

  it("rejects an empty old_str", async () => {
    const write = getTool("write_file");
    const edit = getTool("edit_file");

    await write.execute({ path: "app.js", content: "x" });
    const editResult = await edit.execute({ path: "app.js", old_str: "", new_str: "y" });
    expect(editResult.ok).toBe(false);
    expect(editResult.error).toMatch(/cannot be empty/);
  });

  it("fails clearly when the file does not exist", async () => {
    const edit = getTool("edit_file");
    const result = await edit.execute({ path: "missing.js", old_str: "a", new_str: "b" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Failed to read/);
  });

  it("refuses to edit outside the workspace sandbox", async () => {
    const edit = getTool("edit_file");
    const result = await edit.execute({ path: "../outside.txt", old_str: "a", new_str: "b" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/escapes workspace sandbox/);
  });
});
