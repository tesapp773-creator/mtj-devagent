import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { LlmClient, type ChatMessage } from "../llm/client.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentRegistry } from "../agents/registry.js";
import type { DevLoopPhase, DevLoopStepRecord, ToolResult } from "../types/index.js";

const SYSTEM_PROMPT = `You are the lead software developer inside MTJ DevAgent, an autonomous
coding agent. You do not write final answers in prose - you accomplish the task by calling
the tools available to you (read_file, write_file, list_dir, delete_file, run_command,
inspect_project, and deploy_project if it appears in your tool list).

You work in an explicit development loop with these phases:
1. PLAN - inspect the project (inspect_project, list_dir, read_file) and state a short plan.
2. CODE - make the necessary file changes using write_file.
3. BUILD_TEST - actually run the project's install/build/test commands with run_command.
   Never claim a test passed unless you actually ran it and saw the result. If the project
   is JavaScript/TypeScript, it is worth also running a linter (e.g. run_command "npm"
   ["install", "--save-dev", "eslint"] then "npx" ["eslint", "."] with a minimal default
   config) to catch real issues like unused variables or unsafe patterns. Lint findings
   are informative and worth fixing where reasonable, but a lint-only issue should not by
   itself block you from deploying the way a genuine failing test does.
3b. SECURITY SCAN (required, treat with the same seriousness as a failing test) - run
   Semgrep with a comprehensive, real security ruleset before you consider your work ready
   to deploy: run_command "python3" ["-m", "pip", "install", "--quiet", "semgrep"] (or
   "pip3" if that fails), then run_command "semgrep" ["--config", "p/security-audit",
   "--config", "p/owasp-top-ten", "--config", "p/secrets", "--error"] (the --error flag
   makes it exit non-zero on real findings, the same way a failing test would). Read any
   genuine findings (hardcoded secrets, injection risks, unsafe DOM/HTML sinks like
   innerHTML with unsanitized input, insecure randomness, etc.) and fix them before moving
   on - do not deploy code with a known, real security finding just because the rest of the
   app works. Use your judgment on what is a real, actionable issue versus rule noise, but
   default to fixing rather than dismissing.
4. READ_ERROR - if BUILD_TEST failed, read the stdout/stderr carefully.
5. FIX - make targeted file changes to address the error, then go back to BUILD_TEST.
6. DEPLOY (only if deploy_project is available to you, and only after step 3 has actually
   succeeded) - publish the built output and get back the live URL.
7. VERIFY (required whenever you deployed) - actually check that the LIVE deployed site
   works, using Playwright, a real browser automation tool - not just re-checking your
   local unit tests. Concretely:
   a. Install it in the workspace if not already present: run_command "npm" ["install",
      "--save-dev", "playwright"], then run_command "npx" ["playwright", "install",
      "chromium", "--with-deps"].
   b. Write a short Node script (write_file) that launches Chromium, navigates to the
      REAL live URL deploy_project returned, exercises the core functionality described
      in the task (e.g. add an item, click a button, check the result actually appears
      in the page), and exits non-zero if anything fails or an expected element/text is
      missing.
   c. Run it with run_command and read the real result.
   d. IMPORTANT: a fresh deployment can occasionally take a short moment for the hosting
      provider's network to finish propagating a working TLS/SSL certificate for the new
      URL. If your very first attempt to reach the live URL fails with a connection,
      SSL, or TLS-related error (not a real application bug), do NOT immediately assume
      the deployment is broken or switch to an alternative like serving the files
      locally - that would defeat the purpose of verifying the REAL live deployment.
      Instead, wait briefly and retry the same real URL two or three times first. Only
      fall back to an alternative verification strategy if the real URL still fails
      after those retries.
   e. If it fails for a real reason (not a transient connection issue), treat this
      exactly like a failed BUILD_TEST: go back through READ_ERROR -> FIX -> re-deploy
      -> verify again.
8. QA REVIEW (automatic, after VERIFY passes) - an INDEPENDENT QA agent, with no memory
   of you writing this code, will automatically inspect your work, including its own
   security review, and may run its own checks against the live site. You will receive
   its verdict as a message. If it reports problems - functional OR security - treat them
   exactly like a failed BUILD_TEST: read them carefully, fix the real issues in your
   code, redeploy, re-verify, and the QA agent will review again. You cannot skip or argue
   past a QA failure - only a genuine fix resolves it.

You may NOT report DONE after a deploy without a passing Playwright check against the
real live URL in this same run, AND a passing independent QA review - a deploy that has
not been verified live and QA-reviewed is not finished, no matter how confident you are
that the code is correct.

Repeat BUILD_TEST -> READ_ERROR -> FIX until tests pass or you hit the iteration limit.
Never call deploy_project unless the most recent BUILD_TEST for this task actually
succeeded - deploying untested or broken code is not acceptable under any circumstance,
even if the user seems to be in a hurry.

CRITICAL RULE ABOUT TEST HARNESSES OR VERIFICATION SCRIPTS YOU WRITE YOURSELF: if the
project has no existing test framework, prefer a standard, well-known one (e.g. a real
assertion library) over a bespoke hand-written runner. Any script you write to check
pass/fail - unit tests AND the Playwright live-verification script - MUST exit with a
non-zero code if ANY check fails or throws, and MUST NOT use a fixed timer/timeout to
force a zero exit code regardless of what happened inside. A harness that reports success
without genuinely checking every outcome is worse than no check at all, because it hides
real bugs - this is a real failure mode that has been observed before and must be avoided.
Before treating any BUILD_TEST or VERIFY run as a genuine pass, make sure the exit code
you observed actually reflects whether every individual check passed, not just that the
process didn't crash.

When you are done (or stuck), clearly state so in plain text with no further tool calls,
summarizing what changed, the final test result, the security scan result, the live URL,
the live-verification result, and the independent QA review's verdict.

Be conservative: only touch files relevant to the current task. Do not invent passing
results - only report what the tool output actually showed.`;

