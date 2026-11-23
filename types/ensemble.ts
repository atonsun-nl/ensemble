export interface EnsembleTeam {
  id: string
  name: string
  description: string
  templateName?: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  worktree?: 'team'
  worktreePath?: string
  worktreeBranch?: string
  replacementCount?: number
  pendingReplacement?: { oldAgent: string; sessionName: string; hostId: string; agentId?: string }
  workflow?: ManagedWorkflow
  failureReason?: string
  result?: EnsembleTeamResult
}

export interface EnsembleTeamAgent {
  startedAt?: string
  sessionName?: string
  startup?: 'session_created' | 'cli_ready' | 'prompt_delivered'
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed' | 'replaced'
  worktreePath?: string
  worktreeBranch?: string
}

export interface EnsembleTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}

export interface EnsembleMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: 'chat' | 'decision' | 'question' | 'result'
  timestamp: string
  options?: string[]
  delivery?: Array<{ recipient: string; status: 'queued' | 'delivered' | 'failed'; at: string; method: 'pull' | 'pane'; reason?: string }>
  priority?: 'normal' | 'urgent'
}

export interface CreateTeamRequest {
  name: string
  description: string
  agents?: Array<{
    program: string
    role?: string
    hostId?: string
  }>
  feedMode?: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  templateName?: string
  worktree?: 'team'
  useWorktrees?: boolean
  staged?: boolean
  requireLeadReady?: boolean
  stagedConfig?: StagedWorkflowConfig
}

export type StagedPhase = 'plan' | 'exec' | 'verify'

export interface StagedWorkflowConfig {
  planTimeoutMs?: number   // Max time for PLAN phase before failing closed (default: 120000 = 2min)
  execTimeoutMs?: number   // Max time for EXEC phase before failing closed (default: 300000 = 5min)
  verifyTimeoutMs?: number // Max time for VERIFY phase before completing (default: 120000 = 2min)
  pollIntervalMs?: number  // How often to check for phase completion (default: 5000 = 5s)
}

export interface CollabTemplateRole {
  role: string
  focus: string
}

export interface CollabTemplate {
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: CollabTemplateRole[]
}

export interface CollabTemplatesFile {
  templates: Record<string, CollabTemplate>
}

export interface ManagedWorkflow {
  state: 'STARTING' | 'WAITING_PLAN' | 'WORKING' | 'BLOCKED' | 'REVIEW' | 'ACCEPTED' | 'DONE'
  requireLeadReady: boolean
  lead: string
  startupDeadline: string
  plan?: string
  baseline?: string
  fileOwners: Record<string, string>
  taskOwners: Record<string, string>
  submitted: Record<string, string>
  blockers: Record<string, string>
  decisions: string[]
  approvedChanges: Array<{ paths: string[]; test: string; counterexample: string }>
  handled: string[]
  acceptance?: { head: string; diff: string; digest: string; passed: boolean; artifact: string }
  report?: string
  staged?: boolean
  phaseDeadline?: string
  stagedConfig?: StagedWorkflowConfig
  activity?: Record<string, { state: 'idle' | 'busy'; at: string; tool?: string }>
}
