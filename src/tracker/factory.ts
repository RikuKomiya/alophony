import type { AlophonyConfig } from "../config/schema.js";
import { FakeTrackerClient } from "./fake.js";
import { LinearTrackerClient } from "./linear.js";
import type { TrackerClient } from "./client.js";

export function createTrackerClient(config: AlophonyConfig): TrackerClient {
  if (config.tracker.kind === "fake") {
    return new FakeTrackerClient();
  }
  return new LinearTrackerClient(config.tracker.apiToken, config.tracker.endpoint, config.tracker.requestTimeoutMs);
}
