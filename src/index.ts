import { loadConfig } from "./config/index.js";
import { createLogger } from "./logger/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { AgentRegistry } from "./agents/registry.js";
import { DevLoopOrchestrator } from "./orchestrator/devLoop.js";

async function main() {
  const config = loadConfig();
  const log = createLogger("mtj-devagent", config.LOG_LEVEL);

  const deployEnabled = Boolean(config.CLOUDFLARE_API_TOKEN && config.CLOUDFLARE_ACCOUNT_ID);

  log.info("MTJ DevAgent starting", {
    model: config.LLM_MODEL,
    baseUrl: config.LLM_BASE_URL,
    workspaceRoot: config.AGENT_WORKSPACE_ROOT,
    deployEnabled,
  });

  const tools = new ToolRegistry(config.AGENT_WORKSPACE_ROOT, log, {
    cloudflare: {
      apiToken: config.CLOUDFLARE_API_TOKEN,
      accountId: config.CLOUDFLARE_ACCOUNT_ID,
    },
  });
  await tools.workspace.ensureExists();

  // Step 3+ will register specialist agents here, e.g.:
  // agents.register(createQaAgent(...));
  const agents = new AgentRegistry();

  const orchestrator = new DevLoopOrchestrator(config, log, tools, agents);

  const task =
    process.argv.slice(2).join(" ") ||
    "Inspect the current project workspace and report what you find. Make no changes.";

  const result = await orchestrator.run(task);

  log.info("Run complete", {
    finalPhase: result.finalPhase,
    iterations: result.iterations,
  });

  for (const step of result.history) {
    log.info(`  [${step.iteration}] ${step.phase}: ${step.summary}`);
  }

  // CRITICAL: a run that didn't reach DONE is a real failure and must be reported
  // as one via the process exit code - otherwise CI/CD (e.g. GitHub Actions) shows
  // a green checkmark for a run that actually hit the iteration cap or otherwise
  // failed to complete. This was confirmed as a real bug: a FAILED run previously
  // still exited 0 and showed as a passing CI job. Never let that happen silently.
  if (result.finalPhase !== "DONE") {
    log.error("MTJ DevAgent run did NOT complete successfully - exiting with failure code", {
      finalPhase: result.finalPhase,
      iterations: result.iterations,
    });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("MTJ DevAgent fatal error:", err);
  process.exit(1);
});
