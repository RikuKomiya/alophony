import type { AlophonyConfig } from "../config/schema.js";
import type { NormalizedIssue } from "../types.js";
import { shortHash } from "../util/id.js";

export interface TrackerClient {
  listCandidateIssues(config: AlophonyConfig): Promise<NormalizedIssue[]>;
  getIssue(issueId: string): Promise<NormalizedIssue | null>;
  listTerminalIssues(config: AlophonyConfig): Promise<NormalizedIssue[]>;
  listBlockingIssues(issueId: string): Promise<NormalizedIssue[]>;
  fetchIssueStatesByIds?(issueIds: string[]): Promise<Map<string, string>>;
}

export function issueDbId(trackerKind: string, trackerIssueId: string): string {
  return `issue_${shortHash(`${trackerKind}:${trackerIssueId}`, 24)}`;
}
