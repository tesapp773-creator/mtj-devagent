import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "./workspace.js";
import type { Logger } from "../logger/index.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

export function createCommandTools(workspace: Workspace, log: Logger): ToolDefinition[] {
  const runCommand: ToolDefinition = {
    name: "run_command",
    description:
      "Run a shell command inside the project workspace (e.g. npm install, npm test, npm run build). " +
      "Returns stdout, stderr, and exit code. Use this for builds, tests, and inspecting the project " +
      "with commands like 'ls' or 'cat'. Commands run with the workspace root as the working directory.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run, e.g. 'npm'" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments, e.g. ['install'] or ['test']",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout override in milliseconds (default 120000)",
        },
      },
      required: ["command"],
    },
    execute: async (args): Promise<ToolResult> => {
      const command = String(args.command);
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : DEFAULT_TIMEOUT_MS;

      log.info(`run_command: ${command} ${cmdArgs.join(" ")}`);
      try {
        const { stdout, stderr } = await execFileAsync(command, cmdArgs, {
          cwd: workspace.root,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });
        log.info(`run_command succeeded: ${command}`, { exitCode: 0 });
        return {
          ok: true,
          data: {
            command: `${command} ${cmdArgs.join(" ")}`.trim(),
            exitCode: 0,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
          },
        };
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
        log.warn(`run_command failed: ${command}`, { exitCode: e.code, error: e.message });
        // Non-zero exit / build-test failure is NOT a tool malfunction - it's expected
        // data the agent needs to read and act on (READ_ERROR -> FIX phase).
        return {
          ok: false,
          data: {
            command: `${command} ${cmdArgs.join(" ")}`.trim(),
            exitCode: typeof e.code === "number" ? e.code : -1,
            stdout: truncate(e.stdout ?? ""),
            stderr: truncate(e.stderr ?? e.message ?? ""),
          },
          error: `Command exited with error: ${e.message}`,
        };
      }
    },
  };

  return [runCommand];
}
