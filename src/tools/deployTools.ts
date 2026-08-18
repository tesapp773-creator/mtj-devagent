import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "./workspace.js";
import type { Logger } from "../logger/index.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 180_000;

// Matches the live URL Wrangler prints on a successful Pages deploy,
// e.g. "https://my-project.pages.dev" or a preview alias URL.
const DEPLOY_URL_PATTERN = /https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i;

export interface DeployCredentials {
  apiToken: string;
  accountId: string;
}

function cloudflareEnv(credentials: DeployCredentials): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN: credentials.apiToken,
    CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
  };
}

/**
 * Ensures a Cloudflare Pages project exists before deploying to it. Modern
 * Wrangler versions do NOT auto-create the project on `pages deploy` - it
 * must exist first, or the deploy fails with "Project not found" (confirmed
 * via a live test run). This mirrors that fix: create first, ignore the
 * error if it already exists, then deploy.
 */
async function ensureProjectExists(
  projectName: string,
  workspaceRoot: string,
  credentials: DeployCredentials,
  log: Logger
): Promise<void> {
  try {
    await execFileAsync(
      "npx",
      ["wrangler", "pages", "project", "create", projectName, "--production-branch", "main"],
      {
        cwd: workspaceRoot,
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: cloudflareEnv(credentials),
      }
    );
    log.info(`deploy_project: created new Cloudflare Pages project "${projectName}"`);
  } catch (err) {
    // Expected on every deploy after the first: the project already exists.
    // Wrangler exits non-zero for this - that's fine, not a real failure.
    log.debug(`deploy_project: project "${projectName}" likely already exists, continuing`, {
      detail: (err as Error).message,
    });
  }
}

/**
 * Deployment tool: publishes a built project (inside the agent's workspace)
 * to Cloudflare Pages via Wrangler, and returns the live URL. Only
 * registered when both Cloudflare credentials are present in config -
 * absence of credentials means this tool simply doesn't exist for the LLM
 * to call, rather than failing at call time.
 *
 * This deploys whatever project the agent is building in the workspace -
 * it does NOT deploy MTJ DevAgent itself.
 */
export function createDeployTools(
  workspace: Workspace,
  log: Logger,
  credentials: DeployCredentials
): ToolDefinition[] {
  const deployProject: ToolDefinition = {
    name: "deploy_project",
    description:
      "Deploy a built project directory (e.g. a static site build output like 'dist' or 'build') " +
      "from the workspace to Cloudflare Pages. Creates the Pages project automatically if it " +
      "doesn't exist yet. Returns the live URL on success. Only call this after a successful " +
      "BUILD_TEST phase - never deploy code that hasn't been tested. The projectName should be a " +
      "short, URL-safe name for this deployment (letters, numbers, hyphens).",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Path relative to the workspace root containing the built static output",
        },
        projectName: {
          type: "string",
          description: "URL-safe project name for this Cloudflare Pages deployment",
        },
      },
      required: ["directory", "projectName"],
    },
    execute: async (args): Promise<ToolResult> => {
      const dirArg = String(args.directory);
      const projectName = String(args.projectName).toLowerCase().replace(/[^a-z0-9-]/g, "-");

      let fullDir: string;
      try {
        fullDir = workspace.resolve(dirArg);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      log.info(`deploy_project: ${dirArg} -> Cloudflare Pages project "${projectName}"`);

      await ensureProjectExists(projectName, workspace.root, credentials, log);

      try {
        const { stdout, stderr } = await execFileAsync(
          "npx",
          ["wrangler", "pages", "deploy", fullDir, "--project-name", projectName, "--branch", "main"],
          {
            cwd: workspace.root,
            timeout: DEFAULT_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            env: cloudflareEnv(credentials),
          }
        );

        const combined = `${stdout}\n${stderr}`;
        const match = combined.match(DEPLOY_URL_PATTERN);

        if (!match) {
          log.warn("deploy_project: command succeeded but no live URL found in output");
          return {
            ok: false,
            error: "Deploy command completed but no live URL was found in the output.",
            data: { stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) },
          };
        }

        log.info(`deploy_project succeeded: ${match[0]}`);
        return { ok: true, data: { url: match[0], projectName } };
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        log.warn("deploy_project failed", { error: e.message });
        return {
          ok: false,
          error: `Deployment failed: ${e.message}`,
          data: { stdout: (e.stdout ?? "").slice(-4000), stderr: (e.stderr ?? "").slice(-4000) },
        };
      }
    },
  };

  return [deployProject];
}
