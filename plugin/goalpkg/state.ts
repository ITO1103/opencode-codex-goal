import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "waiting"

export type GoalErrorKind =
  | "transport"
  | "api_retryable"
  | "api_non_retryable"
  | "authentication"
  | "context_overflow"
  | "aborted"
  | "model_turn"
  | "no_progress"
  | "unknown"

export const MAX_CONSECUTIVE_FAILURES = 3
export const MAX_NO_PROGRESS_FAILURES = 2
export const RETRY_BASE_DELAY_MS = 1_000
export const RETRY_MAX_DELAY_MS = 30_000

export function retryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1)
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS)
}

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  turnCount: number
  consecutiveFailures: number
  lastErrorKind: GoalErrorKind | null
  lastErrorMessage: string | null
  lastErrorAt: number | null
  nextRetryAt: number | null
  lastSuccessfulTurn: number
  lastProgressAt: number | null
  lastProgressKind: string | null
  waitingForCompaction: boolean
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "complete" || value === "blocked" || value === "waiting"
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value))
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function normalizeGoal(value: unknown): Goal | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const goal = value as Record<string, unknown>
  if (
    typeof goal.sessionID !== "string" ||
    typeof goal.objective !== "string" ||
    !isGoalStatus(goal.status) ||
    typeof goal.createdAt !== "number" ||
    !Number.isFinite(goal.createdAt) ||
    typeof goal.updatedAt !== "number" ||
    !Number.isFinite(goal.updatedAt) ||
    typeof goal.turnCount !== "number" ||
    !Number.isInteger(goal.turnCount) ||
    goal.turnCount < 0
  ) {
    return undefined
  }

  // The defaults keep state files written by pre-waiting releases readable.
  const consecutiveFailures = goal.consecutiveFailures ?? 0
  const lastErrorKind = goal.lastErrorKind ?? null
  const lastErrorMessage = goal.lastErrorMessage ?? null
  const lastErrorAt = goal.lastErrorAt ?? null
  const nextRetryAt = goal.nextRetryAt ?? null
  const lastSuccessfulTurn = goal.lastSuccessfulTurn ?? goal.turnCount
  const lastProgressAt = goal.lastProgressAt ?? null
  const lastProgressKind = goal.lastProgressKind ?? null
  const waitingForCompaction = goal.waitingForCompaction ?? false

  if (
    typeof consecutiveFailures !== "number" ||
    !Number.isInteger(consecutiveFailures) ||
    consecutiveFailures < 0 ||
    !isNullableString(lastErrorKind) ||
    !isNullableString(lastErrorMessage) ||
    !isNullableNumber(lastErrorAt) ||
    !isNullableNumber(nextRetryAt) ||
    typeof lastSuccessfulTurn !== "number" ||
    !Number.isInteger(lastSuccessfulTurn) ||
    lastSuccessfulTurn < 0 ||
    !isNullableNumber(lastProgressAt) ||
    !isNullableString(lastProgressKind) ||
    typeof waitingForCompaction !== "boolean"
  ) {
    return undefined
  }

  return {
    sessionID: goal.sessionID,
    objective: goal.objective,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    turnCount: goal.turnCount,
    consecutiveFailures,
    lastErrorKind: lastErrorKind as GoalErrorKind | null,
    lastErrorMessage,
    lastErrorAt,
    nextRetryAt,
    lastSuccessfulTurn,
    lastProgressAt,
    lastProgressKind,
    waitingForCompaction,
  }
}

function isENOENT(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
}

