import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { LlmClient, type ChatMessage } from "../llm/client.js";
import type { AgentDefinition, ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "../tools/workspace.js";
import { createFileTools } from "../tools/fileTools.js";
import { createCommandTools } from "../tools/commandTools.js";
import { createInspectTools } from "../tools/inspectTools.js";
import { createQaWriteTool } from "../tools/qaTools.js";

const QA_SYSTEM_PROMPT = `You are an INDEPENDENT QA reviewer inside MTJ DevAgent. You did NOT
write the code you are about to review - a different developer did, and this is a genuinely
separate conversation with no memory of building it. Your job is to try to find what is wrong,
not to confirm what is right.

You have NO ability to modify the application's own source files - write_file and delete_file
are not available to you. You can only:
- read_file, list_dir, inspect_project: inspect the real code that was actually written.
- run_command: execute existing tests, install tools, run scripts.
- write_qa_file: create your OWN scratch/verification files. These always land in a qa/
  folder no matter what path you request - you cannot write anywhere else, and specifically
  cannot touch the application's own files.

Your task:
1. Read the original task description given below.
2. Inspect the actual code that was written - read the real files yourself, don't assume
   anything the builder's own summary claimed is true.
3. If a live URL is given, actually visit and exercise it yourself using a FRESH script you
   write yourself (via write_qa_file + run_command, e.g. with Playwright if it's already
   installed, or install it if not). Do not simply trust or re-run whatever verification
   script the builder already wrote - write your own, from your own reading of the task, so
   you are checking independently rather than just re-confirming their work.
4. Actively try to find real problems: malformed input, edge cases, things the task asked
   for that are missing or broken, accessibility issues, anything that would embarrass a
   real user or represent a genuine security concern.
5. When finished, respond in plain text with NO further tool calls, in exactly this format:

VERDICT: PASS
or
VERDICT: FAIL
ISSUES:
- (one bullet per concrete problem found, or "none" if PASS)

Be honest and specific. A PASS verdict when a real problem exists is worse than a FAIL that
turns out to be overly cautious - only give PASS if you genuinely tried to find a problem and
could not.`;

export interface QaReviewInput {
  task: string;
  deployedUrl?: string;
}

export interface QaReviewOutput {
  report: string;
}

/**
 * Builds the independent QA reviewer as an AgentDefinition: a genuinely separate LLM
 * conversation (its own fresh message history, own system prompt, own small tool set)
 * that reviews the SAME workspace the builder just worked in, but cannot modify the
 * application's own files - only inspect them, run commands, and write its own scratch
 * files under qa/. Runs its own bounded loop (QA_MAX_ITERATIONS), separate from the
 * main dev loop's iteration budget.
 */
export function createQaAgent(config: AppConfig, log: Logger, workspace: Workspace): AgentDefinition {
  const qaLog = log.child("qa-agent");
  const llm = new LlmClient(config, qaLog.child("llm"));

  const tools: ToolDefinition[] = [
    ...createFileTools(workspace, qaLog.child("tool")).filter(
      (t) => t.name === "read_file" || t.name === "list_dir"
    ),
    ...createCommandTools(workspace, qaLog.child("tool")),
    ...createInspectTools(workspace, qaLog.child("tool")),
    createQaWriteTool(workspace, qaLog.child("tool")),
  ];

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolSpecs = tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const maxIterations = config.QA_MAX_ITERATIONS;

  return {
    name: "qa-reviewer",
    description:
      "Independent QA agent with no memory of writing the code and no ability to modify " +
      "application files - reviews the builder's finished work, actively tries to find " +
      "real problems, and returns a PASS/FAIL verdict with specifics.",
    run: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const typedInput = input as unknown as QaReviewInput;
      const { task, deployedUrl } = typedInput;

      const userPrompt =
        `Original task given to the builder:\n${task}\n\n` +
        (deployedUrl
          ? `The builder deployed this live at: ${deployedUrl}\nGo check it yourself.`
          : `No live URL was provided this time - review the code only.`);

      const messages: ChatMessage[] = [
        { role: "system", content: QA_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ];

      qaLog.info("QA review starting", { deployedUrl, maxIterations });

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        qaLog.info(`QA iteration ${iteration}/${maxIterations}`);
        const completion = await llm.chat(messages, toolSpecs);
        const choice = completion.choices[0];
        const message = choice.message;
        messages.push(message);

        const toolCalls = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          const text = typeof message.content === "string" ? message.content : "";
          const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);
          const passed = verdictMatch ? verdictMatch[1].toUpperCase() === "PASS" : false;
          qaLog.info("QA review finished", { passed });
          const output: QaReviewOutput = { report: text || "(QA agent gave no report text)" };
          return { ok: passed, data: output };
        }

        for (const call of toolCalls) {
          const fnName = call.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch (err) {
            qaLog.warn("failed to parse QA tool call arguments", { fnName, raw: call.function.arguments });
          }
          const tool = toolMap.get(fnName);
          const result: ToolResult = tool
            ? await tool.execute(args)
            : { ok: false, error: `QA agent tried to use an unavailable tool: ${fnName}` };
          qaLog.info(`QA tool call: ${fnName}`, { args, ok: result.ok });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }

      qaLog.warn("QA review hit its iteration budget without reaching a verdict - treating as FAIL");
      const output: QaReviewOutput = {
        report: "QA review did not reach a verdict within its iteration budget - treated as FAIL out of caution.",
      };
      return { ok: false, data: output };
    },
  };
}
