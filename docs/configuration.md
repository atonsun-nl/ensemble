---
title: Configuration
nav_order: 3
---

# Configuration

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server listening port |
| `ENSEMBLE_URL` | `http://localhost:23000` | CLI target URL |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data directory for team persistence |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Comma-separated allowed CORS origins |
| `ENSEMBLE_PROJECT` | auto-detect | Project name for summaries |
| `ENSEMBLE_AGENTS_CONFIG` | `./agents.json` | Path to custom agents config |
| `ENSEMBLE_AGENT_FLAGS` | — | Override agent CLI flags |
| `ENSEMBLE_WATCHDOG_NUDGE_MS` | `90000` | Time (ms) before idle agent nudge |
| `ENSEMBLE_WATCHDOG_STALL_MS` | `180000` | Time (ms) before stall detection |
| `ENSEMBLE_TELEGRAM_BOT_TOKEN` | — | Telegram bot token for notifications |
| `ENSEMBLE_TELEGRAM_CHAT_ID` | — | Telegram chat ID for notifications |
| `ENSEMBLE_CREATED_BY` | `$USER` | Creator ID for team metadata |

### Example `.env`

```bash
ENSEMBLE_PORT=23000
ENSEMBLE_TELEGRAM_BOT_TOKEN=123456:ABC-DEF
ENSEMBLE_TELEGRAM_CHAT_ID=your-chat-id
```

---

## Agent programs (agents.json)

The `agents.json` file defines which AI agents ensemble can spawn. Located in the project root by default, override with `ENSEMBLE_AGENTS_CONFIG`.

```json
{
  "codex": {
    "name": "codex",
    "command": "codex",
    "flags": ["--dangerously-bypass-approvals-and-sandbox"],
    "readyMarker": "›",
    "inputMethod": "pasteFromFile",
    "color": "blue",
    "icon": "◆"
  },
  "claude": {
    "name": "claude",
    "command": "claude",
    "flags": ["--permission-mode", "auto"],
    "readyMarker": "❯",
    "inputMethod": "sendKeys",
    "color": "green",
    "icon": "●"
  },
  "glm": {
    "name": "glm",
    "command": "glm",
    "flags": ["--permission-mode", "auto"],
    "readyMarker": "\u276f",
    "inputMethod": "sendKeys",
    "color": "magenta",
    "icon": "\u25c8"
  },
  "grok": {
    "name": "grok",
    "command": "grok",
    "flags": ["--always-approve", "--trust"],
    "readyMarker": "❯",
    "inputMethod": "pasteFromFile",
    "pasteEnterCount": 1,
    "color": "white",
    "icon": "✕"
  }
}
```

