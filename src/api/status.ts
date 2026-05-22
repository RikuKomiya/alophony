import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { AlophonyConfig } from "../config/schema.js";
import type { RunRepository } from "../db/repository.js";
import type { Scheduler } from "../scheduler/scheduler.js";

export interface StatusApiDeps {
  config: AlophonyConfig["api"];
  repository: RunRepository;
  scheduler?: Pick<Scheduler, "cancelRun" | "tick" | "reconcile" | "getRuntimeState"> | undefined;
}

export function createStatusApi(deps: StatusApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => {
    await deps.repository.listRuns(1);
    return { ok: true };
  });
  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return "<!doctype html><html><head><title>Alophony</title></head><body><h1>Alophony</h1><p>Runtime status is available at <a href=\"/api/v1/state\">/api/v1/state</a>.</p></body></html>";
  });
  app.get("/api/v1/state", async () => {
    const runs = await deps.repository.listRuns(500);
    const active = runs.filter((run) => ["claimed", "running", "terminal_cleanup"].includes(run.status));
    const now = Date.now();
    const runtimeSeconds = runs.reduce((total, run) => {
      const started = run.startedAt ? Date.parse(run.startedAt) : undefined;
      if (!started) {
        return total;
      }
      const finished = run.finishedAt ? Date.parse(run.finishedAt) : now;
      return total + Math.max(0, (finished - started) / 1000);
    }, 0);
    return {
      running_sessions: active,
      retry_queue: deps.scheduler?.getRuntimeState().retry_attempts ?? [],
      codex_totals: deps.scheduler?.getRuntimeState().codex_totals ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latest_rate_limits: deps.scheduler?.getRuntimeState().codex_rate_limits ?? null,
      runtime_seconds: runtimeSeconds,
      counts: runs.reduce<Record<string, number>>((counts, run) => {
        counts[run.status] = (counts[run.status] ?? 0) + 1;
        return counts;
      }, {}),
    };
  });
  app.get<{ Params: { issue_identifier: string } }>("/api/v1/:issue_identifier", async (request, reply) => {
    const issue = await deps.repository.getIssueByIdentifier(request.params.issue_identifier);
    if (!issue) {
      return reply.code(404).send({ error: { code: "not_found", message: "issue not found" } });
    }
    const runs = (await deps.repository.listRuns(500)).filter((run) => run.issueId === issue.id);
    return { issue, runs };
  });
  app.post("/api/v1/refresh", async (_request, reply) => {
    if (deps.config.operatorToken) {
      const auth = _request.headers.authorization;
      if (auth !== `Bearer ${deps.config.operatorToken}`) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "invalid operator token" } });
      }
    }
    if (deps.scheduler) {
      setImmediate(() => {
        void deps.scheduler?.reconcile();
        void deps.scheduler?.tick();
      });
    }
    return reply.code(202).send({ ok: true });
  });
  app.get("/api/v1/runs", async () => ({ runs: await deps.repository.listRuns() }));
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request, reply) => {
    const run = await deps.repository.getRun(request.params.id);
    if (!run) {
      return reply.code(404).send({ error: { code: "not_found", message: "run not found" } });
    }
    return { run, events: await deps.repository.listEvents(run.id) };
  });
  app.get<{ Params: { id: string } }>("/api/v1/issues/:id", async (request, reply) => {
    const issue = await deps.repository.getIssueById(request.params.id);
    if (!issue) {
      return reply.code(404).send({ error: { code: "not_found", message: "issue not found" } });
    }
    return { issue };
  });
  app.get<{ Querystring: { runId?: string } }>("/api/v1/events", async (request, reply) => {
    if (!request.query.runId) {
      return reply.code(400).send({ error: { code: "missing_run_id", message: "runId is required" } });
    }
    return { events: await deps.repository.listEvents(request.query.runId) };
  });
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/cancel", async (request, reply) => {
    if (deps.config.operatorToken) {
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${deps.config.operatorToken}`) {
        return reply.code(401).send({ error: { code: "unauthorized", message: "invalid operator token" } });
      }
    }
    if (deps.scheduler) {
      const canceled = await deps.scheduler.cancelRun(request.params.id, "operator_cancel");
      if (!canceled) {
        return reply.code(404).send({ error: { code: "not_found", message: "run not found" } });
      }
    } else {
      await deps.repository.markRunStatus(request.params.id, "canceled", "operator_cancel");
    }
    return { ok: true };
  });

  return app;
}
