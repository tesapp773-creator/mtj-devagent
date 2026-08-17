import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/tools/workspace.js";

describe("Workspace sandbox", () => {
  const root = path.join(os.tmpdir(), "mtj-devagent-test-workspace");
  const workspace = new Workspace(root);

  it("resolves a simple relative path inside the root", () => {
    const resolved = workspace.resolve("src/index.ts");
    expect(resolved).toBe(path.join(root, "src", "index.ts"));
  });

  it("resolves the root itself", () => {
    expect(workspace.resolve(".")).toBe(root);
  });

  it("throws when a path tries to escape the root via ..", () => {
    expect(() => workspace.resolve("../../etc/passwd")).toThrow(/escapes workspace sandbox/);
  });

  it("throws when an absolute path outside root is given", () => {
    expect(() => workspace.resolve("/etc/passwd")).toThrow(/escapes workspace sandbox/);
  });
});
