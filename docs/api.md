---
title: API Reference
nav_order: 4
---

# API Reference

Base URL: `http://127.0.0.1:23000` (configurable via `ENSEMBLE_PORT`)

The server defaults to loopback. For an external bind, set `ENSEMBLE_ALLOW_EXTERNAL=1`
and an `ENSEMBLE_API_TOKEN` of at least 32 characters. Clients send the token
in the `Authorization: Bearer …` header. When configured, the token is required
for team mutations and reads from external peers. Configure
`ENSEMBLE_TRUSTED_PROXIES` with the exact IP addresses of proxies that append
the connecting peer to `X-Forwarded-For`. The server ignores that header from
other peers. Use HTTPS at the reverse proxy for network access.

Operator and unauthenticated requests are limited to 100 per IP per minute.
Verified agent requests have a separate budget of 100 per agent, team and IP.
Health and team detail/feed polling are exempt.

---

## Health

### `GET /api/v1/health`

```bash
curl http://localhost:23000/api/v1/health
```

```json
{ "status": "healthy", "version": "1.0.0" }
```

---

## Teams

### `POST /api/ensemble/teams` — Create team

```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "review-team",
    "description": "Review the documentation for consistency",
    "agents": [
      { "program": "codex", "role": "lead", "hostId": "local" },
      { "program": "claude", "role": "worker", "hostId": "local" }
    ],
    "workingDirectory": "/path/to/project",
    "feedMode": "live",
    "useWorktrees": false,
    "templateName": null,
    "staged": false
  }'
```

**Required fields:**
- `name` (string) — team name
- `description` (string) — task for the team
- `agents` (array) — at least one agent with a `program` field. Valid values are the keys in
  [`agents.json`](configuration#agent-programs-agentsjson): `codex`, `claude`, `grok`, `agy`, `gemini`,
  `glm`, `opencode`, `mimo`, plus any you add yourself. Unknown programs return `400`.
  Use `role: "lead"` to select a Lead. The first agent is the default.

**Optional fields:**
- `workingDirectory` (string) — project path for agents
- `feedMode` (`"silent"`, `"summary"`, or `"live"`) — message delivery mode
- `useWorktrees` (boolean) — isolate agents in git worktrees
- `templateName` (string) — use a collab template (`review`, `implement`, `debug`)
- `staged` (boolean) — enable staged plan/execute/verify workflow
- `stagedConfig` (object) — `planTimeoutMs`, `execTimeoutMs`, `verifyTimeoutMs`
- `requireRegression` (boolean) — require a Git baseline and at least one configured regression check for acceptance.
- `requireLeadReady` (boolean) — hold worker prompts until the Lead publishes a plan. Enabled by default for multi-agent teams.

**Response:** `{ "team": EnsembleTeam }`

Returns `400` for invalid requests, `409` for an unfinished team with the same
name, `429` for rate limiting, and `503` for failed local preflight or Lead
startup. A failed startup includes the registered team when available.
Each agent's `startup` field records session creation, CLI readiness and
prompt delivery. The workflow record stores the acknowledged plan and its current state.

---

### `GET /api/ensemble/teams` — List teams

```bash
curl http://127.0.0.1:23000/api/ensemble/teams
```

**Response:** `{ "teams": EnsembleTeam[] }`

---

### `GET /api/ensemble/teams/:id` — Get team details

```bash
curl http://127.0.0.1:23000/api/ensemble/teams/abc-123
```

**Response:** `{ "team": EnsembleTeam, "messages": EnsembleMessage[] }`

---

### `POST /api/ensemble/teams/:id` — Send message

```bash
curl -X POST http://127.0.0.1:23000/api/ensemble/teams/abc-123 \
  -H "Content-Type: application/json" \
  -d '{
    "from": "user",
    "to": "codex-1",
    "content": "Focus on the auth module"
  }'
```

**Fields:**
- `content` (string, required) — message text
- `to` (string) — recipient agent name; defaults to `"team"` when omitted or empty
- `from` (string) — sender name (default: `"user"`)

**Response:** `{ "message": EnsembleMessage }`

Returns `400` for malformed JSON.

---

### `DELETE /api/ensemble/teams/:id` — Disband team

```bash
curl -X DELETE http://127.0.0.1:23000/api/ensemble/teams/abc-123
```

Stops all agents, generates summary, cleans up. Also available as `POST /api/ensemble/teams/:id/disband`.

**Response:** `{ "team": EnsembleTeam }`

---

## Feed

A caller can supply a stable message `id` of 1–256 characters to retry a request. Longer or empty IDs return `400` before enqueueing. Existing messages with longer IDs remain eligible for acknowledgement. A reused ID with
different sender, recipient or content returns `409`. For managed teams, a
successful POST queues a message for the recipients to read. A managed agent
credential permits posting as its holder and reading that holder's feed for the
same team. Workflow events and delivery receipts require such a credential.
Record a receipt by posting `<<COLLAB_RECEIVED>> ["message-id"]` to `ensemble`
after processing the message. A read leaves the delivery queued until this
acknowledgement. Each delivery records its state and timestamp. Set `priority: "urgent"` to label an urgent
message in the inbox. It stays in FIFO order.

### `GET /api/ensemble/teams/:id/feed` — Message feed

```bash
# All messages
curl http://localhost:23000/api/ensemble/teams/abc-123/feed

# Incremental (since timestamp)
curl "http://localhost:23000/api/ensemble/teams/abc-123/feed?since=2026-03-20T10:00:00Z"
```

**Query params:**
- `since` (ISO 8601 timestamp) — only return messages after this time

**Response:** `{ "messages": EnsembleMessage[] }`

Use the `since` parameter for efficient polling — avoids re-fetching the entire message history.

---

## Types

### EnsembleTeam

```typescript
{
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string // ISO 8601
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  result?: EnsembleTeamResult
}
```

### EnsembleTeamAgent

```typescript
{
  agentId: string
  program: string
  name: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string
  worktreeBranch?: string
}
```

### EnsembleTeamResult

```typescript
{
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}
```

### EnsembleMessage

```typescript
{
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: string
  timestamp: string // ISO 8601
}
```
