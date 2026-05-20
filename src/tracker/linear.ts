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
  priorityLabel?: string | null;
  updatedAt?: string | null;
  assignee?: { name?: string | null } | null;
  state: { name: string };
}

interface LinearIssueConnection {
  nodes: LinearIssueNode[];
  pageInfo?: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
}

function normalize(node: LinearIssueNode): NormalizedIssue {
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
    ...(node.priorityLabel ? { priority: node.priorityLabel } : {}),
    raw: node,
    updatedAt: node.updatedAt ?? nowIso(),
  };
}

export class LinearTrackerClient implements TrackerClient {
  constructor(private readonly apiToken: string | undefined) {}

  async listCandidateIssues(config: AlophonyConfig): Promise<NormalizedIssue[]> {
    return this.fetchIssues(config, config.tracker.activeStates);
  }

  async getIssue(issueId: string): Promise<NormalizedIssue | null> {
    const data = await this.graphql<{ issue: LinearIssueNode | null }>(
      `query AlophonyIssue($id: String!) {
        issue(id: $id) {
          id identifier title description url priorityLabel updatedAt
          assignee { name }
          state { name }
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
    const data = await this.graphql<{ issue: { relations: { nodes: Array<{ relatedIssue: LinearIssueNode }> } } | null }>(
      `query AlophonyBlockers($id: String!) {
        issue(id: $id) {
          relations(filter: { type: { eq: blocks } }, first: 50) {
            nodes {
              relatedIssue {
                id identifier title description url priorityLabel updatedAt
                assignee { name }
                state { name }
              }
            }
          }
        }
      }`,
      { id: issueId },
    );
    return data.issue?.relations.nodes.map((node) => normalize(node.relatedIssue)) ?? [];
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
              id identifier title description url priorityLabel updatedAt
              assignee { name }
              state { name }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { projectSlug: config.tracker.projectSlug, states, after },
      );
      issues.push(...data.issues.nodes.map(normalize));
      after = data.issues.pageInfo?.endCursor ?? undefined;
      if (!data.issues.pageInfo?.hasNextPage) {
        after = undefined;
      }
    } while (after);
    return issues;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.apiToken) {
      throw new Error("Linear API token is required");
    }
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.apiToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`Linear GraphQL request failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors?.length) {
      throw new Error(`Linear GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
    }
    if (!payload.data) {
      throw new Error("Linear GraphQL response did not include data");
    }
    return payload.data;
  }
}
