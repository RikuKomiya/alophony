import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceManager, WorkspaceSafetyError } from "../../src/workspace/manager.js";
import { testConfig, tempDir } from "../helpers.js";

describe("WorkspaceManager", () => {
  it("creates deterministic safe paths", async () => {
    const root = await tempDir("workspace");
    const config = testConfig({ workspace: { root } });
    const manager = new WorkspaceManager(config.workspace);
    const workspace = manager.workspacePathFor({
      id: "issue_1",
      trackerKind: "fake",
      trackerIssueId: "abc",
      identifier: "TEST 1",
      title: "Title",
      state: "Todo",
      priority: null,
      labels: [],
      blockedBy: [],
      createdAt: new Date().toISOString(),
      raw: {},
      updatedAt: new Date().toISOString(),
    });
    expect(workspace.startsWith(path.resolve(root))).toBe(true);
    expect(workspace).toContain("TEST_1");
  });

  it("rejects root deletion", async () => {
    const root = await tempDir("workspace");
    const config = testConfig({ workspace: { root } });
    const manager = new WorkspaceManager(config.workspace);
    expect(() => manager.assertInsideRoot(path.resolve(root))).toThrow(WorkspaceSafetyError);
  });
});
