import { readFile } from "node:fs/promises";
import type { AlophonyConfig } from "../config/schema.js";
import type { NormalizedIssue } from "../types.js";
import { nowIso } from "../util/time.js";
import { issueDbId, type TrackerClient } from "./client.js";

interface FakeIssueInput {
  id: string;
  identifier: string;
  title: string;
  state: string;
  description?: string;
  url?: string;
  assignee?: string;
  priority?: string;
  blockers?: string[];
  updatedAt?: string;
}

function normalize(input: FakeIssueInput): NormalizedIssue {
  return {
    id: issueDbId("fake", input.id),
    trackerKind: "fake",
    trackerIssueId: input.id,
    identifier: input.identifier,
    title: input.title,
    state: input.state,
    ...(input.description ? { description: input.description } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.assignee ? { assignee: input.assignee } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    raw: input,
    updatedAt: input.updatedAt ?? nowIso(),
  };
}

export class FakeTrackerClient implements TrackerClient {
  private readonly memory: FakeIssueInput[];

  constructor(issues: FakeIssueInput[] = []) {
    this.memory = issues;
  }

  async listCandidateIssues(config: AlophonyConfig): Promise<NormalizedIssue[]> {
    const issues = await this.loadIssues(config);
    return issues.map(normalize);
  }

  async getIssue(issueId: string): Promise<NormalizedIssue | null> {
    const found = this.memory.find((issue) => issue.id === issueId || issueDbId("fake", issue.id) === issueId);
    return found ? normalize(found) : null;
  }

  async listTerminalIssues(config: AlophonyConfig): Promise<NormalizedIssue[]> {
    const issues = await this.loadIssues(config);
    return issues.filter((issue) => config.tracker.terminalStates.includes(issue.state)).map(normalize);
  }

  async listBlockingIssues(issueId: string): Promise<NormalizedIssue[]> {
    const issue = this.memory.find((candidate) => candidate.id === issueId || issueDbId("fake", candidate.id) === issueId);
    const blockers = issue?.blockers ?? [];
    return this.memory.filter((candidate) => blockers.includes(candidate.id)).map(normalize);
  }

  private async loadIssues(config: AlophonyConfig): Promise<FakeIssueInput[]> {
    if (!config.tracker.fakeIssuesPath) {
      return this.memory;
    }
    const parsed = JSON.parse(await readFile(config.tracker.fakeIssuesPath, "utf8")) as { issues?: FakeIssueInput[] } | FakeIssueInput[];
    const issues = Array.isArray(parsed) ? parsed : parsed.issues ?? [];
    this.memory.splice(0, this.memory.length, ...issues);
    return this.memory;
  }
}
