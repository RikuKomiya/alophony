import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearTrackerClient, LinearTrackerError } from "../../src/tracker/linear.js";
import { testConfig } from "../helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LinearTrackerClient", () => {
  it("normalizes pagination, labels, priority, timestamps, and endpoint", async () => {
    const calls: Array<{ url: string; body: { variables: Record<string, unknown> } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { variables: Record<string, unknown> };
      calls.push({ url, body });
      const after = body.variables.after;
      return response({
        data: {
          issues: {
            nodes: [
              {
                id: after ? "issue-2" : "issue-1",
                identifier: after ? "LIN-2" : "LIN-1",
                title: "Title",
                description: "Desc",
                url: "https://linear/issue",
                priority: after ? null : 1,
                createdAt: after ? "2026-01-02T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-03T00:00:00.000Z",
                branchName: "branch/name",
                assignee: { name: "Ada" },
                state: { name: "Todo" },
                labels: { nodes: [{ name: "Backend" }, { name: "P0" }] },
              },
            ],
            pageInfo: after ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      });
    }));
    const client = new LinearTrackerClient("token", "https://linear.test/graphql", 30_000);

    const issues = await client.listCandidateIssues(testConfig());

    expect(calls.map((call) => call.url)).toEqual(["https://linear.test/graphql", "https://linear.test/graphql"]);
    expect(issues.map((issue) => issue.identifier)).toEqual(["LIN-1", "LIN-2"]);
    expect(issues[0]).toMatchObject({
      priority: 1,
      labels: ["backend", "p0"],
      branchName: "branch/name",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("fails pagination when hasNextPage lacks endCursor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    })));
    const client = new LinearTrackerClient("token");

    await expect(client.listCandidateIssues(testConfig())).rejects.toMatchObject({
      code: "linear_malformed_payload",
    });
  });

  it("fetches issue states by GraphQL ID list", async () => {
    let query = "";
    let variables: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      query = body.query;
      variables = body.variables;
      return response({ data: { issues: { nodes: [{ id: "a", state: { name: "Done" } }] } } });
    }));
    const client = new LinearTrackerClient("token");

    const states = await client.fetchIssueStatesByIds(["a"]);

    expect(query).toContain("$ids: [ID!]");
    expect(variables.ids).toEqual(["a"]);
    expect(states.get("a")).toBe("Done");
  });
});

function response(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  } as Response;
}
