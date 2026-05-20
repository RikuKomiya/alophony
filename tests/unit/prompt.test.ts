import { describe, expect, it } from "vitest";
import { renderPrompt } from "../../src/prompt/render.js";
import { issueDbId } from "../../src/tracker/client.js";

describe("renderPrompt", () => {
  const issue = {
    id: issueDbId("fake", "1"),
    trackerKind: "fake",
    trackerIssueId: "1",
    identifier: "TEST-1",
    title: "Implement",
    state: "Todo",
    raw: {},
    updatedAt: new Date().toISOString(),
  };

  it("renders known variables", async () => {
    const result = await renderPrompt({ inlineTemplate: "{{ issue.identifier }} {{ workspace.path }} {{ run.attemptNumber }}" }, {
      issue,
      workspacePath: "/tmp/work",
      attemptNumber: 2,
    });
    expect(result).toContain("TEST-1 /tmp/work 2");
  });

  it("fails on unknown variables", async () => {
    await expect(renderPrompt({ inlineTemplate: "{{ missing.value }}" }, {
      issue,
      workspacePath: "/tmp/work",
      attemptNumber: 1,
    })).rejects.toThrow();
  });
});
