import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { LlmClient, type ChatMessage } from "../llm/client.js";
import type { AgentDefinition, ToolDefinition, ToolResult } from "../types/index.js";
import type { Workspace } from "../tools/workspace.js";
import { createFileTools } from "../tools/fileTools.js";
import { createCommandTools } from "../tools/commandTools.js";
import { createInspectTools } from "../tools/inspectTools.js";
import { createSearchTools } from "../tools/searchTools.js";
import { createQaWriteTool } from "../tools/qaTools.js";

const QA_SYSTEM_PROMPT = `You are an INDEPENDENT QA reviewer inside MTJ DevAgent. You did NOT
write the code you are about to review - a different developer did, and this is a genuinely
separate conversation with no memory of building it. Your job is to try to find what is wrong,
not to confirm what is right.

You have NO ability to modify the application's own source files - write_file and delete_file
are not available to you. You can only:
- read_file, list_dir, inspect_project: inspect the real code that was actually written.
- search_code: search for a plain-text pattern across every file (like grep) - use this to
  quickly find where something is defined or used instead of reading many files one by one,
  especially in a large or unfamiliar existing project.
- run_command: execute existing tests, install tools, run scripts.
- write_qa_file: create your OWN scratch/verification files. These always land in a qa/
  folder no matter what path you request - you cannot write anywhere else, and specifically
  cannot touch the application's own files.

Your task:
1. Read the original task description given below.
2. Inspect the actual code that was written - read the real files yourself (use search_code
   first if the project is large, to find the relevant files quickly), don't assume anything
   the builder's own summary claimed is true.
3. FIGURE OUT WHETHER THIS WAS A FRESH BUILD OR AN EDIT TO AN EXISTING PROJECT. If the
   project clearly has substantial pre-existing structure/history unrelated to the current
   task, this is an existing-project edit that will be submitted as a pull request for a
   human to review, not deployed automatically. In that case, ALSO check scope: did the
   builder change only what the task actually required, or did it touch, rewrite, or delete
   things beyond the obvious minimal scope? Scope creep on someone else's real project is a
   real finding, not a nitpick - call it out explicitly in your issues list even if the
   extra changes are not technically broken, so the human reviewer is not surprised by an
   unrequested change buried in the diff.
4. If a live URL is given, actually visit and exercise it yourself using a FRESH script you
   write yourself (via write_qa_file + run_command, e.g. with Playwright if it's already
   installed, or install it if not). Do not simply trust or re-run whatever verification
   script the builder already wrote - write your own, from your own reading of the task, so
   you are checking independently rather than just re-confirming their work. No live URL
   being given is normal and expected for an existing-project pull-request review where
   deployment was intentionally left off - just review the code itself in that case.
5. SECURITY REVIEW IS MANDATORY, not optional, and carries the same weight as a functional
   bug - a real security finding is grounds for VERDICT: FAIL on its own, even if everything
   else works perfectly. Actively look for: hardcoded secrets or API keys in source; unsafe
   use of innerHTML/eval or other DOM sinks with unsanitized input (XSS); injection risks in
   any server-side or command-construction code; insecure randomness used for anything
   security-sensitive (tokens, IDs); missing input validation that could let malformed or
   oversized data through; anything a real attacker could exploit. search_code is useful
   here too - e.g. searching for "innerHTML", "eval(", or common secret-like patterns across
   the whole project in one pass. If Semgrep is already installed in the workspace, you may
   run it yourself for a second opinion (run_command "semgrep" ["--config", "p/security-audit",
   "--config", "p/owasp-top-ten", "--config", "p/secrets", "--error"]) - but do not rely on
   it alone; also read the actual code with an adversarial eye, since automated scanners miss
   things a careful reviewer catches.
6. Also actively try to find other real problems: malformed input, edge cases, things the
   task asked for that are missing or broken, accessibility issues, anything that would
   embarrass a real user.
7. You have a LIMITED number of tool-call rounds. Budget them deliberately: a couple of
   focused checks that reach a clear verdict are more useful than many checks that run out
   of room before concluding. If you receive a warning that you are running low on budget,
   stop opening new lines of investigation immediately and move straight to a verdict based
   on what you have already found.
8. When finished, respond in plain text with NO further tool calls, in exactly this format:

VERDICT: PASS
or
VERDICT: FAIL
ISSUES:
- (one bullet per concrete problem found, or "none" if PASS)

Be honest and specific. A PASS verdict when a real problem exists - functional, security, OR
unrequested scope creep on an existing project - is worse than a FAIL that turns out to be
overly cautious - only give PASS if you genuinely tried to find a problem, including a
security-specific pass, and could not. Running out of budget without giving ANY verdict is
the worst outcome of all - it is treated as an automatic FAIL and denies the builder your
specific findings, so always leave yourself enough room to state a verdict even if your
investigation is not fully exhaustive.`;

export interface QaReviewInput {
  task: string;
  deployedUrl?: string;
}

