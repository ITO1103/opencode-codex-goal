import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"
import type { TextPartInput } from "@opencode-ai/sdk"
import { join } from "node:path"
import { GoalStore, type Goal, type GoalErrorKind } from "./state.ts"
import { parseGoalArgs } from "./verbs.ts"
import { renderGoalSystem, CONTINUE_NUDGE } from "./prompt.ts"
import { makeGoalTools } from "./tools.ts"

const MODEL_TURN_ERROR_NAMES = new Set(["UnknownError", "MessageOutputLengthError"])
const AUTH_ERROR_NAMES = new Set(["ProviderAuthError", "AuthenticationError", "UnauthorizedError"])
const ABORT_ERROR_NAMES = new Set(["MessageAbortedError", "AbortError"])
const TRANSPORT_ERROR_NAMES = new Set(["NetworkError", "FetchError", "TimeoutError", "ConnectionError"])
const TRANSPORT_MSG_RE =
  /econnrefused|econnreset|etimedout|eai_again|epipe|und_err_|fetch failed|socket hang up|network|disposed|dispose|read timed?\s?out|sse.*timed?\s?out|instance.*(gone|dispose)/i
const CONTEXT_MSG_RE =
  /context.{0,30}(overflow|length|window|limit)|too many tokens|maximum context|prompt.{0,20}(too long|token)|token.{0,20}(limit|exceed)|exceed.{0,20}(context|token)/i

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

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as { code?: unknown; cause?: { code?: unknown } }
  if (typeof value.code === "string") return value.code
  return typeof value.cause?.code === "string" ? value.cause.code : undefined
}

function isRetryableFlag(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as { isRetryable?: unknown; data?: { isRetryable?: unknown } }
  if (typeof value.data?.isRetryable === "boolean") return value.data.isRetryable
  return typeof value.isRetryable === "boolean" ? value.isRetryable : undefined
}

function hasTransportSignal(error: unknown): boolean {
  const name = errorName(error)
  const code = errorCode(error)
  return (
    (name !== undefined && TRANSPORT_ERROR_NAMES.has(name)) ||
    (code !== undefined && TRANSPORT_MSG_RE.test(code)) ||
    TRANSPORT_MSG_RE.test(errorMessage(error))
  )
}

function isContextOverflow(error: unknown): boolean {
  const name = errorName(error)
  return name === "ContextOverflowError" || CONTEXT_MSG_RE.test(errorMessage(error))
}

export function classifyGoalError(error: unknown): GoalErrorKind {
  if (!error) return "unknown"
  const name = errorName(error)
  const message = errorMessage(error)

  if (isContextOverflow(error)) return "context_overflow"
  if (name !== undefined && AUTH_ERROR_NAMES.has(name)) return "authentication"
  if ((name !== undefined && ABORT_ERROR_NAMES.has(name)) || /\babort(?:ed)?\b/i.test(message)) return "aborted"
  if (hasTransportSignal(error)) return "transport"
  if (isRetryableFlag(error) === true) return "api_retryable"
  if (name !== undefined && MODEL_TURN_ERROR_NAMES.has(name)) return "model_turn"
  if (name === "APIError") return "api_non_retryable"
  return "unknown"
}

// Kept as a small compatibility helper for callers that only need to know
// whether an error is a confirmed model/turn failure.
export function isModelTurnError(error: unknown): boolean {
  return classifyGoalError(error) === "model_turn"
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
  const retry = goal.nextRetryAt ? `; next retry ${new Date(goal.nextRetryAt).toISOString()}` : ""
  const error = goal.lastErrorKind ? `; last error ${goal.lastErrorKind}` : ""
  return `Goal [${goal.status}] (turn ${goal.turnCount}): ${goal.objective}${retry}${error}`
}

type RuntimeSessionStatus = "idle" | "retry" | "busy"
type ContinuationAttempt = { handled: boolean; idleObserved: boolean }
type RetryTimer = ReturnType<typeof setTimeout>

