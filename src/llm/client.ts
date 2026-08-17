import OpenAI from "openai";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;
export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Thin wrapper around the OpenAI-compatible chat completions API, pointed
 * at the configured Claude relay (LLM_BASE_URL / LLM_MODEL / LLM_API_KEY).
 * The API key is read from config (which reads env vars) and is never
 * logged or hardcoded.
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
    });
    this.model = config.LLM_MODEL;
    this.maxTokens = config.LLM_MAX_TOKENS;
    this.log = log;
  }

  async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatCompletion> {
    this.log.debug("llm.chat request", { model: this.model, messageCount: messages.length });
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    });
    const choice = completion.choices[0];
    this.log.debug("llm.chat response", {
      finishReason: choice?.finish_reason,
      toolCalls: choice?.message?.tool_calls?.length ?? 0,
    });
    return completion;
  }
}
