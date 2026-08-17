type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEvent {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

/**
 * Simple structured console logger. Every dev-loop step, tool call,
 * and LLM interaction should log through this so the user (running
 * this from a phone, with no other visibility into the process) can
 * see exactly what the agent is doing.
 */
export function createLogger(scope: string, minLevel: LogLevel = "info"): Logger {
  function emit(level: LogLevel, msg: string, data?: unknown) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const event: LogEvent = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      data,
    };
    const line = `[${event.ts}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (data !== undefined) {
      out(line, typeof data === "string" ? data : JSON.stringify(data));
    } else {
      out(line);
    }
  }

  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`, minLevel),
  };
}
