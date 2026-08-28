import { describe, it, expect } from "vitest";
import { extractUsage, addUsage, failureSignature } from "../src/orchestrator/devLoop.js";
import type { ToolResult } from "../src/types/index.js";

describe("extractUsage", () => {
  it("pulls token counts out of a completion's usage field", () => {
    const usage = extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    expect(usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });

  it("defaults to zeros when usage is missing (some relays may not report it)", () => {
    const usage = extractUsage({});
    expect(usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it("defaults to zeros for partially missing fields", () => {
    const usage = extractUsage({ usage: { prompt_tokens: 10 } });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 0, totalTokens: 0 });
  });
});

describe("addUsage", () => {
  it("sums two token usage totals field by field", () => {
    const a = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
    const b = { promptTokens: 20, completionTokens: 5, totalTokens: 25 };
    expect(addUsage(a, b)).toEqual({ promptTokens: 120, completionTokens: 55, totalTokens: 175 });
  });

  it("is a no-op when adding zero usage", () => {
    const a = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
    const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    expect(addUsage(a, zero)).toEqual(a);
  });
});

describe("failureSignature (stuck-loop detection)", () => {
  it("produces the same signature for two identical failures", () => {
    const result: ToolResult = {
      ok: false,
      error: "Command exited with error: test failed",
      data: { command: "npm test" },
    };
    expect(failureSignature(result)).toBe(failureSignature({ ...result }));
  });

  it("produces different signatures for different commands", () => {
    const a: ToolResult = { ok: false, error: "boom", data: { command: "npm test" } };
    const b: ToolResult = { ok: false, error: "boom", data: { command: "npm run build" } };
    expect(failureSignature(a)).not.toBe(failureSignature(b));
  });

  it("produces different signatures for meaningfully different errors on the same command", () => {
    const a: ToolResult = { ok: false, error: "TypeError: x is not a function", data: { command: "node app.js" } };
    const b: ToolResult = { ok: false, error: "ReferenceError: y is not defined", data: { command: "node app.js" } };
    expect(failureSignature(a)).not.toBe(failureSignature(b));
  });

  it("handles a missing command gracefully", () => {
    const result: ToolResult = { ok: false, error: "some tool error" };
    expect(() => failureSignature(result)).not.toThrow();
    expect(failureSignature(result)).toContain("some tool error");
  });
});
