import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "./workspace.js";
import type { Logger } from "../logger/index.js";

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "qa"]);
// Skip obviously-binary file types - reading them as utf-8 and scanning line-by-line
// wastes time and can produce garbage "matches".
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".zip", ".gz", ".tar", ".mp3", ".mp4", ".mov", ".wasm",
]);
// Defensive cap so one enormous file (e.g. a bundled/minified asset) can't make a
// single search call slow or memory-heavy.
const MAX_FILE_BYTES = 1_000_000;
// Cap total matches returned - a search that hit thousands of matches would otherwise
// dump an enormous, mostly-useless result back into the conversation, wasting context
// the same way an untruncated command output would.
const MAX_MATCHES = 200;

interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

async function walkAndSearch(
  dir: string,
  root: string,
  needle: string,
  caseSensitive: boolean,
  matches: SearchMatch[]
): Promise<void> {
  if (matches.length >= MAX_MATCHES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES) return;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndSearch(full, root, needle, caseSensitive, matches);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;

    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = await fs.readFile(full, "utf-8");
    } catch {
      continue; // likely not valid utf-8 text - skip rather than fail the whole search
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES) return;
      const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (haystack.includes(needle)) {
        matches.push({
          file: path.relative(root, full),
          line: i + 1,
          text: lines[i].trim().slice(0, 300),
        });
      }
    }
  }
}

/**
 * search_code: a plain-text, grep-like search across the whole workspace. This exists
 * because without it, finding where something is defined or used in an unfamiliar or
 * large project (especially an existing-project pull-request run) required reading many
 * files one at a time via read_file - slow and expensive. A single search call replaces
 * that with one targeted pass, directly cutting wasted tool calls and LLM output tokens.
 * Read-only, so it's safe to expose to both the builder and the independent QA agent.
 */
export function createSearchTools(workspace: Workspace, log: Logger): ToolDefinition[] {
  const searchCode: ToolDefinition = {
    name: "search_code",
    description:
      "Search for a plain-text pattern across every file in the project workspace (like grep) " +
      "and get back matching file paths, line numbers, and the matching line's content. Use " +
      "this to quickly find where something is defined or used, instead of reading many files " +
      "one by one - especially valuable in a large or unfamiliar existing project. This does a " +
      "plain substring match per line, not a regex.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search is case-sensitive (default false)",
        },
      },
      required: ["query"],
    },
    execute: async (args): Promise<ToolResult> => {
      const query = String(args.query ?? "");
      if (!query) {
        return { ok: false, error: "query cannot be empty" };
      }
      const caseSensitive = args.case_sensitive === true;
      const needle = caseSensitive ? query : query.toLowerCase();

      try {
        const matches: SearchMatch[] = [];
        await walkAndSearch(workspace.root, workspace.root, needle, caseSensitive, matches);
        const truncated = matches.length >= MAX_MATCHES;
        log.info(`search_code: "${query}"`, { matchCount: matches.length, truncated });
        return {
          ok: true,
          data: { query, matchCount: matches.length, truncated, matches },
        };
      } catch (err) {
        log.warn("search_code failed", { error: String(err) });
        return { ok: false, error: (err as Error).message };
      }
    },
  };

  return [searchCode];
}