export interface QaReviewOutput {
  report: string;
}

/** Number of remaining tool-call rounds at which the QA agent gets a one-time
 * warning to stop investigating and move to a verdict. */
const WRAP_UP_WARNING_THRESHOLD = 3;

/** Max number of past tool failures kept for the fallback report if no verdict is reached. */
const MAX_OBSERVED_FAILURES = 5;

/** Builds a concise, specific summary of a failed tool call, including a tail
 * snippet of any captured stdout/stderr - this is what actually contains the
 * real pass/fail detail from a test script (e.g. "\u2717 Task can be deleted"). */
function summarizeToolFailure(fnName: string, args: Record<string, unknown>, result: ToolResult): string {
  const data = result.data as
    | { command?: string; exitCode?: number; stdout?: string; stderr?: string }
    | undefined;
  const parts: string[] = [`Tool: ${fnName}`];
  if (data?.command) {
    parts.push(`Command: ${data.command}`);
  } else if (args && Object.keys(args).length > 0) {
    parts.push(`Args: ${JSON.stringify(args).slice(0, 200)}`);
  }
  if (typeof data?.exitCode === "number") parts.push(`Exit code: ${data.exitCode}`);
  if (result.error) parts.push(`Error: ${result.error}`);
  const outputSnippet = (data?.stdout || data?.stderr || "").trim();
  if (outputSnippet) {
    parts.push(`Output (tail):\n${outputSnippet.slice(-800)}`);
  }
  return parts.join("\n");
}

/**
 * Builds the independent QA reviewer as an AgentDefinition: a genuinely separate LLM
 * conversation (its own fresh message history, own system prompt, own small tool set)
 * that reviews the SAME workspace the builder just worked in, but cannot modify the
 * application's own files - only inspect them, search them, run commands, and write its
 * own scratch files under qa/. Runs its own bounded loop (QA_MAX_ITERATIONS), separate
 * from the main dev loop's iteration budget.
 *
 * Security review AND scope-creep review (for existing-project pull-request runs) are
 * both mandatory parts of this agent's checklist (see QA_SYSTEM_PROMPT): a genuine
 * finding of either kind results in the same PASS/FAIL verdict already hard-gated in
 * devLoop.ts, so both get real, code-enforced teeth without needing a separate new
 * gating mechanism.
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
    ...createSearchTools(workspace, qaLog.child("tool")),
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
      "application files - reviews the builder's finished work, including a mandatory " +
      "security pass and a scope-creep check for existing-project edits, actively tries " +
      "to find real problems, and returns a PASS/FAIL verdict with specifics.",
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

      // Real problems found during investigation, kept so that even if the QA
      // agent runs out of budget before formally concluding, the builder still
      // receives specific, actionable findings instead of a vague "no verdict"
      // message - this was a real observed gap: a review that found genuine
      // failures in two separate test suites still produced a generic fallback
      // report because those specifics weren't carried forward.
      const observedFailures: string[] = [];
      let warnedAboutBudget = false;

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        const remaining = maxIterations - iteration + 1;
        if (remaining <= WRAP_UP_WARNING_THRESHOLD && !warnedAboutBudget) {
          warnedAboutBudget = true;
          qaLog.info("QA agent nearing its iteration budget - sending wrap-up reminder", { remaining });
          messages.push({
            role: "user",
            content:
              `You have only ${remaining} tool-call rounds left before this review times out. ` +
              `Stop opening new lines of investigation now. If you have already found a real ` +
              `problem, respond with VERDICT: FAIL and the specific issues you found. If you ` +
              `have not found anything concrete after genuine effort, respond with VERDICT: PASS. ` +
              `Do not let this run out without a verdict.`,
          });
        }

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

          // Capture real command failures (e.g. a genuinely failing verification
          // script, or a real Semgrep finding via --error) as candidate findings,
          // in case no formal verdict is reached.
          if (!result.ok && fnName === "run_command") {
            observedFailures.push(summarizeToolFailure(fnName, args, result));
            if (observedFailures.length > MAX_OBSERVED_FAILURES) observedFailures.shift();
          }

          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }

      qaLog.warn("QA review hit its iteration budget without reaching a verdict - treating as FAIL", {
        observedFailureCount: observedFailures.length,
      });

      const fallbackReport =
        observedFailures.length > 0
          ? `QA review did not reach a formal verdict within its iteration budget, but found ` +
            `real problems during investigation before running out of room. Treated as FAIL ` +
            `out of caution. Specific findings observed during review:\n\n` +
            observedFailures.map((f, i) => `--- Finding ${i + 1} ---\n${f}`).join("\n\n")
          : `QA review did not reach a verdict within its iteration budget, and no specific ` +
            `command failures were observed during its investigation - treated as FAIL out of ` +
            `caution since a review that could not conclude cannot be trusted as a genuine pass.`;

      const output: QaReviewOutput = { report: fallbackReport };
      return { ok: false, data: output };
    },
  };
}
