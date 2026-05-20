import { readFile } from "node:fs/promises";
import { Liquid } from "liquidjs";
import type { AlophonyConfig } from "../config/schema.js";
import type { NormalizedIssue } from "../types.js";

const DEFAULT_TEMPLATE = `Work on {{ issue.identifier }}: {{ issue.title }}

Issue URL: {{ issue.url | default: "n/a" }}
Workspace: {{ workspace.path }}
Attempt: {{ run.attemptNumber }}

{{ issue.description | default: "" }}
`;

export interface PromptInput {
  issue: NormalizedIssue;
  workspacePath: string;
  attemptNumber: number;
}

export async function renderPrompt(config: AlophonyConfig["prompt"], input: PromptInput): Promise<string> {
  const template = config.templatePath
    ? await readFile(config.templatePath, "utf8")
    : config.inlineTemplate ?? DEFAULT_TEMPLATE;
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
  });
  return engine.parseAndRender(template, {
    issue: {
      identifier: input.issue.identifier,
      title: input.issue.title,
      description: input.issue.description ?? "",
      url: input.issue.url ?? "",
      state: input.issue.state,
    },
    workspace: {
      path: input.workspacePath,
    },
    run: {
      attemptNumber: input.attemptNumber,
    },
  });
}
