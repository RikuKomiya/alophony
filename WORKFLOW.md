---
tracker:
  kind: linear
  projectSlug: "53869"
  activeStates: [Todo, In Progress]
  terminalStates: [Done, Canceled, Cancelled, Duplicate]
  apiToken: $LINEAR_API_TOKEN
database:
  url: file:.alophony/dev.db
workspace:
  root: .alophony/workspaces
scheduler:
  pollIntervalMs: 30000
  maxConcurrency: 1
codex:
  command: codex app-server
  approvalPolicy: never
  sandboxPolicy: workspace-write
  turnTimeoutMs: 1800000
  idleTimeoutMs: 300000
api:
  enabled: true
  port: 3000
---
Work on {{ issue.identifier }}: {{ issue.title }}

Issue URL: {{ issue.url }}
State: {{ issue.state }}
Workspace: {{ workspace.path }}

{{ issue.description }}
