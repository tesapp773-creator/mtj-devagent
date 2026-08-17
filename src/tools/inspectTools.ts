import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "./workspace.js";
import type { Logger } from "../logger/index.js";

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

async function walk(dir: string, root: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth > maxDepth) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...(await walk(full, root, depth + 1, maxDepth)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

export function createInspectTools(workspace: Workspace, log: Logger): ToolDefinition[] {
  const inspectProject: ToolDefinition = {
    name: "inspect_project",
    description:
      "Get a summary of the current project workspace: directory tree, and package.json " +
      "contents if present. Use this at the start of PLAN to understand current state before " +
      "proposing changes.",
    parameters: {
      type: "object",
      properties: {
        maxDepth: { type: "number", description: "Max directory depth to walk (default 4)" },
      },
    },
    execute: async (args): Promise<ToolResult> => {
      const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 4;
      try {
        await workspace.ensureExists();
        const tree = await walk(workspace.root, workspace.root, 0, maxDepth);

        let packageJson: unknown = null;
        try {
          const raw = await fs.readFile(workspace.resolve("package.json"), "utf-8");
          packageJson = JSON.parse(raw);
        } catch {
          // no package.json present - not an error
        }

        log.info("inspect_project", { fileCount: tree.length, hasPackageJson: !!packageJson });
        return {
          ok: true,
          data: {
            root: workspace.root,
            fileCount: tree.length,
            tree,
            packageJson,
          },
        };
      } catch (err) {
        log.warn("inspect_project failed", { error: String(err) });
        return { ok: false, error: (err as Error).message };
      }
    },
  };

  return [inspectProject];
}
