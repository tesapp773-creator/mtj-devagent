import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, _resetConfigCache } from "../src/config/index.js";

describe("loadConfig", () => {
  beforeEach(() => {
    _resetConfigCache();
  });

  it("throws a clear error when LLM_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(/LLM_API_KEY/);
  });

  it("loads successfully with required vars set and applies defaults", () => {
    const config = loadConfig({
      LLM_API_KEY: "test-key-not-real",
    } as NodeJS.ProcessEnv);

    expect(config.LLM_API_KEY).toBe("test-key-not-real");
    expect(config.LLM_BASE_URL).toBe("https://api.llmsrelay.com/v1");
    expect(config.LLM_MODEL).toBe("claude-sonnet-4.6");
    expect(config.AGENT_MAX_LOOP_ITERATIONS).toBe(24);
  });

  it("respects overridden values", () => {
    const config = loadConfig({
      LLM_API_KEY: "test-key",
      LLM_MODEL: "claude-custom-model",
      AGENT_MAX_LOOP_ITERATIONS: "3",
    } as NodeJS.ProcessEnv);

    expect(config.LLM_MODEL).toBe("claude-custom-model");
    expect(config.AGENT_MAX_LOOP_ITERATIONS).toBe(3);
  });
});
