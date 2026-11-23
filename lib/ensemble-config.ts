import fs from 'fs'
import os from 'os'
import path from 'path'

export interface EnsembleConfig {
  alertHubUrl: string
  rosterCommand?: string
  planCommand?: string
  eventsCommand?: string
  replaceStalledAgents?: boolean
  maxReplacementsPerTeam?: number
  healthCommand?: string
  codexSmokeCheck?: boolean
  acceptanceChecks?: Array<{ command: string; args: string[]; regression?: boolean; baselineFailure?: string }>
  criticalPaths?: string[]
  allowAgentCommits?: boolean
  fallbackOrder: string[]
  maxTeamMinutes?: number
  maxIdleMinutes?: number
  graceMinutes: number
  agentEnv?: Record<string, string>
  taskPreamble?: string
}

let invalidConfigWarning: { path: string; signature: string } | undefined
let invalidFallbackWarning: string | undefined
let invalidAgentEnvWarning: string | undefined

/** Shared configuration for the service and script entry points. */
export function readEnsembleConfig(): EnsembleConfig {
  let file: Record<string, unknown> = {}
  const configPath = process.env.ENSEMBLE_CONFIG || path.join(os.homedir(), '.config/ensemble/config.json')
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
    file = parsed as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      let signature = ''
      try {
        const stat = fs.statSync(configPath)
        signature = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      } catch { /* File disappeared after reading. */ }
      if (!invalidConfigWarning || invalidConfigWarning.path !== configPath || invalidConfigWarning.signature !== signature) {
        console.warn('[Ensemble] Invalid configuration; using defaults and environment overrides')
        invalidConfigWarning = { path: configPath, signature }
      }
    }
  }
  const value = (key: string, env: string): unknown => process.env[env]?.trim() ? process.env[env] : file[key]
  const config: EnsembleConfig = { fallbackOrder: ['codex', 'claude', 'glm', 'grok', 'agy', 'gemini'], graceMinutes: 3, alertHubUrl: '' }
  const alertHubUrl = process.env.ENSEMBLE_ALERT_HUB_URL ?? file.alertHubUrl
  if (typeof alertHubUrl === 'string') config.alertHubUrl = alertHubUrl.trim()
  const replaceOverride = process.env.ENSEMBLE_REPLACE_STALLED?.trim()
  config.replaceStalledAgents = replaceOverride ? /^(true|1)$/i.test(replaceOverride) : file.replaceStalledAgents === true
  config.maxReplacementsPerTeam = typeof file.maxReplacementsPerTeam === 'number' && Number.isInteger(file.maxReplacementsPerTeam) && file.maxReplacementsPerTeam >= 0 ? file.maxReplacementsPerTeam : 2
  for (const [key, env] of [['rosterCommand', 'ENSEMBLE_ROSTER_CMD'], ['planCommand', 'ENSEMBLE_PLAN_CMD'], ['eventsCommand', 'ENSEMBLE_EVENTS_CMD']] as const) {
    const command = value(key, env)
    if (typeof command === 'string' && command.trim()) config[key] = command
  }
  if (/^(1|true)$/i.test(String(value('codexSmokeCheck', 'ENSEMBLE_CODEX_SMOKE_CHECK')))) config.codexSmokeCheck = true
  if (file.allowAgentCommits === true) config.allowAgentCommits = true
  if (Array.isArray(file.criticalPaths)) config.criticalPaths = file.criticalPaths.filter((item): item is string => typeof item === 'string')
  if (Array.isArray(file.acceptanceChecks)) {
    config.acceptanceChecks = file.acceptanceChecks.map(entry => {
      if (!entry || typeof entry.command !== 'string' || !entry.command || !Array.isArray(entry.args) ||
          !entry.args.every((arg: unknown) => typeof arg === 'string')) throw new Error('Invalid acceptanceChecks entry')
      if (entry.regression === true && (typeof entry.baselineFailure !== 'string' || !entry.baselineFailure.trim())) {
        throw new Error('Regression checks require a baselineFailure substring')
      }
      return { command: entry.command, args: entry.args, regression: entry.regression === true, baselineFailure: entry.baselineFailure }
    })
  }
  const health = value('healthCommand', 'ENSEMBLE_HEALTH_CMD')
  const preamble = value('taskPreamble', 'ENSEMBLE_TASK_PREAMBLE')
  if (typeof health === 'string' && health.trim()) config.healthCommand = health
  if (typeof preamble === 'string' && preamble) config.taskPreamble = preamble
  if (file.agentEnv !== undefined) {
    const raw = file.agentEnv
    const invalidNames: string[] = []
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      config.agentEnv = {}
      for (const [name, entry] of Object.entries(raw)) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(name) && typeof entry === 'string' && !/[\r\n]/.test(entry)) {
          config.agentEnv[name] = entry
        } else invalidNames.push(name)
      }
    } else invalidNames.push('agentEnv')
    if (invalidNames.length) {
      let signature = ''
      try {
        const stat = fs.statSync(configPath)
        signature = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
      } catch { /* File disappeared after reading. */ }
      const warningKey = JSON.stringify([configPath, signature, invalidNames, Array.isArray(raw) ? 'array' : typeof raw])
      if (invalidAgentEnvWarning !== warningKey) {
        console.warn(`[Ensemble] Ignoring invalid agentEnv entries: ${invalidNames.map(name => JSON.stringify(name)).join(', ')}`)
        invalidAgentEnvWarning = warningKey
      }
    } else invalidAgentEnvWarning = undefined
  }
  const rawOrder = process.env.ENSEMBLE_FALLBACK_ORDER
  const order = rawOrder?.trim() ? rawOrder.split(',').map(s => s.trim()) : file.fallbackOrder
  if (Array.isArray(order) && order.length && order.every(s => typeof s === 'string' && /^[a-zA-Z0-9_-]+$/.test(s))) config.fallbackOrder = [...new Set(order)]
  else if (rawOrder?.trim() && invalidFallbackWarning !== rawOrder) {
    console.warn('[Ensemble] Invalid ENSEMBLE_FALLBACK_ORDER; using configured fallback order')
    invalidFallbackWarning = rawOrder
  }
  if (rawOrder?.trim() && !(Array.isArray(order) && order.every((s: unknown) => typeof s === 'string' && /^[a-zA-Z0-9_-]+$/.test(s)))) {
    const fileOrder = file.fallbackOrder
    if (Array.isArray(fileOrder) && fileOrder.length && fileOrder.every(s => typeof s === 'string' && /^[a-zA-Z0-9_-]+$/.test(s))) config.fallbackOrder = [...new Set(fileOrder)]
  }
  for (const [key, env] of [['maxTeamMinutes', 'ENSEMBLE_MAX_TEAM_MINUTES'], ['maxIdleMinutes', 'ENSEMBLE_MAX_IDLE_MINUTES'], ['graceMinutes', 'ENSEMBLE_GRACE_MINUTES']] as const) {
    const raw = value(key, env)
    const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
    if (Number.isFinite(number) && (key === 'graceMinutes' ? number >= 0 : number > 0)) config[key] = number
  }
  return config
}
