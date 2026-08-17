import type { AgentDefinition } from "../types/index.js";

/**
 * Registry for specialist agents (QA, browser-testing, security, deployment, etc).
 *
 * Step 1 intentionally registers NO specialist agents - the orchestrator handles
 * everything itself via the tool layer. This registry exists so Step 2+ can add
 * agents (e.g. a QA agent) without any change to orchestrator core logic: the
 * orchestrator will be able to list registered agents and delegate to them the
 * same way it calls tools, once that wiring is added in a later step.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent "${agent.name}" is already registered`);
    }
    this.agents.set(agent.name, agent);
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}
