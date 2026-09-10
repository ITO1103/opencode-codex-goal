import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { GoalStore } from "./state.ts"

export function makeGoalTools(store: GoalStore): Record<string, ToolDefinition> {
  return {
    goal_checkpoint: tool({
      description:
        "Record a concrete progress checkpoint for the active goal without completing it. " +
        "Use this after a meaningful tool result, file change, or verified intermediate milestone.",
      args: {
        summary: tool.schema
          .string()
          .describe("Short description of the concrete progress made."),
      },
      async execute(args, context) {
        const goal = store.get(context.sessionID)
        if (!goal || goal.status !== "active") return "No active goal for this checkpoint."
        store.recordProgress(context.sessionID, "goal_checkpoint")
        return `Goal checkpoint recorded: ${args.summary}`
      },
    }),
    goal_complete: tool({
      description:
        "Declare the active goal complete. Only call this after the completion audit " +
        "proves every requirement is satisfied against current state. See the injected " +
        "goal system block for the audit you must pass first.",
      args: {
        summary: tool.schema
          .string()
          .optional()
          .describe("Optional short summary of what was accomplished."),
      },
      async execute(args, context) {
        const goal = store.get(context.sessionID)
        if (!goal || goal.status !== "active") return "No active goal to complete."
        store.setStatus(context.sessionID, "complete")
        return args.summary
          ? `Goal marked complete: ${args.summary}`
          : "Goal marked complete."
      },
    }),
    goal_blocked: tool({
      description:
        "Declare the active goal blocked. Only call this when the strict blocked audit " +
        "in the injected goal system block is satisfied (the same blocker has recurred " +
        "across turns and you cannot make meaningful progress without user input).",
      args: {
        reason: tool.schema
          .string()
          .describe("Why the goal is blocked and what is needed to unblock it."),
      },
      async execute(args, context) {
        const goal = store.get(context.sessionID)
        if (!goal || goal.status !== "active") return "No active goal to block."
        store.setStatus(context.sessionID, "blocked")
        return `Goal marked blocked: ${args.reason}`
      },
    }),
  }
}
