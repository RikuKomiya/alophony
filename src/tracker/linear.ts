import type { AlophonyConfig } from "../config/schema.js";
import type { NormalizedIssue } from "../types.js";
import { nowIso } from "../util/time.js";
import { issueDbId, type TrackerClient } from "./client.js";

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  branchName?: string | null;
  assignee?: { name?: string | null } | null;
  state: { name: string };
  labels?: { nodes?: Array<{ name?: string | null }> } | null;
}

interface LinearIssueConnection {
  nodes: LinearIssueNode[];
  pageInfo?: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
}

export type LinearErrorCode = "linear_transport_error" | "linear_status_error" | "linear_graphql_error" | "linear_malformed_payload";

export class LinearTrackerError extends Error {
  constructor(readonly code: LinearErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LinearTrackerError";
  }
}

function normalize(node: LinearIssueNode, blockedBy: string[] = []): NormalizedIssue {
  const updatedAt = node.updatedAt ?? nowIso();
  const labels = node.labels?.nodes?.flatMap((label) => label.name ? [label.name.toLowerCase()] : []) ?? [];
  return {
    id: issueDbId("linear", node.id),
    trackerKind: "linear",
    trackerIssueId: node.id,
    identifier: node.identifier,
    title: node.title,
    state: node.state.name,
    ...(node.description ? { description: node.description } : {}),
    ...(node.url ? { url: node.url } : {}),
    ...(node.assignee?.name ? { assignee: node.assignee.name } : {}),
    priority: typeof node.priority === "number" ? node.priority : null,
    ...(node.branchName ? { branchName: node.branchName, branch_name: node.branchName } : {}),
    labels,
    blockedBy,
    blocked_by: blockedBy,
    createdAt: node.createdAt ?? updatedAt,
    created_at: node.createdAt ?? updatedAt,
    raw: node,
    updatedAt,
    updated_at: updatedAt,
  };
}

export class LinearTrackerClient implements TrackerClient {
  constructor(
    private readonly apiToken: string | undefined,
    private readonly endpoint = "https://api.linear.app/graphql",
    private readonly timeoutMs = 30_000,
  ) {}

  async listCandidateIssues(config: AlophonyConfig): Promise<NormalizedIssue[]> {
    return this.fetchIssues(config, config.tracker.activeStates);
  }

  async getIssue(issueId: string): Promise<NormalizedIssue | null> {
    const data = await this.graphql<{ issue: LinearIssueNode | null }>(
      `query AlophonyIssue($id: String!) {
        issue(id: $id) {
          id identifier title description url priority updatedAt createdAt branchName
          assignee { name }
          state { name }
          labels { nodes { name } }
        }
      }`,
      { id: issueId },
    );
    return data.issue ? normalize(data.issue) : null;
  }

  async listTerminalIssues(config: AlophonyConfig): Promise<NormalizedIssue[]> {
    return this.fetchIssues(config, config.tracker.terminalStates);
  }

  async listBlockingIssues(issueId: string): Promise<NormalizedIssue[]> {
    const data = await this.graphql<{ issue: { inverseRelations: { nodes: Array<{ issue: LinearIssueNode }> } } | null }>(
      `query AlophonyBlockers($id: String!) {
        issue(id: $id) {
          inverseRelations(filter: { type: { eq: blocks } }, first: 50) {
            nodes {
              issue {
                id identifier title description url priority updatedAt createdAt branchName
                assignee { name }
                state { name }
                labels { nodes { name } }
              }
            }
          }
        }
      }`,
      { id: issueId },
    );
    return data.issue?.inverseRelations.nodes.map((node) => normalize(node.issue)) ?? [];
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Map<string, string>> {
    const data = await this.graphql<{ issues: { nodes: Array<{ id: string; state: { name: string } }> } }>(
      `query AlophonyIssueStates($ids: [ID!]) {
        issues(filter: { id: { in: $ids } }, first: 100) {
          nodes { id state { name } }
        }
      }`,
      { ids: issueIds },
    );
    return new Map(data.issues.nodes.map((issue) => [issue.id, issue.state.name]));
  }

  private async fetchIssues(config: AlophonyConfig, states: string[]): Promise<NormalizedIssue[]> {
    const issues: NormalizedIssue[] = [];
    let after: string | undefined;
    do {
      const data: { issues: LinearIssueConnection } = await this.graphql(
        `query AlophonyIssues($projectSlug: String!, $states: [String!], $after: String) {
          issues(
            first: 50,
            after: $after,
            filter: {
              project: { slugId: { eq: $projectSlug } },
              state: { name: { in: $states } }
            }
          ) {
            nodes {
              id identifier title description url priority updatedAt createdAt branchName
              assignee { name }
              state { name }
              labels { nodes { name } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { projectSlug: config.tracker.projectSlug, states, after },
      );
      issues.push(...data.issues.nodes.map((node) => normalize(node)));
      if (data.issues.pageInfo?.hasNextPage && !data.issues.pageInfo.endCursor) {
        throw new LinearTrackerError("linear_malformed_payload", "Linear pagination hasNextPage=true without endCursor");
      }
      after = data.issues.pageInfo?.endCursor ?? undefined;
      if (!data.issues.pageInfo?.hasNextPage) {
        after = undefined;
      }
    } while (after);
    return issues;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.apiToken) {
      throw new LinearTrackerError("linear_transport_error", "Linear API token is required");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.apiToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new LinearTrackerError("linear_transport_error", "Linear GraphQL transport failed", error);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new LinearTrackerError("linear_status_error", `Linear GraphQL request failed: ${response.status} ${response.statusText}`);
    }
    let payload: { data?: T; errors?: Array<{ message: string }> };
    try {
      payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    } catch (error) {
      throw new LinearTrackerError("linear_malformed_payload", "Linear GraphQL response was not JSON", error);
    }
    if (payload.errors?.length) {
      throw new LinearTrackerError("linear_graphql_error", `Linear GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
    }
    if (!payload.data) {
      throw new LinearTrackerError("linear_malformed_payload", "Linear GraphQL response did not include data");
    }
    return payload.data;
  }
}
