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
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  AGENT_WORKSPACE_ROOT: z.string().min(1).default("./workspace"),
  // History: 8 -> 16 -> 24. A real E2E run at 16 got all the way through a genuine
  // detect -> diagnose -> fix -> retest cycle (including recovering from an unrelated
  // test-harness crash) and was only 1-2 tool calls short of DEPLOY/DONE when it hit
  // the cap. Raised to 24 to give real headroom instead of inching up again.
  AGENT_MAX_LOOP_ITERATIONS: z.coerce.number().int().positive().default(24),

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
