import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { ConfigSchema } from "../../src/config/schema.js";
import { loadWorkflowFile, watchWorkflowConfig, WorkflowLoaderError } from "../../src/config/workflow.js";
import { createLogger } from "../../src/logging/logger.js";
import { tempDir } from "../helpers.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.TRACKER_PROJECT_SLUG;
});

describe("config schema", () => {
  it("rejects missing required config", () => {
    expect(() => ConfigSchema.parse({})).toThrow();
  });

  it("accepts a complete v1 config", () => {
    const config = ConfigSchema.parse({
      tracker: {
        kind: "fake",
        projectSlug: "TEST",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      database: {
        url: "file::memory:",
      },
      workspace: {
        root: ".alophony/workspaces",
      },
      scheduler: {
        pollIntervalMs: 1_000,
        maxConcurrency: 1,
      },
      codex: {
        command: "node fake",
      },
      prompt: {},
    });
    expect(config.database.url).toBe("file::memory:");
    expect(config.scheduler.lockTtlMs).toBeGreaterThan(0);
  });

  it("loads default WORKFLOW.md front matter and prompt body without global env overrides", async () => {
    const dir = await tempDir("workflow-default");
    process.chdir(dir);
    process.env.TRACKER_PROJECT_SLUG = "ENV_SHOULD_NOT_WIN";
    await writeFile(path.join(dir, "WORKFLOW.md"), workflowText("YAML_PROJECT", "Hello {{ issue.identifier }}"));

    const config = await loadConfig();

    expect(config.tracker.projectSlug).toBe("YAML_PROJECT");
    expect(config.prompt.inlineTemplate).toBe("Hello {{ issue.identifier }}");
    expect(config.workspace.root).toBe(path.resolve("workspaces"));
  });

  it("uses explicit workflow path before default WORKFLOW.md", async () => {
    const dir = await tempDir("workflow-explicit");
    await writeFile(path.join(dir, "WORKFLOW.md"), workflowText("DEFAULT_PROJECT", "Default"));
    await writeFile(path.join(dir, "Custom.md"), workflowText("EXPLICIT_PROJECT", "Explicit"));
    process.chdir(dir);

    const config = await loadConfig({ workflowPath: path.join(dir, "Custom.md") });

    expect(config.tracker.projectSlug).toBe("EXPLICIT_PROJECT");
    expect(config.prompt.inlineTemplate).toBe("Explicit");
  });

  it("maps non-map workflow front matter to a typed error", async () => {
    const dir = await tempDir("workflow-non-map");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, "---\n- nope\n---\nbody\n");

    await expect(loadWorkflowFile(workflowPath)).rejects.toMatchObject({
      code: "workflow_front_matter_not_a_map",
    });
  });

  it("keeps last known good config after invalid workflow reload", async () => {
    const dir = await tempDir("workflow-reload");
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(workflowPath, workflowText("GOOD", "Good prompt"));
    const config = await loadConfig({ workflowPath });
    const handle = watchWorkflowConfig({ workflowPath, config, logger: createLogger("silent") });

    await writeFile(workflowPath, "---\ntracker\n---\nBad prompt\n");
    await wait(100);
    handle.close();

    expect(config.tracker.projectSlug).toBe("GOOD");
    expect(config.prompt.inlineTemplate).toBe("Good prompt");
  });
});

function workflowText(projectSlug: string, body: string): string {
  return `---
tracker:
  kind: fake
  projectSlug: ${projectSlug}
  activeStates: [Todo, In Progress]
  terminalStates: [Done]
database:
  url: file::memory:
workspace:
  root: workspaces
codex:
  command: node fake
---
${body}
`;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
