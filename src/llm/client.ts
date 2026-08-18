import OpenAI from "openai";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;
export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

const RETRY_BACKOFF_MS = [3_000, 10_000, 20_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts an HTTP status code and message from an unknown thrown error
 * without depending on instanceof narrowing against the SDK's error class -
 * duck-typing here is deliberate so this works regardless of exact SDK
 * error-class shape across versions.
 */
function describeError(err: unknown): { status?: number; message: string } {
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return { status, message };
}

/**
 * Whether an error is worth retrying. Auth errors (401/403) and bad-request
 * errors (400/404) will never succeed on retry - only network failures
 * (no status at all), timeouts, and server-side errors (429/5xx) are retryable.
 */
function isRetryable(status: number | undefined): boolean {
  if (status === undefined) return true; // connection-level failure, no HTTP response at all
  return status === 429 || status >= 500;
}

/**
 * Thin wrapper around the OpenAI-compatible chat completions API, pointed
 * at the configured Claude relay (LLM_BASE_URL / LLM_MODEL / LLM_API_KEY).
 * The API key is read from config (which reads env vars) and is never
 * logged or hardcoded.
 *
 * Retry behavior: the underlying OpenAI SDK's own silent retries are
 * disabled (maxRetries: 0) so that every retry attempt made by THIS class
 * is visible in the logs - a real incident (repeated 502s from the relay)
 * showed that silent, un-logged waiting made a slow relay indistinguishable
 * from a genuinely stuck run for several minutes. Retries here are explicit,
 * bounded, logged at each step, and skipped entirely for errors that retrying
 * cannot fix (e.g. an invalid API key).
 */
export class LlmClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly log: Logger;

  constructor(config: AppConfig, log: Logger) {
    this.client = new OpenAI({
      apiKey: config.LLM_API_KEY,
      baseURL: config.LLM_BASE_URL,
      timeout: config.LLM_TIMEOUT_MS,
      maxRetries: 0,
    });
    this.model = config.LLM_MODEL;
    this.maxTokens = config.LLM_MAX_TOKENS;
    this.log = log;
  }

  async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatCompletion> {
    this.log.debug("llm.chat request", { model: this.model, messageCount: messages.length });

    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRY_BACKOFF_MS.length + 1; attempt++) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: this.maxTokens,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        });
        const choice = completion.choices[0];
        this.log.debug("llm.chat response", {
          attempt,
          finishReason: choice?.finish_reason,
          toolCalls: choice?.message?.tool_calls?.length ?? 0,
        });
        return completion;
      } catch (err) {
        lastError = err;
        const { status, message } = describeError(err);
        const retryable = isRetryable(status);

        if (!retryable || attempt > RETRY_BACKOFF_MS.length) {
          this.log.warn("llm.chat failed - not retrying", {
            attempt,
            status,
            message,
            reason: retryable ? "out of retries" : "non-retryable error",
          });
          throw err;
        }

        const delay = RETRY_BACKOFF_MS[attempt - 1];
        this.log.warn("llm.chat failed - will retry", {
          attempt,
          status,
          message,
          retryInMs: delay,
        });
        await sleep(delay);
      }
    }

    // Unreachable, but keeps TypeScript happy about a guaranteed return/throw.
    throw lastError;
  }

  /**
   * Fast, single-attempt, no-retry check that the relay is reachable and the
   * API key is accepted, using a minimal request. Meant to be called once at
   * the very start of a run so a dead/misconfigured relay fails in seconds
   * instead of burning the full iteration budget (and several real minutes)
   * only to fail on the first real call anyway. Never throws - always returns
   * a result the caller can act on.
   */
  async quickHealthCheck(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      });
      this.log.info("llm.quickHealthCheck: relay reachable");
      return { ok: true };
    } catch (err) {
      const { status, message } = describeError(err);
      this.log.warn("llm.quickHealthCheck: relay NOT reachable", { status, message });
      return { ok: false, message: `${status ?? "no status"}: ${message}` };
    }
  }
}
