import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"
import type { TextPartInput } from "@opencode-ai/sdk"
import { join } from "node:path"
import { GoalStore, type Goal } from "./state.ts"
import { parseGoalArgs } from "./verbs.ts"
import { renderGoalSystem, CONTINUE_NUDGE } from "./prompt.ts"
import { makeGoalTools } from "./tools.ts"

const MODEL_TURN_ERROR_NAMES = new Set(["UnknownError", "MessageOutputLengthError"])
const TRANSPORT_ERROR_NAMES = new Set(["MessageAbortedError"])
const TRANSPORT_MSG_RE =
  /econnrefused|econnreset|epipe|fetch failed|socket hang up|network|disposed|dispose|aborted|abort|timed?\s?out|instance.*(gone|dispose)/i

function resolveStateDir(input: PluginInput): string {
  return join(input.directory || input.worktree || process.cwd(), ".opencode", "goal")
}

function errorName(error: unknown): string | undefined {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name
    return typeof name === "string" ? name : undefined
  }
  return undefined
}

function errorMessage(error: unknown): string {
  if (!error) return ""
  if (typeof error === "string") return error
  if (typeof error === "object") {
    const value = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof value.message === "string") return value.message
    if (typeof value.data?.message === "string") return value.data.message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

// Only confirmed model/turn failures stop an uncapped goal. Infrastructure,
// authentication, abort, and unknown errors leave the goal active so the user
// can resume it after the underlying problem is fixed.
export function isModelTurnError(error: unknown): boolean {
  if (!error) return false
  const name = errorName(error)
  if (name && TRANSPORT_ERROR_NAMES.has(name)) return false
  if (TRANSPORT_MSG_RE.test(errorMessage(error))) return false
  return name !== undefined && MODEL_TURN_ERROR_NAMES.has(name)
}

type CommandBeforeOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1]

function setParts(output: CommandBeforeOutput, text: string): void {
  const part: TextPartInput = { type: "text", text }
  output.parts.length = 0
  // The command hook receives server-side Part values, while it is valid to
  // provide a text-part input here. The assertion is limited to this boundary.
  output.parts.push(part as CommandBeforeOutput["parts"][number])
}

function viewText(goal: Goal | undefined): string {
  if (!goal) return "No goal set for this session. Use `/goal <objective>` to start one."
  return `Goal [${goal.status}] (turn ${goal.turnCount}): ${goal.objective}`
}

export const GoalPlugin: Plugin = async (input): Promise<Hooks> => {
  const store = new GoalStore(resolveStateDir(input))
  const client = input.client

  return {
    tool: makeGoalTools(store),

    "command.execute.before": async (command, output) => {
      if (command.command !== "goal") return

      const sessionID = command.sessionID
      const action = parseGoalArgs(command.arguments ?? "")
      switch (action.kind) {
        case "set":
          store.set(sessionID, action.objective)
          setParts(output, CONTINUE_NUDGE)
          return
        case "pause":
          if (!store.get(sessionID)) {
            setParts(output, "No goal set for this session.")
            return
          }
          store.setStatus(sessionID, "paused")
          setParts(
            output,
            "[goal] paused — automatic continuations stopped; the objective is preserved. `/goal resume` to continue.",
          )
          return
        case "resume": {
          const existing = store.get(sessionID)
          if (!existing) {
            setParts(output, "No goal set for this session.")
            return
          }
          const wasComplete = existing.status === "complete"
          store.setStatus(sessionID, "active")
          setParts(
            output,
            wasComplete
              ? "[goal] resumed — re-opening a completed goal; the continuation loop restarts."
              : "[goal] resumed.",
          )
          return
        }
        case "clear":
          if (!store.get(sessionID)) {
            setParts(output, "No goal set for this session.")
            return
          }
          store.clear(sessionID)
          setParts(output, "[goal] cleared.")
          return
        case "view":
          setParts(output, viewText(store.get(sessionID)))
          return
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID) return
      const goal = store.get(sessionID)
      if (!goal || goal.status !== "active") return

      const block = renderGoalSystem(goal)
      // Some Qwen-compatible templates accept exactly one system message and
      // require it at index 0. Merge into the leading message instead of
      // appending a second system message.
      if (output.system.length === 0) {
        output.system.push(block)
      } else {
        output.system[0] = `${output.system[0]}\n\n${block}`
      }
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.idle") {
          const sessionID = event.properties.sessionID
          const goal = store.get(sessionID)
          if (!goal || goal.status !== "active") return

          // There is intentionally no numeric cap or in-flight mutex. Each idle
          // event advances one turn until the goal reaches a terminal status.
          store.incrementTurn(sessionID)
          let response: Awaited<ReturnType<typeof client.session.prompt>>
          try {
            response = await client.session.prompt({
              path: { id: sessionID },
              body: { parts: [{ type: "text", text: CONTINUE_NUDGE }] },
            })
          } catch {
            return
          }

          if ("error" in response && response.error && isModelTurnError(response.error)) {
            store.setStatus(sessionID, "blocked")
          }
          return
        }

        if (event.type === "session.error") {
          const sessionID = event.properties.sessionID
          if (!sessionID) return
          const goal = store.get(sessionID)
          if (!goal || goal.status !== "active") return
          if (isModelTurnError(event.properties.error)) {
            store.setStatus(sessionID, "blocked")
          }
        }
      } catch {
        // A storage or lifecycle error must not turn a recoverable goal into a
        // blocked one or break the host event loop.
      }
    },
  }
}
