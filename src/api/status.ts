import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import type { AlophonyConfig } from "../config/schema.js";
import type { RunRepository } from "../db/repository.js";

export interface StatusApiDeps {
  config: AlophonyConfig["api"];
  repository: RunRepository;
}

export function createStatusApi(deps: StatusApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => {
    await deps.repository.listRuns(1);
    return { ok: true };
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
    await deps.repository.markRunStatus(request.params.id, "canceled", "operator_cancel");
    return { ok: true };
  });

  return app;
}
