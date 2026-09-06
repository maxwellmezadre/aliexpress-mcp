import { appendFileSync } from "node:fs";

// Diagnostics logger: ALWAYS stderr — stdout is reserved for the MCP JSON-RPC
// stream. Optional file via ALIEXPRESS_LOG_FILE. Secrets (cookie values) never
// hit a log line: every message goes through redaction, and the secret list can
// be a provider so it follows the `_m_h5_tk` renewals without rebuilding the
// logger.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = Record<LogLevel, (message: string) => void>;
export type SecretsSource = readonly string[] | (() => readonly string[]);

/** Values shorter than this are not secrets (a 1-char cookie would erase every "s"). */
export const MIN_SECRET_LENGTH = 8;

export function redactSecrets(message: string, secrets: readonly string[]): string {
  let output = message;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) output = output.split(secret).join("***");
  }
  return output;
}

export function createLogger(opts: {
  logFile?: string;
  secrets?: SecretsSource;
  sink?: (line: string) => void;
}): Logger {
  const source = opts.secrets ?? [];
  const secrets = () => (typeof source === "function" ? source() : source);
  const emit = (level: LogLevel, message: string) => {
    const line = `[${level}] ${redactSecrets(message, secrets())}\n`;
    (opts.sink ?? ((text: string) => process.stderr.write(text)))(line);
    if (opts.logFile) {
      try {
        appendFileSync(opts.logFile, line);
      } catch {
        // Logging must never take the process down.
      }
    }
  };
  return {
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}
