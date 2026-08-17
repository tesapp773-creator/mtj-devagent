/** Result returned by every tool. Never throws for expected failures (e.g. build errors) -
 * those come back as ok:false with stderr/details so Claude can read and reason about them. */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Definition of a tool exposed to the LLM via function/tool calling. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** A specialist agent that can be registered with the orchestrator (Step 2+). */
export interface AgentDefinition {
  name: string;
  description: string;
  /** Invoked by the orchestrator when it decides to delegate to this agent. */
  run: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export type DevLoopPhase =
  | "PLAN"
  | "CODE"
  | "BUILD_TEST"
  | "READ_ERROR"
  | "FIX"
  | "DONE"
  | "FAILED";

export interface DevLoopStepRecord {
  iteration: number;
  phase: DevLoopPhase;
  summary: string;
  timestamp: string;
}
