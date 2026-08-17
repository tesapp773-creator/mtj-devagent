# MTJ DevAgent

A Claude-based AI software-development agent. Claude acts as the lead developer,
coordinating a tool layer (file ops, command execution, project inspection) through
an explicit development loop, rather than trying to do everything in one shot.

This is a separate project from the MTJ AI personal assistant.

## Status: Step 1 — Core Orchestrator

Step 1 builds the orchestrator core only. It does **not** yet include specialist
agents (QA, browser-testing, security, deployment) or any deployment logic —
those are later steps.

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
    registry.ts     Central registry, exposes tools to the LLM as function-call specs
  agents/
    registry.ts     Registry for future specialist agents (empty in Step 1 by design)
  llm/
    client.ts       Thin OpenAI-compatible client pointed at the Claude relay endpoint
  orchestrator/
    devLoop.ts      PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX loop
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
- **Agents are a registry, not special-cased code.** `AgentRegistry` exists now so Step 2's
  QA agent (and later browser-test/security/deploy agents) can register and be delegated to
  without changing orchestrator internals. It's intentionally empty in Step 1.
- **No secrets in source.** All LLM configuration comes from environment variables
  (`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, ...), validated at startup with zod so a
  missing key fails loudly instead of silently running broken. `.env` is gitignored;
  `.env.example` documents the required variables with no real values.
- **Cloud-first execution.** Development happens from a phone with no local machine, so
  the actual build/test loop is designed to run in cloud environments: this sandbox for
  agent-driven work, and GitHub Actions CI (`.github/workflows/ci.yml`) as the
  independent, verifiable source of truth for whether the project actually builds and
  passes tests.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set LLM_API_KEY to your real key (never commit this file)
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

## Running the agent

```bash
npm run dev "Inspect the current project and summarize what you find"
```

## What's implemented (Step 1)

- [x] Config layer with env-var validation, no hardcoded secrets
- [x] Structured logger
- [x] Tool layer: file ops, command execution, project inspection — sandboxed to a workspace root
- [x] Tool registry exposing tools as OpenAI-compatible function specs
- [x] Empty agent registry, ready for Step 2 specialist agents
- [x] LLM client wrapping the OpenAI-compatible Claude relay endpoint
- [x] Core dev loop: PLAN -> CODE -> BUILD_TEST -> READ_ERROR -> FIX
- [x] Unit tests for config, workspace sandboxing, and every tool
- [x] Cloud CI (GitHub Actions) running real install/build/test on every push

## Explicitly not done yet

- Specialist agents (QA, browser-testing, security, deployment) — Step 2+
- Any deployment logic
- Wiring `AgentRegistry` into the orchestrator's delegation logic (registry exists, but the
  dev loop doesn't call out to agents yet since there are none registered)
- End-to-end test of the live dev loop against the real `api.llmsrelay.com` endpoint (needs
  a real `LLM_API_KEY` supplied as a secret — not available in this environment)
