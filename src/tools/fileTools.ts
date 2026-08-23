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
      "Create a NEW file, or completely overwrite an existing one, with the given content. " +
      "Creates parent directories as needed. For a SMALL, targeted change to a file that " +
      "already exists (fixing a bug, changing a few lines), prefer edit_file instead - it is " +
      "far cheaper and avoids regenerating content that doesn't need to change. Only use " +
      "write_file for existing files when the change is substantial enough that most of the " +
      "file's content is changing anyway.",
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

  const editFile: ToolDefinition = {
    name: "edit_file",
    description:
      "Make a SMALL, TARGETED change to an existing file by replacing one exact snippet of " +
      "text with another - without regenerating the rest of the file. This is the preferred " +
      "way to fix a bug, change a line, or make any small edit to a file that already exists: " +
      "it is much cheaper than write_file and avoids wasting effort re-outputting content " +
      "that isn't changing. old_str must match the file's exact current content, including " +
      "whitespace, and must appear in exactly ONE place in the file - if it matches zero or " +
      "multiple places, this fails and tells you why, so you can include a bit more " +
      "surrounding context to make it unique and try again. To delete a snippet, pass an " +
      "empty new_str. Use write_file instead only when creating a brand-new file or when " +
      "the change is so large that most of the file's content is being replaced anyway.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project workspace root" },
        old_str: {
          type: "string",
          description:
            "Exact text to find and replace - must match the file's current content exactly " +
            "(including whitespace) and appear exactly once. Include enough surrounding " +
            "context to make it unique.",
        },
        new_str: {
          type: "string",
          description: "Replacement text. Pass an empty string to delete the matched text.",
        },
      },
      required: ["path", "old_str", "new_str"],
    },
    execute: async (args): Promise<ToolResult> => {
      const rel = String(args.path);
      const oldStr = String(args.old_str ?? "");
      const newStr = String(args.new_str ?? "");

      if (oldStr.length === 0) {
        return { ok: false, error: "old_str cannot be empty - edit_file requires exact text to find." };
      }

      let full: string;
      try {
        full = workspace.resolve(rel);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      let content: string;
      try {
        content = await fs.readFile(full, "utf-8");
      } catch (err) {
        log.warn(`edit_file failed to read: ${rel}`, { error: String(err) });
        return {
          ok: false,
          error: `Failed to read ${rel}: ${(err as Error).message}. Use write_file to create a new file instead.`,
        };
      }

      const firstIndex = content.indexOf(oldStr);
      if (firstIndex === -1) {
        log.warn(`edit_file: old_str not found in ${rel}`);
        return {
          ok: false,
          error:
            `old_str was not found in ${rel}. Read the file again to confirm its exact ` +
            `current content (including whitespace) before retrying.`,
        };
      }

      const lastIndex = content.lastIndexOf(oldStr);
      if (firstIndex !== lastIndex) {
        log.warn(`edit_file: old_str is ambiguous (multiple matches) in ${rel}`);
        return {
          ok: false,
          error:
            `old_str matches more than one place in ${rel}, so it's ambiguous which one to ` +
            `replace. Include more surrounding context (a few extra lines before/after) to ` +
            `make it match exactly one location, then try again.`,
        };
      }

      const updated = content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length);

      try {
        await fs.writeFile(full, updated, "utf-8");
        log.info(`edit_file: ${rel}`, { oldLen: oldStr.length, newLen: newStr.length });
        return { ok: true, data: { path: rel, oldLength: oldStr.length, newLength: newStr.length } };
      } catch (err) {
        log.warn(`edit_file failed to write: ${rel}`, { error: String(err) });
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

  return [readFile, writeFile, editFile, listDir, deleteFile];
}
