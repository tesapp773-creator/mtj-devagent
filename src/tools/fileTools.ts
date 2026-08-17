import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "./workspace.js";
import type { Logger } from "../logger/index.js";

export function createFileTools(workspace: Workspace, log: Logger): ToolDefinition[] {
  const readFile: ToolDefinition = {
    name: "read_file",
    description: "Read the full text contents of a file in the project workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project workspace root" },
      },
      required: ["path"],
    },
    execute: async (args): Promise<ToolResult> => {
      const rel = String(args.path);
      try {
        const full = workspace.resolve(rel);
        const content = await fs.readFile(full, "utf-8");
        log.info(`read_file: ${rel}`, { bytes: content.length });
        return { ok: true, data: { path: rel, content } };
      } catch (err) {
        log.warn(`read_file failed: ${rel}`, { error: String(err) });
        return { ok: false, error: `Failed to read ${rel}: ${(err as Error).message}` };
      }
    },
  };

  const writeFile: ToolDefinition = {
    name: "write_file",
    description:
      "Create or overwrite a file in the project workspace with the given content. " +
      "Creates parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project workspace root" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
    execute: async (args): Promise<ToolResult> => {
      const rel = String(args.path);
      const content = String(args.content ?? "");
      try {
        const full = workspace.resolve(rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, "utf-8");
        log.info(`write_file: ${rel}`, { bytes: content.length });
        return { ok: true, data: { path: rel, bytesWritten: content.length } };
      } catch (err) {
        log.warn(`write_file failed: ${rel}`, { error: String(err) });
        return { ok: false, error: `Failed to write ${rel}: ${(err as Error).message}` };
      }
    },
  };

  const listDir: ToolDefinition = {
    name: "list_dir",
    description: "List files and directories at a given path in the project workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to workspace root. Use '.' for root." },
      },
      required: ["path"],
    },
    execute: async (args): Promise<ToolResult> => {
      const rel = String(args.path ?? ".");
      try {
        const full = workspace.resolve(rel);
        const entries = await fs.readdir(full, { withFileTypes: true });
        const listing = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
        }));
        log.info(`list_dir: ${rel}`, { count: listing.length });
        return { ok: true, data: { path: rel, entries: listing } };
      } catch (err) {
        log.warn(`list_dir failed: ${rel}`, { error: String(err) });
        return { ok: false, error: `Failed to list ${rel}: ${(err as Error).message}` };
      }
    },
  };

  const deleteFile: ToolDefinition = {
    name: "delete_file",
    description: "Delete a file in the project workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project workspace root" },
      },
      required: ["path"],
    },
    execute: async (args): Promise<ToolResult> => {
      const rel = String(args.path);
      try {
        const full = workspace.resolve(rel);
        await fs.rm(full);
        log.info(`delete_file: ${rel}`);
        return { ok: true, data: { path: rel } };
      } catch (err) {
        log.warn(`delete_file failed: ${rel}`, { error: String(err) });
        return { ok: false, error: `Failed to delete ${rel}: ${(err as Error).message}` };
      }
    },
  };

  return [readFile, writeFile, listDir, deleteFile];
}
