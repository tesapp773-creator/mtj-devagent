import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { Logger } from "../logger/index.js";
import { Workspace } from "./workspace.js";
import { createFileTools } from "./fileTools.js";
import { createCommandTools } from "./commandTools.js";
import { createInspectTools } from "./inspectTools.js";
import { createDeployTools } from "./deployTools.js";

export interface ToolRegistryOptions {
  /** Present only when both are set - enables the deploy_project tool. */
  cloudflare?: {
    apiToken?: string;
    accountId?: string;
  };
}

/**
 * Collects every tool the orchestrator can call. This is the ONLY layer
 * that touches the filesystem or spawns processes - the orchestrator
 * itself never does either directly, it only asks the LLM which tool
 * to call and dispatches through here.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  readonly workspace: Workspace;

  constructor(workspaceRoot: string, log: Logger, options: ToolRegistryOptions = {}) {
    this.workspace = new Workspace(workspaceRoot);
    const all = [
      ...createFileTools(this.workspace, log.child("tool")),
      ...createCommandTools(this.workspace, log.child("tool")),
      ...createInspectTools(this.workspace, log.child("tool")),
    ];

    const cfApiToken = options.cloudflare?.apiToken;
    const cfAccountId = options.cloudflare?.accountId;
    if (cfApiToken && cfAccountId) {
      all.push(
        ...createDeployTools(this.workspace, log.child("tool"), {
          apiToken: cfApiToken,
          accountId: cfAccountId,
        })
      );
    } else {
      log.debug("deploy_project tool not registered - Cloudflare credentials not configured");
    }

    for (const t of all) this.tools.set(t.name, t);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** JSON-schema tool specs formatted for the OpenAI-compatible tool-calling API. */
  toOpenAiToolSpecs() {
    return this.list().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: "${name}". Available: ${[...this.tools.keys()].join(", ")}` };
    }
    return tool.execute(args);
  }
}