export const GoalPlugin: Plugin = async (input): Promise<Hooks> => {
  const store = new GoalStore(resolveStateDir(input))
  const client = input.client
  const sessionStatuses = new Map<string, RuntimeSessionStatus>()
  const compactingSessions = new Set<string>()
  const inFlight = new Map<string, ContinuationAttempt>()
  const retryTimers = new Map<string, RetryTimer>()
  const recentErrors = new Map<string, { kind: GoalErrorKind; message: string; at: number }>()

  function clearRetryTimer(sessionID: string): void {
    const timer = retryTimers.get(sessionID)
    if (!timer) return
    clearTimeout(timer)
    retryTimers.delete(sessionID)
  }

  function invalidateAttempt(sessionID: string): void {
    const attempt = inFlight.get(sessionID)
    if (attempt) attempt.handled = true
  }

  function scheduleRetry(sessionID: string, nextRetryAt: number): void {
    clearRetryTimer(sessionID)
    const delay = Math.max(0, nextRetryAt - Date.now())
    const timer = setTimeout(() => {
      retryTimers.delete(sessionID)
      void runContinuation(sessionID)
    }, delay)
    timer.unref?.()
    retryTimers.set(sessionID, timer)
  }

  function handleError(sessionID: string, error: unknown, attempt?: ContinuationAttempt): void {
    if (attempt?.handled) return
    if (attempt) attempt.handled = true

    const kind = classifyGoalError(error)
    const message = errorMessage(error)
    const now = Date.now()
    const recent = recentErrors.get(sessionID)
    if (!attempt && recent && recent.kind === kind && recent.message === message && now - recent.at < 500) return
    recentErrors.set(sessionID, { kind, message, at: now })

    const retryable = kind === "transport" || kind === "api_retryable" || kind === "aborted"
    const updated = store.recordFailure(sessionID, kind, message, retryable)
    if (!updated || updated.status !== "active" || updated.nextRetryAt === null) {
      clearRetryTimer(sessionID)
      return
    }
    scheduleRetry(sessionID, updated.nextRetryAt)
  }

  async function runContinuation(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID) || compactingSessions.has(sessionID)) return

    const goal = store.get(sessionID)
    if (!goal || goal.status !== "active") return

    const runtimeStatus = sessionStatuses.get(sessionID)
    if (runtimeStatus === "busy" || runtimeStatus === "retry") return

    if (goal.nextRetryAt !== null && goal.nextRetryAt > Date.now()) {
      scheduleRetry(sessionID, goal.nextRetryAt)
      return
    }

    const attempt: ContinuationAttempt = { handled: false, idleObserved: false }
    let continueAfterSuccess = false
    inFlight.set(sessionID, attempt)
    try {
      let response: Awaited<ReturnType<typeof client.session.prompt>>
      try {
        response = await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: CONTINUE_NUDGE }] },
        })
      } catch (error) {
        handleError(sessionID, error, attempt)
        return
      }

      if (attempt.handled) return
      const responseError =
        response && typeof response === "object" && "error" in response
          ? (response as { error?: unknown }).error
          : undefined
      if (responseError) {
        handleError(sessionID, responseError, attempt)
      } else {
        const updated = store.recordSuccessfulTurn(sessionID)
        clearRetryTimer(sessionID)
        continueAfterSuccess =
          attempt.idleObserved &&
          updated?.status === "active" &&
          updated.nextRetryAt === null &&
          !updated.waitingForCompaction
      }
    } catch {
      // A storage or lifecycle error must not break the host event loop.
    } finally {
      inFlight.delete(sessionID)
    }

    if (continueAfterSuccess) queueMicrotask(() => void runContinuation(sessionID))
  }

  return {
    dispose: async () => {
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
    },
    tool: makeGoalTools(store),

    "command.execute.before": async (command, output) => {
      if (command.command !== "goal") return

      const sessionID = command.sessionID
      const action = parseGoalArgs(command.arguments ?? "")
      switch (action.kind) {
        case "set":
          invalidateAttempt(sessionID)
          clearRetryTimer(sessionID)
          store.set(sessionID, action.objective)
          setParts(output, CONTINUE_NUDGE)
          return
        case "pause":
          if (!store.get(sessionID)) {
            setParts(output, "No goal set for this session.")
            return
          }
          invalidateAttempt(sessionID)
          clearRetryTimer(sessionID)
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
          invalidateAttempt(sessionID)
          clearRetryTimer(sessionID)
          store.resume(sessionID)
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
          invalidateAttempt(sessionID)
          clearRetryTimer(sessionID)
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
        if (event.type === "session.status") {
          const sessionID = event.properties.sessionID
          sessionStatuses.set(sessionID, event.properties.status.type)
          return
        }

        if (event.type === "session.idle") {
          const attempt = inFlight.get(event.properties.sessionID)
          if (attempt) {
            attempt.idleObserved = true
            return
          }
          await runContinuation(event.properties.sessionID)
          return
        }

        if (event.type === "session.compacted") {
          const sessionID = event.properties.sessionID
          compactingSessions.delete(sessionID)
          store.finishCompaction(sessionID)
          return
        }

        if (event.type === "session.error") {
          const sessionID = event.properties.sessionID
          if (!sessionID || !event.properties.error) return
          handleError(sessionID, event.properties.error, inFlight.get(sessionID))
          return
        }

        if (event.type === "message.part.updated") {
          const part = event.properties.part
          if (part.type === "tool" && part.state.status === "completed") {
            store.recordProgress(part.sessionID, `tool:${part.tool}`)
          }
          return
        }

        if (event.type === "file.edited") {
          const sessionID = (event.properties as { sessionID?: unknown }).sessionID
          const sessionIDs =
            typeof sessionID === "string"
              ? [sessionID]
              : inFlight.size > 0
                ? [...inFlight.keys()]
                : store.list().filter((goal) => goal.status === "active").map((goal) => goal.sessionID)
          for (const sessionID of sessionIDs) store.recordProgress(sessionID, "file.edited")
        }
      } catch {
        // A storage or lifecycle error must not turn a recoverable goal into a
        // blocked one or break the host event loop.
      }
    },

    "tool.execute.after": async (toolInput) => {
      try {
        store.recordProgress(toolInput.sessionID, `tool:${toolInput.tool}`)
      } catch {
        // Progress telemetry must not break tool execution.
      }
    },

    "experimental.session.compacting": async (compactionInput) => {
      compactingSessions.add(compactionInput.sessionID)
    },
  }
}
