import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { LlmClient, type ChatMessage } from "../llm/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentRegistry } from "../agents/registry.js";
import type { DevLoopPhase, DevLoopStepRecord } from "../types/index.js";

const SYSTEM_PROMPT = `You are the lead software developer inside MTJ DevAgent, an autonomous
coding agent. You do not write final answers in prose - you accomplish the task by calling
the tools available to you (read_file, write_file, list_dir, delete_file, run_command,
inspect_project, and deploy_project if it appears in your tool list).

You work in an explicit development loop with these phases:
1. PLAN - inspect the project (inspect_project, list_dir, read_file) and state a short plan.
2. CODE - make the necessary file changes using write_file.
3. BUILD_TEST - actually run the project's install/build/test commands with run_command.
   Never claim a test passed unless you actually ran it and saw the result.
4. READ_ERROR - if BUILD_TEST failed, read the stdout/stderr carefully.
5. FIX - make targeted file changes to address the error, then go back to BUILD_TEST.
6. DEPLOY (only if deploy_project is available to you, and only after step 3 has actually
   succeeded) - publish the built output and report the live URL back to the user.

Repeat BUILD_TEST -> READ_ERROR -> FIX until tests pass or you hit the iteration limit.
Never call deploy_project unless the most recent BUILD_TEST for this task actually
succeeded - deploying untested or broken code is not acceptable under any circumstance,
even if the user seems to be in a hurry.

When you are done (or stuck), clearly state so in plain text with no further tool calls,
summarizing what changed, the final test result, and the live URL if you deployed.

Be conservative: only touch files relevant to the current task. Do not invent passing
results - only report what the tool output actually showed.`;

export interface DevLoopResult {
  finalPhase: DevLoopPhase;
  iterations: number;
  history: DevLoopStepRecord[];
  transcript: ChatMessage[];
}

export class DevLoopOrchestrator {
  private readonly llm: LlmClient;
  private readonly tools: ToolRegistry;
  private readonly agents: AgentRegistry;
  private readonly log: Logger;
  private readonly maxIterations: number;

  constructor(config: AppConfig, log: Logger, tools: ToolRegistry, agents: AgentRegistry) {
    this.llm = new LlmClient(config, log.child("llm"));
    this.tools = tools;
    this.agents = agents;
    this.log = log.child("devloop");
    this.maxIterations = config.AGENT_MAX_LOOP_ITERATIONS;
  }

  /**
   * Runs the PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX (-> DEPLOY) loop for a
   * given task description, letting the LLM decide which tools to call at each step.
   * Stops when the LLM produces a final text-only response (no more tool calls)
   * or the iteration limit is reached.
   *
   * DEPLOY is only reachable if a successful BUILD_TEST happened first in this run -
   * enforced here in code, not just via the system prompt, since the prompt alone is
   * not a hard guarantee.
   */
  async run(taskDescription: string): Promise<DevLoopResult> {
    const history: DevLoopStepRecord[] = [];
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: taskDescription },
    ];

    this.log.info("dev loop starting", {
      task: taskDescription,
      availableAgents: this.agents.list().map((a) => a.name),
      availableTools: this.tools.list().map((t) => t.name),
      maxIterations: this.maxIterations,
    });

    let iteration = 0;
    let phase: DevLoopPhase = "PLAN";
    let hasSuccessfulBuildTest = false;

    while (iteration < this.maxIterations) {
      iteration += 1;
      this.log.info(`iteration ${iteration}/${this.maxIterations} - calling LLM`, { phase });

      const completion = await this.llm.chat(messages, this.tools.toOpenAiToolSpecs());
      const choice = completion.choices[0];
      const message = choice.message;
      messages.push(message);

      const toolCalls = message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        // LLM produced a final answer with no further tool calls - loop is done.
        const summary = message.content ?? "(no summary provided)";
        this.log.info("dev loop finished - no further tool calls", { summary });
        history.push({
          iteration,
          phase: "DONE",
          summary: typeof summary === "string" ? summary : JSON.stringify(summary),
          timestamp: new Date().toISOString(),
        });
        return { finalPhase: "DONE", iterations: iteration, history, transcript: messages };
      }

      for (const call of toolCalls) {
        const fnName = call.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch (err) {
          this.log.warn("failed to parse tool call arguments", {
            fnName,
            raw: call.function.arguments,
          });
        }

        // Hard guardrail: never actually deploy unless a run_command in THIS run
        // already succeeded. This is enforced here, not just requested in the
        // system prompt, so it can't be talked around.
        if (fnName === "deploy_project" && !hasSuccessfulBuildTest) {
          this.log.warn("blocked deploy_project call - no successful BUILD_TEST yet this run");
          const blocked = {
            ok: false,
            error:
              "deploy_project blocked: no successful build/test has run yet in this session. " +
              "Run the project's build/test command via run_command and confirm it succeeds first.",
          };
          history.push({
            iteration,
            phase: "READ_ERROR",
            summary: "deploy_project blocked - no prior successful BUILD_TEST",
            timestamp: new Date().toISOString(),
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(blocked) });
          continue;
        }

        phase = inferPhase(fnName, phase);
        this.log.info(`tool call: ${fnName}`, { args, phase });

        const result = await this.tools.call(fnName, args);

        if (fnName === "run_command") {
          phase = result.ok ? "BUILD_TEST" : "READ_ERROR";
          if (result.ok) hasSuccessfulBuildTest = true;
        }

        history.push({
          iteration,
          phase,
          summary: `${fnName}(${Object.keys(args).join(", ")}) -> ${result.ok ? "ok" : "error"}`,
          timestamp: new Date().toISOString(),
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    this.log.warn("dev loop hit max iterations without a final answer", {
      maxIterations: this.maxIterations,
    });
    history.push({
      iteration,
      phase: "FAILED",
      summary: `Stopped after ${this.maxIterations} iterations without completion`,
      timestamp: new Date().toISOString(),
    });
    return { finalPhase: "FAILED", iterations: iteration, history, transcript: messages };
  }
}

function inferPhase(toolName: string, current: DevLoopPhase): DevLoopPhase {
  switch (toolName) {
    case "inspect_project":
    case "list_dir":
      return "PLAN";
    case "read_file":
      return current === "BUILD_TEST" || current === "READ_ERROR" ? "READ_ERROR" : "PLAN";
    case "write_file":
    case "delete_file":
      return current === "READ_ERROR" ? "FIX" : "CODE";
    case "run_command":
      return "BUILD_TEST";
    case "deploy_project":
      return "DONE";
    default:
      return current;
  }
}
