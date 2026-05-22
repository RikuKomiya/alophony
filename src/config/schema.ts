import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(2),
  initialBackoffMs: z.number().int().min(0).default(1_000),
  maxBackoffMs: z.number().int().min(0).default(30_000),
  backoffMultiplier: z.number().min(1).default(2),
});

export const HooksSchema = z
  .object({
    beforeCreate: z.string().optional(),
    afterCreate: z.string().optional(),
    beforeRun: z.string().optional(),
    afterRun: z.string().optional(),
    beforeRemove: z.string().optional(),
    beforeCleanup: z.string().optional(),
    timeoutMs: z.number().int().min(1).default(60_000),
    required: z.boolean().default(false),
  })
  .default({ timeoutMs: 60_000, required: false });

export const ConfigSchema = z.object({
  tracker: z.object({
    kind: z.enum(["linear", "fake"]).default("linear"),
    projectSlug: nonEmptyString,
    activeStates: z.array(nonEmptyString).min(1),
    terminalStates: z.array(nonEmptyString).min(1),
    apiToken: z.string().optional(),
    endpoint: nonEmptyString.default("https://api.linear.app/graphql"),
    requestTimeoutMs: z.number().int().min(1).default(30_000),
    fakeIssuesPath: z.string().optional(),
  }),
  database: z.object({
    url: nonEmptyString,
    authToken: z.string().optional(),
    migrationsDir: z.string().default("migrations"),
  }),
  workspace: z.object({
    root: nonEmptyString,
    hooks: HooksSchema,
  }),
  scheduler: z.object({
    pollIntervalMs: z.number().int().min(100).default(30_000),
    reconcileIntervalMs: z.number().int().min(100).default(15_000),
    maxConcurrency: z.number().int().min(1).default(1),
    lockTtlMs: z.number().int().min(1_000).default(10 * 60_000),
    lockRenewIntervalMs: z.number().int().min(100).default(30_000),
  }),
  agent: z
    .object({
      maxTurns: z.number().int().min(1).default(1),
      maxRetryBackoffMs: z.number().int().min(0).default(30_000),
      maxConcurrentAgentsByState: z.record(z.string(), z.number().int().min(1)).default({}),
      continuationDelayMs: z.number().int().min(0).default(1_000),
    })
    .default({
      maxTurns: 1,
      maxRetryBackoffMs: 30_000,
      maxConcurrentAgentsByState: {},
      continuationDelayMs: 1_000,
    }),
  codex: z.object({
    command: nonEmptyString.default("codex app-server"),
    model: z.string().optional(),
    approvalPolicy: nonEmptyString.default("never"),
    sandboxPolicy: nonEmptyString.default("workspace-write"),
    startupTimeoutMs: z.number().int().min(100).default(10_000),
    turnTimeoutMs: z.number().int().min(100).default(10 * 60_000),
    idleTimeoutMs: z.number().int().min(100).default(60_000),
    shutdownTimeoutMs: z.number().int().min(100).default(5_000),
    generateProtocolTypes: z.boolean().default(false),
  }),
  prompt: z
    .object({
      templatePath: z.string().optional(),
      inlineTemplate: z.string().optional(),
    })
    .default({}),
  retry: RetryPolicySchema.default({
    maxAttempts: 2,
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    backoffMultiplier: 2,
  }),
  api: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65_535).default(3000),
      operatorToken: z.string().optional(),
    })
    .default({ enabled: false, host: "127.0.0.1", port: 3000 }),
  logLevel: z.string().default("info"),
});

export type AlophonyConfig = z.infer<typeof ConfigSchema>;

export type PartialAlophonyConfig = {
  tracker?: Partial<AlophonyConfig["tracker"]>;
  database?: Partial<AlophonyConfig["database"]>;
  workspace?: Partial<AlophonyConfig["workspace"]>;
  scheduler?: Partial<AlophonyConfig["scheduler"]>;
  codex?: Partial<AlophonyConfig["codex"]>;
  prompt?: Partial<AlophonyConfig["prompt"]>;
  retry?: Partial<AlophonyConfig["retry"]>;
  api?: Partial<AlophonyConfig["api"]>;
  agent?: Partial<AlophonyConfig["agent"]>;
  logLevel?: string;
};

export const DEFAULT_CONFIG: PartialAlophonyConfig = {
  tracker: {
    kind: "linear",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate"],
    endpoint: "https://api.linear.app/graphql",
    requestTimeoutMs: 30_000,
  },
  workspace: {
    root: ".alophony/workspaces",
  },
  scheduler: {
    pollIntervalMs: 30_000,
    reconcileIntervalMs: 15_000,
    maxConcurrency: 1,
    lockTtlMs: 10 * 60_000,
    lockRenewIntervalMs: 30_000,
  },
  codex: {
    command: "codex app-server",
    approvalPolicy: "never",
    sandboxPolicy: "workspace-write",
  },
  agent: {
    maxTurns: 1,
    maxRetryBackoffMs: 30_000,
    maxConcurrentAgentsByState: {},
    continuationDelayMs: 1_000,
  },
  database: {
    migrationsDir: "migrations",
  },
  prompt: {},
  retry: {},
  api: {},
};
