export type GoalAction =
  | { kind: "view" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "set"; objective: string }

const CONTROL_VERBS = new Set(["pause", "resume", "clear"] as const)

export function parseGoalArgs(args: string): GoalAction {
  const trimmed = args.trim()
  if (trimmed === "") return { kind: "view" }

  const lowered = trimmed.toLowerCase()
  if (!/\s/.test(trimmed) && CONTROL_VERBS.has(lowered as "pause" | "resume" | "clear")) {
    return { kind: lowered as "pause" | "resume" | "clear" }
  }

  return { kind: "set", objective: trimmed }
}
