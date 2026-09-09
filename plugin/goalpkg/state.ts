import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type GoalStatus = "active" | "paused" | "complete" | "blocked"

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  turnCount: number
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "complete" || value === "blocked"
}

function isGoal(value: unknown): value is Goal {
  if (typeof value !== "object" || value === null) return false
  const goal = value as Record<string, unknown>
  return (
    typeof goal.sessionID === "string" &&
    typeof goal.objective === "string" &&
    isGoalStatus(goal.status) &&
    typeof goal.createdAt === "number" &&
    typeof goal.updatedAt === "number" &&
    typeof goal.turnCount === "number" &&
    Number.isInteger(goal.turnCount) &&
    goal.turnCount >= 0
  )
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
      if (!isGoal(value)) throw new Error(`Invalid goal state: ${path}`)
      return value
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
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
    }
    this.write(goal)
    return goal
  }

  setStatus(sessionID: string, status: GoalStatus): Goal | undefined {
    const goal = this.get(sessionID)
    if (!goal) return undefined
    goal.status = status
    goal.updatedAt = Date.now()
    this.write(goal)
    return goal
  }

  incrementTurn(sessionID: string): void {
    const goal = this.get(sessionID)
    if (!goal) return
    goal.turnCount += 1
    goal.updatedAt = Date.now()
    this.write(goal)
  }

  clear(sessionID: string): void {
    try {
      unlinkSync(this.path(sessionID))
    } catch (error) {
      if (!isENOENT(error)) throw error
    }
  }
}
