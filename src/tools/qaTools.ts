import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "./workspace.js";
import type { Logger } from "../logger/index.js";

/**
 * Restricted write tool, exclusively for the independent QA agent. The QA
 * agent must NEVER be able to modify the application code it is reviewing -
 * only the builder (via write_file) can do that. This hard-enforces (in
 * code, not just via prompt) that every path it writes to lands inside a
 * fixed qa/ subdirectory of the workspace: the filename is taken via
 * path.basename, discarding any directory components (including "../"
 * traversal attempts) the caller supplied, then always joined under "qa/".
 * This lets the QA agent create its own scratch/verification scripts
 * without any way of "fixing" its own review by editing the shipped code.
 */
export function createQaWriteTool(workspace: Workspace, log: Logger): ToolDefinition {
  return {
    name: "write_qa_file",
    description:
      "Create or overwrite a file for your OWN use (e.g. a verification or attack script you " +
      "write yourself). Only the filename matters - it is always placed under a qa/ " +
      "subdirectory. You cannot write anywhere else, and specifically cannot modify or " +
      "overwrite the application's own source files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Filename only - it will always be placed under qa/" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
    execute: async (args): Promise<ToolResult> => {
      const rawName = String(args.path ?? "");
      const filename = path.basename(rawName) || "unnamed.txt";
      const rel = path.posix.join("qa", filename);
      const content = String(args.content ?? "");
      try {
        const full = workspace.resolve(rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, "utf-8");
        log.info(`write_qa_file: ${rel}`, { bytes: content.length, requestedPath: rawName });
        return { ok: true, data: { path: rel, bytesWritten: content.length } };
      } catch (err) {
        log.warn(`write_qa_file failed: ${rel}`, { error: String(err) });
        return { ok: false, error: `Failed to write ${rel}: ${(err as Error).message}` };
      }
    },
  };
}
