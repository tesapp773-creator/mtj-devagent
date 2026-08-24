import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Workspace } from "../src/tools/workspace.js";
import { createSearchTools } from "../src/tools/searchTools.js";
import { createLogger } from "../src/logger/index.js";

describe("search_code tool", () => {
  let root: string;
  let searchCode: ReturnType<typeof createSearchTools>[number];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mtj-devagent-search-"));
    const workspace = new Workspace(root);
    const log = createLogger("test", "error");
    [searchCode] = createSearchTools(workspace, log);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("finds a match with file, line number, and text", async () => {
    await fs.writeFile(path.join(root, "app.js"), "const x = 1;\nfunction deleteTask(id) {}\nconst y = 2;\n");
    const result = await searchCode.execute({ query: "deleteTask" });
    expect(result.ok).toBe(true);
    const matches = (result.data as any).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ file: "app.js", line: 2 });
    expect(matches[0].text).toContain("deleteTask");
  });

  it("finds matches across multiple files and subdirectories", async () => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "index.js"), "import { helper } from './src/util.js';\n");
    await fs.writeFile(path.join(root, "src", "util.js"), "export function helper() {}\n");

    const result = await searchCode.execute({ query: "helper" });
    expect(result.ok).toBe(true);
    const files = (result.data as any).matches.map((m: any) => m.file).sort();
    expect(files).toEqual(["index.js", path.join("src", "util.js")].sort());
  });

  it("is case-insensitive by default", async () => {
    await fs.writeFile(path.join(root, "a.js"), "const FooBar = 1;\n");
    const result = await searchCode.execute({ query: "foobar" });
    expect(result.ok).toBe(true);
    expect((result.data as any).matchCount).toBe(1);
  });

  it("respects case_sensitive: true", async () => {
    await fs.writeFile(path.join(root, "a.js"), "const FooBar = 1;\n");
    const result = await searchCode.execute({ query: "foobar", case_sensitive: true });
    expect(result.ok).toBe(true);
    expect((result.data as any).matchCount).toBe(0);
  });

  it("ignores node_modules, .git, and other noise directories", async () => {
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "const secretTarget = 1;\n");
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "config"), "secretTarget\n");
    await fs.writeFile(path.join(root, "real.js"), "const secretTarget = 2;\n");

    const result = await searchCode.execute({ query: "secretTarget" });
    expect(result.ok).toBe(true);
    const files = (result.data as any).matches.map((m: any) => m.file);
    expect(files).toEqual(["real.js"]);
  });

  it("returns ok:true with zero matches (not an error) when nothing is found", async () => {
    await fs.writeFile(path.join(root, "a.js"), "nothing interesting here\n");
    const result = await searchCode.execute({ query: "totallyAbsentTerm" });
    expect(result.ok).toBe(true);
    expect((result.data as any).matchCount).toBe(0);
  });

  it("rejects an empty query", async () => {
    const result = await searchCode.execute({ query: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be empty/);
  });

  it("marks the result as truncated when matches exceed the cap", async () => {
    for (let i = 0; i < 210; i++) {
      await fs.writeFile(path.join(root, `file${i}.js`), "const findme = 1;\n");
    }
    const result = await searchCode.execute({ query: "findme" });
    expect(result.ok).toBe(true);
    expect((result.data as any).truncated).toBe(true);
    expect((result.data as any).matches.length).toBeLessThanOrEqual(200);
  });
});
