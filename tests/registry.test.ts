import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createLogger } from "../src/logger/index.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("ToolRegistry - deploy_project gating", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mtj-devagent-registry-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does NOT register deploy_project when no Cloudflare credentials are given", () => {
    const log = createLogger("test", "error");
    const registry = new ToolRegistry(root, log);
    const names = registry.list().map((t) => t.name);
    expect(names).not.toContain("deploy_project");
  });

  it("does NOT register deploy_project when only one of the two credentials is present", () => {
    const log = createLogger("test", "error");
    const registry = new ToolRegistry(root, log, {
      cloudflare: { apiToken: "fake-token", accountId: undefined },
    });
    const names = registry.list().map((t) => t.name);
    expect(names).not.toContain("deploy_project");
  });

  it("registers deploy_project only when BOTH credentials are present", () => {
    const log = createLogger("test", "error");
    const registry = new ToolRegistry(root, log, {
      cloudflare: { apiToken: "fake-token", accountId: "fake-account-id" },
    });
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("deploy_project");
  });

  it("still registers the core tools regardless of Cloudflare config", () => {
    const log = createLogger("test", "error");
    const registry = new ToolRegistry(root, log);
    const names = registry.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["read_file", "write_file", "list_dir", "delete_file", "run_command", "inspect_project"])
    );
  });
});