> **Model selection:** By default, each agent uses its own default model. To specify a model, add it to the `flags` array, e.g. `["--dangerously-bypass-approvals-and-sandbox", "-m", "o3"]` for Codex or `["--permission-mode", "auto", "--model", "sonnet"]` for Claude. Check each agent's docs for available models.
>
> **Codex users:** `--full-auto` was removed in Codex CLI 0.147.0. If you copied it from an older config, `codex exec` now exits with `unexpected argument '--full-auto' found`. Use `--sandbox workspace-write` for a sandboxed run, or the bypass flag above for the unattended one ensemble ships with.
```

### Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique identifier (used in API) |
| `command` | string | CLI command to launch the agent |
| `flags` | string[] | Default CLI arguments |
| `readyMarker` | string | Terminal prompt character (readiness detection) |
| `inputMethod` | `"pasteFromFile"` or `"sendKeys"` | How to deliver multi-line prompts |
| `pasteEnterCount` | `1` or `2` | Enter presses after local paste delivery (default `2`). Grok uses `1` to queue messages without cancelling its active turn. |
| `color` | string | Display color in TUI monitor |
| `icon` | string | Single character icon for TUI |

### Adding a custom agent

Any CLI tool that reads from stdin and writes to stdout can be an ensemble agent. Add it to `agents.json`:

```json
{
  "my-agent": {
    "name": "my-agent",
    "command": "/usr/local/bin/my-agent",
    "flags": ["--auto"],
    "readyMarker": ">",
    "inputMethod": "sendKeys",
    "color": "cyan",
    "icon": "▶"
  }
}
```

The agent must support `team-say` and `team-read` shell commands in its PATH for inter-agent communication.

For Grok, keep `pasteEnterCount: 1` in custom agent configurations. This
guards against extra Enter presses on the empty composer. Local paste
operations are serialized per pane. Managed teams use the inbox for ongoing
status and coordination messages. Attributing a Grok `send_now` event requires
a trace from the actual CLI.

### Supported agents

The default team is **Codex (lead) + Claude Code (worker)**. This is the fully tested combination.

| Agent | Status | Default? | Notes |
|---|---|---|---|
| **Codex** | Fully tested | Yes (lead) | Uses `pasteFromFile` and `--dangerously-bypass-approvals-and-sandbox --model gpt-6.1-sol --config model_reasoning_effort="high"` |
| **Claude Code** | Fully tested | Yes (worker) | Uses `sendKeys` input |
| **Grok CLI** | Tested in three-agent teams | No | Uses `pasteFromFile`, `--always-approve --trust --model grok-4.7 --effort xhigh --max-turns 30`. Needs `hints = { project_picker_disabled = true }` in `~/.grok/config.toml`, otherwise the agent hangs on a directory picker in a fresh pane. |
| **Antigravity CLI (`agy`)** | Configured | No | Uses `sendKeys`, `--dangerously-skip-permissions --model gemini-3.8-flash-high --effort high`, and unsets `GEMINI_API_KEY` and `GOOGLE_API_KEY` before launch. |
| **Gemini CLI** | Experimental | No | Uses `pasteFromFile`, `--yolo` flag. May stop responding due to free-tier rate limits or internal TUI issues. Use a paid API key (`gemini /auth`) for best results. |
| **GLM** | Tested in four-agent teams | No | Runs Claude Code against the Z.ai endpoint, so it behaves like `claude` (`sendKeys`, `--permission-mode auto`) with a GLM model underneath. Needs a `glm` command on PATH that sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. |
| **MiMo Code CLI** | Configured | No | `mimo`, `--trust --dangerously-skip-permissions`, file-based prompt delivery |
| **opencode** | Untested | No | Basic config included in `agents.json`, `sendKeys` input |
| **Any CLI tool** | Custom | No | See [Adding a custom agent](#adding-a-custom-agent) |

#### How to use a non-default agent

You don't need to change any config. Just tell ensemble which agents you want:

```bash
# Via collab-launch.sh (first agent = lead, rest = workers)
./scripts/collab-launch.sh "$(pwd)" "Security audit" codex,claude,agy

# Via /collab in Claude Code — name the agents in your prompt
/collab "Review auth with agy and claude"

# Via API — specify the agents array
```

### Input methods

- **`sendKeys`** — Types the prompt character by character into the tmux pane. Works with most agents. Simpler but slower for large prompts.
- **`pasteFromFile`** — Writes the prompt to a temp file and pastes it via tmux buffer. Faster for large prompts. Required by Codex and Gemini CLI.

---

## Collab templates (collab-templates.json)

Pre-defined team configurations for common tasks. Each template assigns specialized roles to the agents:

| Template | Description | Roles |
|---|---|---|
| `review` | Code Review | Reviewer + Critic |
| `implement` | Implementation | Architect + Developer |
| `research` | Research | Researcher-A + Researcher-B |
| `debug` | Debug | Reproducer + Analyst |

Use via API: `"templateName": "review"` in the create team request. The template assigns roles and focus areas automatically.

---

## Multi-host setup

Run agents on different machines. Configure in `~/.ensemble/hosts.json`:

```json
{
  "hosts": [
    {
      "id": "local",
      "name": "laptop",
      "url": "http://localhost:23000",
      "enabled": true
    },
    {
      "id": "gpu-server",
      "name": "Remote GPU",
      "url": "http://192.168.1.100:23000",
      "enabled": true
    }
  ]
}
```

Each host runs its own ensemble server. Agents specify `hostId` to control placement:

```json
{
  "agents": [
    { "program": "claude", "hostId": "local" },
    { "program": "codex", "hostId": "gpu-server" }
  ]
}
```

Host discovery order: exact hostname match → `"local"` keyword → IP match → URL match.

---

## Telegram notifications

Get notified when teams finish. Set up:

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get your chat ID (send `/start` to your bot, then check `https://api.telegram.org/bot<token>/getUpdates`)
3. Set environment variables:

```bash
export ENSEMBLE_TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export ENSEMBLE_TELEGRAM_CHAT_ID="your-chat-id"
```

Notifications include: team name, duration, message count, and a brief summary.

---

## Claude Code integration