export class GoalStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  private path(sessionID: string): string {
    return join(this.dir, `${sessionID}.json`)
  }

  get(sessionID: string): Goal | undefined {
    try {
      const path = this.path(sessionID)
      const value: unknown = JSON.parse(readFileSync(path, "utf8"))
      const goal = normalizeGoal(value)
      if (!goal) throw new Error(`Invalid goal state: ${path}`)
      return goal
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  list(): Goal[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.get(name.slice(0, -5)))
      .filter((goal): goal is Goal => goal !== undefined)
  }

  private write(goal: Goal): void {
    const target = this.path(goal.sessionID)
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(temporary, JSON.stringify(goal, null, 2))
    renameSync(temporary, target)
  }

  set(sessionID: string, objective: string): Goal {
    const now = Date.now()
    const goal: Goal = {
      sessionID,
      objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      consecutiveFailures: 0,
      lastErrorKind: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      nextRetryAt: null,
      lastSuccessfulTurn: 0,
      lastProgressAt: null,
      lastProgressKind: null,
      waitingForCompaction: false,
    }
    this.write(goal)
    return goal
  }

  setStatus(sessionID: string, status: GoalStatus): Goal | undefined {
    const goal = this.get(sessionID)
    if (!goal) return undefined
    goal.status = status
    if (status !== "active") goal.nextRetryAt = null
    if (status !== "waiting") goal.waitingForCompaction = false
    goal.updatedAt = Date.now()
    this.write(goal)
    return goal
  }

  resume(sessionID: string): Goal | undefined {
    const goal = this.get(sessionID)
    if (!goal) return undefined
    goal.status = "active"
    goal.consecutiveFailures = 0
    goal.lastErrorKind = null
    goal.lastErrorMessage = null
    goal.lastErrorAt = null
    goal.nextRetryAt = null
    goal.waitingForCompaction = false
    goal.updatedAt = Date.now()
    this.write(goal)
    return goal
  }

  recordSuccessfulTurn(sessionID: string): Goal | undefined {
    const goal = this.get(sessionID)
    if (!goal || goal.status !== "active") return undefined
    goal.turnCount += 1
    goal.lastSuccessfulTurn = goal.turnCount
    goal.consecutiveFailures = 0
    goal.lastErrorKind = null
    goal.lastErrorMessage = null
    goal.lastErrorAt = null
    goal.nextRetryAt = null
    goal.waitingForCompaction = false
    goal.lastProgressAt = Date.now()
    goal.lastProgressKind = "turn.success"
    goal.updatedAt = Date.now()
    this.write(goal)
    return goal
  }

  recordFailure(sessionID: string, kind: GoalErrorKind, message: string, retryable = true): Goal | undefined {
    const goal = this.get(sessionID)
    if (!goal || goal.status !== "active") return undefined

    const now = Date.now()
    const sameFailureWithoutProgress =
      goal.lastErrorKind === kind &&
      goal.lastErrorMessage === message &&
      goal.lastErrorAt !== null &&
      (goal.lastProgressAt === null || goal.lastProgressAt <= goal.lastErrorAt)
    goal.consecutiveFailures += 1
    goal.lastErrorKind = kind
    goal.lastErrorMessage = message.slice(0, 1_000)
    goal.lastErrorAt = now

    if (kind === "model_turn") {
      goal.status = "blocked"
      goal.nextRetryAt = null
      goal.waitingForCompaction = false
    } else if (kind === "context_overflow") {
      goal.status = "waiting"
      goal.nextRetryAt = null
      goal.waitingForCompaction = true
    } else if (
      !retryable ||
      goal.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ||
      (sameFailureWithoutProgress && goal.consecutiveFailures >= MAX_NO_PROGRESS_FAILURES)
    ) {
      goal.status = "waiting"
      goal.nextRetryAt = null
      goal.waitingForCompaction = false
    } else {
      goal.nextRetryAt = now + retryDelayMs(goal.consecutiveFailures)
    }
    goal.updatedAt = now
    this.write(goal)
    return goal
  }

  recordProgress(sessionID: string, kind: string): Goal | undefined {
    const goal = this.get(sessionID)
    if (!goal || goal.status !== "active") return undefined
    const now = Date.now()
    goal.consecutiveFailures = 0
    goal.lastErrorKind = null
    goal.lastErrorMessage = null
    goal.lastErrorAt = null
    goal.nextRetryAt = null
    goal.lastProgressAt = now
    goal.lastProgressKind = kind
    goal.updatedAt = now
    this.write(goal)
    return goal
  }

  finishCompaction(sessionID: string): Goal | undefined {
    const goal = this.get(sessionID)
    if (!goal || !goal.waitingForCompaction) return goal
    goal.status = "active"
    goal.waitingForCompaction = false
    goal.consecutiveFailures = 0
    goal.nextRetryAt = null
    goal.lastProgressAt = Date.now()
    goal.lastProgressKind = "compaction"
    goal.updatedAt = Date.now()
    this.write(goal)
    return goal
  }

  clear(sessionID: string): void {
    try {
      unlinkSync(this.path(sessionID))
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
  }
}
