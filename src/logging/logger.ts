import pino from "pino";

export function createLogger(level = process.env.LOG_LEVEL ?? "info"): pino.Logger {
  return pino({
    level,
    base: {
      service: "alophony",
      process_id: process.pid,
    },
    redact: {
      paths: [
        "database.authToken",
        "tracker.apiToken",
        "*.authToken",
        "*.apiToken",
        "TURSO_AUTH_TOKEN",
        "LINEAR_API_TOKEN",
      ],
      censor: "[redacted]",
    },
  });
}