Ensemble integrates with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a `/collab` slash command. This lets you type `/collab "review the auth module"` and Claude will spawn a Codex + Claude team, monitor their conversation, and present results — all without leaving your terminal.

### Quick setup (one command)

From the ensemble directory, run:

```bash
./scripts/setup-claude-code.sh
```

This automatically:
- Installs the `/collab` skill to `~/.claude/skills/collab/`
- Adds script permissions to `~/.claude/settings.json`
- Verifies all prerequisites (Node.js, tmux, Python, agent CLIs)
- Confirms everything is ready

### Manual setup

If you prefer to set things up manually:

**Step 1:** Copy the skill file:

```bash
mkdir -p ~/.claude/skills/collab
cp /path/to/ensemble/skill/SKILL.md ~/.claude/skills/collab/SKILL.md
```

**Step 2:** Add permissions to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(/path/to/ensemble/scripts/collab-launch.sh:*)",
      "Bash(/path/to/ensemble/scripts/collab-poll.sh:*)",
      "Bash(/path/to/ensemble/scripts/collab-status.sh:*)"
    ]
  }
}
```

Replace `/path/to/ensemble` with the actual path where you cloned the repo.

### Use it

In any Claude Code session:

```
/collab "Review the authentication module for security issues"
```

Claude Code will:
1. Start the ensemble server (if not running)
2. Spawn a Codex + Claude team
3. Show the agent conversation inline as it happens
4. Present a summary when the team finishes

You can also say things like "werk samen met Codex" or "start a collab team" — Claude Code recognizes these as triggers for the collab skill.

### How it works

The `/collab` skill tells Claude Code to:
1. Run `collab-launch.sh` to create the team
2. Poll `collab-poll.sh` for new messages every 15-30 seconds
3. Present each agent's messages as formatted dialogue
4. Clean up when the team finishes or is disbanded

In tmux, the TUI monitor opens in a split pane. Without tmux, messages are polled and displayed inline.

---

## Git worktrees (optional)

Each agent can work in an isolated git worktree:

```json
{
  "useWorktrees": true
}
```

When enabled:
- Each agent gets a separate branch (`team-{name}-{agent}`)
- Changes are automatically merged back on disband
- Prevents file conflicts between agents working on the same repo

---

## Security notes

Ensemble is designed for **local development use**. Be aware:

- No built-in API authentication (rate limiting by IP only)
- Agents run with permissive flags to support unattended execution
- Server binds to localhost by default
- Do **not** expose to the internet without adding authentication

For production use, consider running behind a reverse proxy with auth.

### Why agents need permissive flags

Ensemble agents run autonomously inside `tmux` sessions without a human at the terminal. The flags in `agents.json` remove interactive confirmation prompts so the agents can actually complete work:

| Flag | Agent | Purpose |
|---|---|---|
| `--permission-mode auto` | Claude Code | Allows tool execution, file edits, and shell commands without interactive permission prompts. |
| `--dangerously-bypass-approvals-and-sandbox` | Codex | Runs without approval prompts or sandbox. Replaces the `--full-auto` flag that Codex CLI removed in 0.147.0; the sandboxed equivalent is `--sandbox workspace-write`. |
| `--always-approve --trust` | Grok CLI | Skips per-action approval and the folder-trust dialog. |

These flags are acceptable in the ensemble context because:

- The server binds to `127.0.0.1` only
- Agents operate inside the working directory you specify
- Each team is isolated in its own `tmux` session
- You can monitor agent behavior live via the TUI and message feed

If you add custom agents, grant only the minimum flags required for autonomous operation.

`unsetEnv` is an optional array in each `agents.json` entry. Names must match
`[A-Z_][A-Z0-9_]*`; invalid entries reject the configuration. The spawner unsets
these variables after environment exports, including `agentEnv`, before launching
the CLI. For agy this prevents inherited API keys from selecting paid API tokens
instead of subscription authentication. Its trust prompt uses the existing startup
gate, which confirms the preselected "Yes, I trust this folder" option.


## Managed teams

For a team with multiple agents, Ensemble validates the configured local
executables before creating any panes. The Lead must pass CLI readiness and
receive its prompt. Worker CLIs can initialize while the Lead prepares its plan.
Ensemble releases worker prompts after acknowledging the Lead's plan. Workers
wait for file and task assignments and report their completed work for review.
Existing teams without a workflow record retain the exact one-time
`<<COLLAB_DONE>>` protocol.

Use `team-say <team-id> <actor> team '<<COLLAB_EVENT>> {"action":"…"}'`
to record a workflow action. The feed records accepted and rejected actions.

| Action | Actor | Required fields |
|---|---|---|
| `plan` | Lead | `plan` |
| `assign` | Lead | `task`, `owner`, `paths`. A conflicting takeover requires `takeover: true` and `reason`. |
| `release` | Lead | `task`, optionally `paths` |
| `block`, `unblock` | Team member | `reason` for `block`. The Lead can supply `owner` to clear a teammate's blocker. |
| `decision` | Lead | `decision` |
| `change` | Lead | `paths`, repository-relative `test`, `counterexample` |
| `submit` | Assigned agent or Lead | `report` |
| `accept` | Lead | The service runs the configured checks once assigned work has been submitted and blockers have cleared. Outside Git, a report-only task requires `analysisOnly: true` when no checks are configured. |
| `close` | Lead | `report`, after acceptance |
| `activity` | Team member | `state` (`busy` or `idle`), optional `tool` |

Use `team-read <team-id> <agent-name>` to read and acknowledge queued messages
at a safe point. `--wait` polls for up to 120 seconds. `--all` includes
previously read messages. Delivery records show when input was queued or read.
The service does not inject ordinary messages or watchdog nudges into managed
panes. An `activity` event is a cooperative report from the agent. It does
not trace internal CLI tool calls.

The assignment registry rejects overlapping paths, including directory/file
overlap. Keep claims through review so acceptance can verify that changed
paths have registered owners. Use `worktree: "team"` for a retained shared
review branch. For per-agent worktrees, integrate each branch into the review
branch and clean its worktree before acceptance. Managed teams retain all
worktrees for review. Agents with unrestricted shell access can bypass
coordination and write directly, so review the Git diff for ownership and
semantic conflicts.

### Acceptance checks

Set trusted commands in the server's Ensemble config file. Each check
receives argv directly and runs from the review worktree. Commands and
expected baseline failures come from operator configuration.

```json
{
  "acceptanceChecks": [
    { "command": "npm", "args": ["run", "typecheck"] },
    {
      "command": "bash",
      "args": ["tests/regression.sh"],
      "regression": true,
      "baselineFailure": "expected available timestamp"
    }
  ],
  "criticalPaths": ["src/labeling", "src/split.ts"],
  "allowAgentCommits": false
}
```

A regression check copies the first argument, its repository-relative test
entry point, into a detached baseline worktree. It requires exit code `1`
and the configured diagnostic there, then exit code `0` in the candidate.
Use a self-contained test entry point or keep its dependencies available on
both revisions. Changed critical paths require a Lead change request naming
a configured regression test and recording a counterexample. Accepting code
changes requires both registered path ownership and configured checks. The
service stores the baseline and candidate SHA, binary-capable Git diff,
untracked-file hashes, exit codes and stdout/stderr in an acceptance artifact.
Changes to the reviewed Git snapshot invalidate acceptance at close.

### Recovery and preflight

A service restart preserves active teams and their journals regardless of age.
A missing Lead aborts the run and preserves its worktree unless the service
can safely replace the Lead before dispatching work. Worker replacement stops
and verifies the previous session first, then transfers the open assignments
and decisions. Configure `replaceStalledAgents`, `maxReplacementsPerTeam` and
`fallbackOrder` to enable and bound replacement. Worker replacement preserves
uncommitted changes and requires a fresh submission for the new owner.

`maxTeamMinutes` and `maxIdleMinutes` are optional limits with a configurable
`graceMinutes` period. Use `ENSEMBLE_MAX_TEAM_MINUTES`,
`ENSEMBLE_MAX_IDLE_MINUTES` and `ENSEMBLE_GRACE_MINUTES` for environment overrides.

Codex preflight resolves the same executable and effective flags used for
launch. It checks the version, interactive flag parsing and local login
status. Set `codexSmokeCheck: true` or `ENSEMBLE_CODEX_SMOKE_CHECK=1` to verify
provider availability for the selected profile, model and reasoning effort.
That opt-in check invokes the model with the noninteractive CLI.

For strict startup on a remote host, the Maestro session status response
must report `exists: true`, a non-shell `foregroundCommand` and either
`ready: true` or `output` containing the agent's ready marker. A status response
that reports only session existence works with the explicit compatibility
setting `requireLeadReady: false`. Remote agents need access to the team feed
and a bridge or shared journal to publish events. Configure the bridge's
operator credentials separately from the agent environment. Validate remote
changes in the local review worktree before acceptance.