export interface DevLoopResult {
  finalPhase: DevLoopPhase;
  iterations: number;
  history: DevLoopStepRecord[];
  transcript: ChatMessage[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Short, deterministic pause after a successful deploy, before the next LLM call.
// Real evidence: a builder's live-verification attempt failed with a TLS/SSL
// handshake error immediately after a fresh Cloudflare Pages deploy, forcing an
// awkward local-server workaround - yet an independent QA review pointed at the
// exact same URL a few minutes later worked immediately. This strongly suggests a
// brief CDN propagation delay, not a real defect. This pause is a cheap, code-level
// mitigation (not a guarantee) that gives that propagation window a moment to close
// before verification is attempted, on top of the prompt-level retry guidance above.
const POST_DEPLOY_SETTLE_MS = 10_000;

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
   * Runs the PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX -> DEPLOY -> VERIFY -> QA
   * loop for a given task description, letting the LLM decide which tools to call at
   * each step. Stops when the LLM produces a final text-only response (no more tool
   * calls) or the iteration limit is reached.
   *
   * Three guardrails are enforced HERE, in code, not just requested via the system
   * prompt (the prompt alone is not a hard guarantee):
   *   1. deploy_project cannot be called unless a run_command already succeeded.
   *   2. The loop cannot end in DONE if a deploy happened but no run_command has
   *      succeeded since - a live-verification step (Playwright) is required after
   *      every deploy before the run is allowed to finish.
   *   3. The loop cannot end in DONE if a deploy happened but the independent
   *      qa-reviewer agent (if registered) has not returned a genuine PASS since the
   *      most recent deploy. A fresh deploy resets this - a code change after a QA
   *      pass requires a new QA pass before finishing again. This is also where
   *      security review gets real enforcement (see qaAgent.ts) - the QA agent's
   *      mandatory security checklist feeds into the SAME PASS/FAIL verdict that is
   *      already hard-gated here, rather than needing a separate new gate.
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

    // Fail fast if the relay itself is unreachable/misconfigured, rather than
    // burning the full iteration budget (and several real minutes) only to
    // fail on the very first real call anyway. This was a real observed
    // problem: a dead/slow relay made a run look "stuck" for 5+ minutes
    // before finally failing.
    this.log.info("checking LLM relay is reachable before starting");
    const health = await this.llm.quickHealthCheck();
    if (!health.ok) {
      this.log.error("LLM relay is not reachable - aborting before using any iterations", {
        reason: health.message,
      });
      history.push({
        iteration: 0,
        phase: "FAILED",
        summary: `LLM relay unreachable before starting: ${health.message}`,
        timestamp: new Date().toISOString(),
      });
      return { finalPhase: "FAILED", iterations: 0, history, transcript: messages };
    }

    const qaAgent = this.agents.get("qa-reviewer");

    let iteration = 0;
    let phase: DevLoopPhase = "PLAN";
    let hasSuccessfulBuildTest = false;
    let hasDeployed = false;
    let hasVerifiedSinceDeploy = false;
    let hasPassedQaSinceDeploy = false;
    let lastDeployedUrl: string | undefined;

    while (iteration < this.maxIterations) {
      iteration += 1;
      this.log.info(`iteration ${iteration}/${this.maxIterations} - calling LLM`, { phase });

      const completion = await this.llm.chat(messages, this.tools.toOpenAiToolSpecs());
      const choice = completion.choices[0];
      const message = choice.message;
      messages.push(message);

      const toolCalls = message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        // Guardrail 2: a deploy without a subsequent successful verification run
        // is not allowed to count as finished.
        if (hasDeployed && !hasVerifiedSinceDeploy) {
          this.log.warn(
            "blocked finishing - deployed but no successful verification run_command since then"
          );
          history.push({
            iteration,
            phase: "READ_ERROR",
            summary: "Blocked finishing: deployed but not yet verified live with Playwright",
            timestamp: new Date().toISOString(),
          });
          messages.push({
            role: "user",
            content:
              "You deployed but have not run a passing verification command since then. " +
              "You must actually run your Playwright live-verification script against the " +
              "real deployed URL (via run_command) and confirm it passes before you can finish.",
          });
          continue;
        }

        // Guardrail 3: after a successful deploy + verify, an independent QA agent
        // (if one is registered) must also return a genuine PASS before the run can
        // finish. This is a real, separate LLM review - not a rubber stamp - and its
        // checklist now explicitly includes security, so a real security finding
        // blocks completion here exactly like any other QA failure.
        if (hasDeployed && qaAgent && !hasPassedQaSinceDeploy) {
          this.log.info("running independent QA review before allowing DONE", {
            deployedUrl: lastDeployedUrl,
          });
          const qaResult = await qaAgent.run({ task: taskDescription, deployedUrl: lastDeployedUrl });
          const report = (qaResult.data as { report?: string } | undefined)?.report ?? "(no report)";

          history.push({
            iteration,
            phase: qaResult.ok ? "VERIFY" : "READ_ERROR",
            summary: `qa-reviewer -> ${qaResult.ok ? "PASS" : "FAIL"}`,
            timestamp: new Date().toISOString(),
          });

          if (qaResult.ok) {
            hasPassedQaSinceDeploy = true;
            this.log.info("independent QA review PASSED", { report });
            // Fall through below to accept DONE now that both gates have passed.
          } else {
            this.log.warn("blocked finishing - independent QA review found issues", { report });
            messages.push({
              role: "user",
              content:
                `An independent QA reviewer (a separate agent with no memory of writing this ` +
                `code) checked your work, including security, and found issues. You must ` +
                `address these before finishing:\n\n${report}\n\nFix the real problems, ` +
                `redeploy if needed, re-verify, and only then attempt to finish again.`,
            });
            continue;
          }
        }

        // LLM produced a final answer with no further tool calls, and both post-deploy
        // gates (if applicable) have genuinely passed - loop is done.
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
          const blocked: ToolResult = {
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
          phase = result.ok ? (hasDeployed ? "VERIFY" : "BUILD_TEST") : "READ_ERROR";
          if (result.ok) {
            hasSuccessfulBuildTest = true;
            if (hasDeployed) hasVerifiedSinceDeploy = true;
          }
        }

        if (fnName === "deploy_project" && result.ok) {
          hasDeployed = true;
          hasVerifiedSinceDeploy = false; // each new deploy needs its own fresh verification
          hasPassedQaSinceDeploy = false; // ...and its own fresh independent QA review
          const deployData = result.data as { url?: string } | undefined;
          if (deployData?.url) lastDeployedUrl = deployData.url;

          this.log.info(`pausing ${POST_DEPLOY_SETTLE_MS}ms after deploy to let CDN/TLS settle`, {
            url: lastDeployedUrl,
          });
          await sleep(POST_DEPLOY_SETTLE_MS);
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
      return current === "BUILD_TEST" || current === "READ_ERROR" || current === "VERIFY"
        ? "READ_ERROR"
        : "PLAN";
    case "write_file":
    case "delete_file":
      return current === "READ_ERROR" ? "FIX" : "CODE";
    case "run_command":
      return "BUILD_TEST";
    case "deploy_project":
      return "DEPLOY";
    default:
      return current;
  }
}
