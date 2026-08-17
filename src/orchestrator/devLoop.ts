import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { LlmClient, type ChatMessage } from "../llm/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentRegistry } from "../agents/registry.js";
import type { DevLoopPhase, DevLoopStepRecord } from "../types/index.js";

const SYSTEM_PROMPT = `You are the lead software developer inside MTJ DevAgent, an autonomous
coding agent. You do not write final answers in prose - you accomplish the task by calling
the tools available to you (read_file, write_file, list_dir, delete_file, run_command,
inspect_project).

You work in an explicit development loop with these phases:
1. PLAN - inspect the project (inspect_project, list_dir, read_file) and state a short plan.
2. CODE - make the necessary file changes using write_file.
3. BUILD_TEST - actually run the project's install/build/test commands with run_command.
   Never claim a test passed unless you actually ran it and saw the result.
4. READ_ERROR - if BUILD_TEST failed, read the stdout/stderr carefully.
5. FIX - make targeted file changes to address the error, then go back to BUILD_TEST.

Repeat BUILD_TEST -> READ_ERROR -> FIX until tests pass or you hit the iteration limit.
When you are done (or stuck), clearly state so in plain text with no further tool calls,
summarizing what changed and the final test result.

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
   * Runs the PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX loop for a given
   * task description, letting the LLM decide which tools to call at each step.
   * Stops when the LLM produces a final text-only response (no more tool calls)
   * or the iteration limit is reached.
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
      maxIterations: this.maxIterations,
    });

    let iteration = 0;
    let phase: DevLoopPhase = "PLAN";

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

        phase = inferPhase(fnName, phase);
        this.log.info(`tool call: ${fnName}`, { args, phase });

        const result = await this.tools.call(fnName, args);

        if (fnName === "run_command") {
          phase = result.ok ? "BUILD_TEST" : "READ_ERROR";
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
    default:
      return current;
  }
}
