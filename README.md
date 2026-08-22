# MTJ DevAgent

A Claude-based AI software-development agent. Claude acts as the lead developer,
coordinating a tool layer (file ops, command execution, project inspection, deployment,
live browser verification) through an explicit development loop, and an independent
second Claude agent reviews the finished work before it's allowed to ship — rather than
trying to do everything in one shot with no check on itself.

This is a separate project from the MTJ AI personal assistant.

## Status: Core Orchestrator + Deployment + Live Verification + Independent QA

The full loop has been proven end-to-end, multiple times, with real evidence (not just
claims): a deliberately introduced bug genuinely caught by a failing test, diagnosed,
fixed in the real production file, retested, deployed to a real live Cloudflare Pages
URL, verified in an actual headless browser via Playwright, and reviewed by a fully
independent QA agent (a separate conversation with no memory of writing the code and no
ability to modify it) before the run is allowed to finish. Controlled entirely from a
phone via a manually-triggered GitHub Actions workflow — no laptop involved anywhere.

Not yet done: a dedicated security-scanning step, and an explicit mode for continuing an
existing real project rather than building a fresh throwaway app (see "Explicitly not
done yet" below).

## Architecture

```
src/
  config/         Env-var driven configuration (zod-validated), no hardcoded secrets
  logger/         Structured logging so every step is visible
  types/          Shared TypeScript types (ToolResult, ToolDefinition, AgentDefinition, ...)
  tools/          The only layer allowed to touch the filesystem / spawn processes
    workspace.ts    Sandbox boundary — every tool call is confined to AGENT_WORKSPACE_ROOT
    fileTools.ts    read_file, write_file, list_dir, delete_file
    commandTools.ts run_command (build/test/inspect via shell, with timeout + output cap)
    inspectTools.ts inspect_project (directory tree + package.json summary)
    deployTools.ts  deploy_project (publishes a built dir to Cloudflare Pages via Wrangler)
    qaTools.ts      write_qa_file — restricted write, exclusively for the QA agent (see below)
    registry.ts     Central registry, exposes tools to the LLM as function-call specs
  agents/
    registry.ts     Registry for specialist agents
    qaAgent.ts       Independent QA reviewer — a genuinely separate LLM conversation
  llm/
    client.ts       OpenAI-compatible client for the Claude relay: retries transient
                     failures (5xx/429/network) with backoff, skips non-retryable ones
                     (e.g. bad key), and can fast-fail-check the relay is reachable
  orchestrator/
    devLoop.ts      PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX -> DEPLOY -> VERIFY
                     -> QA REVIEW -> DONE loop
  index.ts          Wires everything together; entry point
tests/              Vitest unit tests for config, workspace sandbox, every tool, the
                     deploy-tool registration gating, and the QA write-tool's path
                     restriction (including path-traversal and absolute-path attempts)
.github/workflows/
  ci.yml            Cloud CI: npm install, build, and test on every push
  e2e-run.yml       Manually-triggered (workflow_dispatch) real agent run, with a task
                     description input — this is how the agent is actually run from a
                     phone via the GitHub Actions mobile UI
```

### Why this shape

- **Claude is the lead developer, not a hardcoded script.** The dev loop doesn't encode
  "how to fix a bug" — it hands Claude a system prompt describing the loop and a set of
  tools, and lets Claude decide which tool to call at each step, reading real tool output
  (including real errors) and reacting to it.
- **Tools are the only thing that touches the OS.** The orchestrator and LLM client never
  call `fs` or spawn a process directly — only `src/tools/*` does, and every file/command
  operation is sandboxed inside `AGENT_WORKSPACE_ROOT` (see `workspace.ts`). Path traversal
  outside that root is rejected.
- **A second, independent agent reviews the first one's work.** `qaAgent.ts` is a genuinely
  separate LLM conversation — its own system prompt, own message history, no memory of
  writing the code. It has read-only access to the application's files (no `write_file`),
  and its only write capability (`write_qa_file`) hard-enforces, in code, that it can only
  ever write inside a `qa/` folder — verified with tests that include a directory-traversal
  attack attempt. It's told to write its own fresh verification script rather than trust
  the builder's, so it's checking independently, not just re-confirming.
- **No secrets in source.** All LLM and Cloudflare configuration comes from environment
  variables (`LLM_API_KEY`, `CLOUDFLARE_API_TOKEN`, ...), validated at startup with zod so a
  missing required key fails loudly instead of silently running broken. `.env` is
  gitignored; `.env.example` documents the required variables with no real values.
- **Deployment is opt-in and gated, in code, at two points.** `deploy_project` is only
  registered as a tool at all when both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  are configured. Even when available, the loop enforces that it cannot be called until a
  `run_command` has succeeded earlier in the same run, and the run cannot report DONE after
  a deploy without both a passing live Playwright check AND a genuine PASS from the
  independent QA agent — a fresh deploy resets both gates, so a late change can't sneak past
  an earlier pass. None of this is just "asked nicely" in the prompt; it's enforced in code.
- **Honest failure reporting throughout.** A run that doesn't reach DONE exits with a
  non-zero code, so CI shows a genuine failure rather than a false green (this was a real
  bug, found and fixed). Any test harness or verification script the agent writes is
  explicitly required to exit non-zero on a real failure, not fake success with a timer.
- **Resilient to a flaky LLM relay.** The LLM client retries transient errors (timeouts,
  5xx, 429) with backoff and visible logging, skips retrying non-retryable errors (like an
  invalid key), and does a fast reachability check before a run starts so a dead relay fails
  in seconds, not after burning the whole iteration budget.
- **Cloud-first execution.** Development happens from a phone with no local machine. CI
  (`ci.yml`) verifies the orchestrator's own code builds and passes its tests on every push;
  `e2e-run.yml` is how a real task is actually handed to the agent, triggered manually from
  the GitHub Actions mobile UI.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set LLM_API_KEY (required). Cloudflare vars are optional.
npm run build
npm test
```

## Configuration

All configuration is via environment variables — see `.env.example` for the full list:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LLM_API_KEY` | yes | — | Secret key for the Claude relay. Never commit. |
| `LLM_BASE_URL` | no | `https://api.llmsrelay.com/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | no | `claude-sonnet-4.6` | Model identifier |
| `LLM_TIMEOUT_MS` | no | `60000` | Per-attempt timeout; client retries up to 3x on transient errors |
| `AGENT_WORKSPACE_ROOT` | no | `./workspace` | Sandbox root the agent may read/write/execute within |
| `AGENT_MAX_LOOP_ITERATIONS` | no | `40` | Safety cap on the builder's dev loop |
| `QA_MAX_ITERATIONS` | no | `24` | Separate, smaller iteration budget for the independent QA agent's own review |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CLOUDFLARE_API_TOKEN` | no | — | Enables `deploy_project` (only if both CF vars are set) |
| `CLOUDFLARE_ACCOUNT_ID` | no | — | Enables `deploy_project` (only if both CF vars are set) |

## Running the agent

Locally / anywhere with the env vars set:

```bash
npm run dev "Inspect the current project and summarize what you find"
```

From a phone, with no local machine: GitHub → Actions tab → **DevAgent E2E Run** →
**Run workflow** → enter the task description → confirm. The workflow builds, tests, and
runs the full agent with your configured secrets, and prints the whole session log,
including the independent QA agent's verdict.

## What's implemented

- [x] Config layer with env-var validation, no hardcoded secrets
- [x] Structured logger
- [x] Tool layer: file ops, command execution, project inspection — sandboxed to a workspace root
- [x] Deployment tool: `deploy_project` publishes to Cloudflare Pages via Wrangler, opt-in via config, auto-creates the Pages project if it doesn't exist yet
- [x] Live verification: the builder installs Playwright and writes/runs a real browser script against the actual deployed URL, with a code-level pause plus retry guidance to absorb transient CDN/TLS propagation delays right after a fresh deploy
- [x] Independent QA agent: a separate LLM conversation, read-only on app files, its own restricted write tool, writes its own fresh verification script, returns a specific PASS/FAIL verdict
- [x] Soft (non-blocking) ESLint guidance during BUILD_TEST for JS/TS projects
- [x] Tool registry exposing tools as OpenAI-compatible function specs
- [x] LLM client wrapping the OpenAI-compatible Claude relay endpoint, with retry/backoff and a fast health check
- [x] Core dev loop: PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX -> DEPLOY -> VERIFY -> QA REVIEW -> DONE
- [x] In-code guardrails: no deploy without a prior successful build/test; no DONE after a deploy without both a passing live verification and a genuine independent QA pass; a fresh deploy resets both gates
- [x] Honest process exit codes — a run that doesn't reach DONE fails CI for real, no false green
- [x] Unit tests for config, workspace sandboxing, every tool, deploy-tool registration gating, and the QA write-tool's path restriction (including a directory-traversal attack scenario)
- [x] Cloud CI (GitHub Actions) running real install/build/test on every push
- [x] Manually-triggered real E2E workflow (`e2e-run.yml`), runnable entirely from the GitHub Actions phone UI
- [x] Multiple full, independently-verified successful real end-to-end runs (not just claimed) — real bug, real catch, real fix, real deploy, real independent QA pass

## Explicitly not done yet

- Dedicated security scanning (e.g. Semgrep) — deferred deliberately, needs its own planning conversation
- An explicit "continue my existing project" mode — every successful run so far has built a fresh app in an empty workspace; handing the agent a real, existing project is genuinely untested territory
- A `package-lock.json` isn't committed, so dependency versions aren't pinned/reproducible
- The QA agent shares the builder's LLM relay, key, and model — no separate (e.g. cheaper) model has been wired in for QA specifically; considered and deliberately not done, to protect review quality
