import "dotenv/config";
import { z } from "zod";

/**
 * All runtime configuration comes from environment variables.
 * No secrets are ever hardcoded here. If a required variable is
 * missing, the process fails fast with a clear error instead of
 * silently running with an undefined API key.
 */
const ConfigSchema = z.object({
  LLM_BASE_URL: z.string().url().default("https://api.llmsrelay.com/v1"),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-4.6"),
  LLM_API_KEY: z.string().min(1, "LLM_API_KEY is required and must be set as an environment variable"),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  // Per-attempt timeout. Lowered from 120s to 60s: LlmClient now retries up to
  // 3 times on transient failures (see src/llm/client.ts), so the OLD 120s value
  // could have meant up to ~6 minutes of total waiting in the worst case - which
  // is the exact silent-hang behavior that caused real confusion in a live run.
  // 60s per attempt keeps the worst-case total bounded to a few minutes.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  AGENT_WORKSPACE_ROOT: z.string().min(1).default("./workspace"),
  // History: 8 -> 16 -> 24 -> 40. A real successful E2E run (build+bug+fix+deploy,
  // no live verification yet) used 21 of 24 iterations on its own. The dev loop now
  // also requires a live-verification step after every deploy (Playwright: install,
  // write a browser script, run it, and loop back through FIX if it fails) before it's
  // allowed to finish - realistically 5-10+ more tool calls on top of the existing
  // cycle. Raised proactively to 40 to give real headroom for that additional phase,
  // rather than waiting to hit the cap again before raising it.
  AGENT_MAX_LOOP_ITERATIONS: z.coerce.number().int().positive().default(40),

  // Separate, smaller iteration budget for the independent QA agent's own review
  // loop (src/agents/qaAgent.ts). Distinct from AGENT_MAX_LOOP_ITERATIONS since the
  // QA agent's job is narrower than the builder's full PLAN->DEPLOY cycle.
  // History: 12 -> 24. A real QA review used all 12 of its original budget writing
  // and running FOUR separate real Playwright suites (functional, edge-case,
  // accessibility, and a targeted bug investigation) - genuinely thorough, real
  // adversarial testing - and was still mid-investigation, writing a fifth suite,
  // when it ran out, never reaching a formal verdict. Raised to give it real room
  // to actually conclude after this level of legitimate thoroughness.
  QA_MAX_ITERATIONS: z.coerce.number().int().positive().default(24),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Optional: only required if the deploy_project tool is used. Deployment
  // capability is disabled (tool not registered) when either is missing -
  // the agent still runs fine without them.
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cachedConfig: AppConfig | undefined;

/**
 * Loads and validates configuration from process.env.
 * Throws a descriptive error if required values are missing/invalid.
 * Cached after first successful load.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cachedConfig) return cachedConfig;

  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i: z.ZodIssue) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing configuration.\n${issues}\n\n` +
        `Copy .env.example to .env and fill in real values (never commit .env).`
    );
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/** For tests only: clears the cached config so it can be reloaded. */
export function _resetConfigCache(): void {
  cachedConfig = undefined;
}
