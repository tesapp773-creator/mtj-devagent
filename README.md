# MTJ DevAgent

A Claude-based AI software-development agent. Claude acts as the lead developer,
coordinating a tool layer (file ops, command execution, project inspection, deployment)
through an explicit development loop, rather than trying to do everything in one shot.

This is a separate project from the MTJ AI personal assistant.

## Status: Core Orchestrator + Deployment

The orchestrator core is built, with a minimal deployment capability (Cloudflare Pages)
layered on top. Specialist agents (QA, browser-testing, security) are not yet built —
those are next.

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
    registry.ts     Central registry, exposes tools to the LLM as function-call specs
  agents/
    registry.ts     Registry for future specialist agents (empty by design, for now)
  llm/
    client.ts       Thin OpenAI-compatible client pointed at the Claude relay endpoint
  orchestrator/
    devLoop.ts      PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX -> (DEPLOY) loop
  index.ts          Wires everything together; entry point
tests/              Vitest unit tests for config, workspace sandbox, and all tools
.github/workflows/ci.yml   Cloud CI: npm install, build, and test on every push
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
- **Agents are a registry, not special-cased code.** `AgentRegistry` exists now so a future
  QA agent (and later browser-test/security agents) can register and be delegated to
  without changing orchestrator internals. It's intentionally empty for now.
- **No secrets in source.** All LLM and Cloudflare configuration comes from environment
  variables (`LLM_API_KEY`, `CLOUDFLARE_API_TOKEN`, ...), validated at startup with zod so a
  missing required key fails loudly instead of silently running broken. `.env` is
  gitignored; `.env.example` documents the required variables with no real values.
- **Deployment is opt-in and gated.** `deploy_project` is only registered as a tool at all
  when both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured — otherwise it
  doesn't exist for the LLM to call. And even when available, the dev loop enforces in code
  (not just via the system prompt) that `deploy_project` cannot be called until a
  `run_command` has actually succeeded earlier in the same run — the loop cannot be talked
  into deploying untested code.
- **Cloud-first execution.** Development happens from a phone with no local machine, so
  the actual build/test loop is designed to run in cloud environments: this sandbox for
  agent-driven work, and GitHub Actions CI (`.github/workflows/ci.yml`) as the
  independent, verifiable source of truth for whether the project actually builds and
  passes tests.

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
| `AGENT_WORKSPACE_ROOT` | no | `./workspace` | Sandbox root the agent may read/write/execute within |
| `AGENT_MAX_LOOP_ITERATIONS` | no | `8` | Safety cap on the dev loop |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `CLOUDFLARE_API_TOKEN` | no | — | Enables `deploy_project` (only if both CF vars are set) |
| `CLOUDFLARE_ACCOUNT_ID` | no | — | Enables `deploy_project` (only if both CF vars are set) |

## Running the agent

```bash
npm run dev "Inspect the current project and summarize what you find"
```

## What's implemented

- [x] Config layer with env-var validation, no hardcoded secrets
- [x] Structured logger
- [x] Tool layer: file ops, command execution, project inspection — sandboxed to a workspace root
- [x] Deployment tool: `deploy_project` publishes to Cloudflare Pages via Wrangler, opt-in via config
- [x] Tool registry exposing tools as OpenAI-compatible function specs
- [x] Empty agent registry, ready for future specialist agents
- [x] LLM client wrapping the OpenAI-compatible Claude relay endpoint
- [x] Core dev loop: PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX -> (DEPLOY)
- [x] In-code guardrail: deployment cannot happen without a successful build/test first in the same run
- [x] Unit tests for config, workspace sandboxing, every tool, and deploy-tool registration gating
- [x] Cloud CI (GitHub Actions) running real install/build/test on every push

## Explicitly not done yet

- Specialist agents (QA, browser-testing, security) — not built yet
- Wiring `AgentRegistry` into the orchestrator's delegation logic (registry exists, but the
  dev loop doesn't call out to agents yet since there are none registered)
- End-to-end test of the live dev loop against the real `api.llmsrelay.com` endpoint, and of
  an actual `deploy_project` call against real Cloudflare credentials (needs real secrets
  supplied via GitHub Actions or another environment with network access — not available in
  the sandbox used to build this)
- No `workflow_dispatch` trigger yet for running the agent from the GitHub mobile app
