import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin"
import type { TextPartInput } from "@opencode-ai/sdk"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { GoalStore, type Goal, type GoalErrorKind } from "./state.ts"
import { parseGoalArgs } from "./verbs.ts"
import { renderGoalSystem, renderNoProgressRecovery, CONTINUE_NUDGE } from "./prompt.ts"
import { makeGoalTools } from "./tools.ts"

const MODEL_TURN_ERROR_NAMES = new Set(["UnknownError", "MessageOutputLengthError"])
const AUTH_ERROR_NAMES = new Set(["ProviderAuthError", "AuthenticationError", "UnauthorizedError"])
const ABORT_ERROR_NAMES = new Set(["MessageAbortedError", "AbortError"])
const TRANSPORT_ERROR_NAMES = new Set(["NetworkError", "FetchError", "TimeoutError", "ConnectionError"])
const TRANSPORT_MSG_RE =
  /econnrefused|econnreset|etimedout|eai_again|epipe|und_err_|fetch failed|socket hang up|network|disposed|dispose|read timed?\s?out|sse.*timed?\s?out|instance.*(gone|dispose)/i
const CONTEXT_MSG_RE =
  /context.{0,30}(overflow|length|window|limit)|too many tokens|maximum context|prompt.{0,20}(too long|token)|token.{0,20}(limit|exceed)|exceed.{0,20}(context|token)/i

export const MAX_IDENTICAL_TOOL_CALLS = 3

function stableSerialize(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? String(value)
}

function toolCallSignature(tool: string, args: unknown): string {
  return `${tool}:${createHash("sha256").update(stableSerialize(args)).digest("hex")}`
}

function toolResultSignature(tool: string, args: unknown, output: unknown): string {
  return `${toolCallSignature(tool, args)}:${createHash("sha256").update(stableSerialize(output)).digest("hex")}`
}

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
type RepeatedToolCall = { signature: string; count: number }
type RecoveryRequest = { tool: string; attempt: number }
type RecoveryGuard = { signature: string; tool: string; blockedCount: number }

export const GoalPlugin: Plugin = async (input): Promise<Hooks> => {
  const store = new GoalStore(resolveStateDir(input))
  const client = input.client
  const sessionStatuses = new Map<string, RuntimeSessionStatus>()
  const compactingSessions = new Set<string>()
  const inFlight = new Map<string, ContinuationAttempt>()
  const retryTimers = new Map<string, RetryTimer>()
  const recentErrors = new Map<string, { kind: GoalErrorKind; message: string; at: number }>()
  const repeatedToolCalls = new Map<string, RepeatedToolCall>()
  const pendingRecoveries = new Map<string, RecoveryRequest>()
  const recoveryAttempts = new Map<string, number>()
  const recoveryGuards = new Map<string, RecoveryGuard>()
  const recoveryAborts = new Map<string, Promise<void>>()
  const expectedRecoveryAborts = new Map<string, number>()

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

  function resetRepeatedToolCall(sessionID: string): void {
    repeatedToolCalls.delete(sessionID)
  }

  function resetRecovery(sessionID: string): void {
    pendingRecoveries.delete(sessionID)
    recoveryAttempts.delete(sessionID)
    recoveryGuards.delete(sessionID)
    recoveryAborts.delete(sessionID)
    expectedRecoveryAborts.delete(sessionID)
  }

  function observeToolCall(sessionID: string, tool: string, args: unknown, output: unknown): number {
    const signature = toolResultSignature(tool, args, output)
    const previous = repeatedToolCalls.get(sessionID)
    const count = previous?.signature === signature ? previous.count + 1 : 1
    repeatedToolCalls.set(sessionID, { signature, count })
    return count
  }

  async function abortSession(sessionID: string): Promise<void> {
    if (typeof client.session.abort !== "function") return
    try {
      await client.session.abort({ path: { id: sessionID } })
    } catch {
      // The state transition remains authoritative if the prompt already ended.
    }
  }

  async function startNoProgressRecovery(sessionID: string, tool: string, args: unknown, count: number): Promise<void> {
    invalidateAttempt(sessionID)
    const previousAttempts = recoveryAttempts.get(sessionID) ?? 0
    const attempt = previousAttempts + 1
    const signature = toolCallSignature(tool, args)
    const message = `Identical tool call repeated ${count} times: ${tool}`
    const updated = store.recordNoProgressRecovery(sessionID, message)
    if (!updated || updated.status !== "active") return

    recoveryAttempts.set(sessionID, attempt)
    recoveryGuards.set(sessionID, { signature, tool, blockedCount: 0 })
    pendingRecoveries.set(sessionID, { tool, attempt })
    resetRepeatedToolCall(sessionID)
    expectedRecoveryAborts.set(sessionID, Date.now() + 5_000)
    const abort = abortSession(sessionID)
    recoveryAborts.set(sessionID, abort)
    await abort
    if (recoveryAborts.get(sessionID) === abort) recoveryAborts.delete(sessionID)
    // The abort request is complete, so recovery must not depend on a later
    // lifecycle event that may be delayed or absent.
    sessionStatuses.set(sessionID, "idle")
    queueMicrotask(() => void runRecovery(sessionID))
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

    const retryable = kind !== "authentication" && kind !== "api_non_retryable" && kind !== "context_overflow"
    const updated = store.recordFailure(sessionID, kind, message, retryable)
    if (!updated || updated.status !== "active" || updated.nextRetryAt === null) {
      clearRetryTimer(sessionID)
      return
    }
    scheduleRetry(sessionID, updated.nextRetryAt)
  }

  async function runPrompt(sessionID: string, promptText: string): Promise<void> {
    if (inFlight.has(sessionID)) return

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
          body: { parts: [{ type: "text", text: promptText }] },
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
      if (pendingRecoveries.has(sessionID)) {
        queueMicrotask(() => void runRecovery(sessionID))
      }
    }

    if (continueAfterSuccess) queueMicrotask(() => void runContinuation(sessionID))
  }

  async function runRecovery(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID) || compactingSessions.has(sessionID)) return

    const recovery = pendingRecoveries.get(sessionID)
    if (!recovery) return

    const abort = recoveryAborts.get(sessionID)
    if (abort) {
      await abort
      if (pendingRecoveries.has(sessionID)) queueMicrotask(() => void runRecovery(sessionID))
      return
    }

    const runtimeStatus = sessionStatuses.get(sessionID)
    if (runtimeStatus === "busy" || runtimeStatus === "retry") return

    const goal = store.get(sessionID)
    if (!goal || goal.status !== "active") {
      pendingRecoveries.delete(sessionID)
      return
    }

    pendingRecoveries.delete(sessionID)
    await runPrompt(sessionID, renderNoProgressRecovery(recovery.tool, recovery.attempt))
  }

  async function runContinuation(sessionID: string): Promise<void> {
    if (pendingRecoveries.has(sessionID)) {
      await runRecovery(sessionID)
      return
    }

    if (inFlight.has(sessionID) || compactingSessions.has(sessionID)) return

    const goal = store.get(sessionID)
    if (!goal || goal.status !== "active") return

    const runtimeStatus = sessionStatuses.get(sessionID)
    if (runtimeStatus === "busy" || runtimeStatus === "retry") return

    if (goal.nextRetryAt !== null && goal.nextRetryAt > Date.now()) {
      scheduleRetry(sessionID, goal.nextRetryAt)
      return
    }

    await runPrompt(sessionID, CONTINUE_NUDGE)
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
          resetRepeatedToolCall(sessionID)
          resetRecovery(sessionID)
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
          resetRepeatedToolCall(sessionID)
          resetRecovery(sessionID)
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
          resetRepeatedToolCall(sessionID)
          resetRecovery(sessionID)
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
          resetRepeatedToolCall(sessionID)
          resetRecovery(sessionID)
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
          if (pendingRecoveries.has(event.properties.sessionID)) {
            await runRecovery(event.properties.sessionID)
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
          const kind = classifyGoalError(event.properties.error)
          const expectedUntil = expectedRecoveryAborts.get(sessionID)
          if (kind === "aborted" && expectedUntil !== undefined) {
            expectedRecoveryAborts.delete(sessionID)
            if (expectedUntil >= Date.now()) return
          }
          handleError(sessionID, event.properties.error, inFlight.get(sessionID))
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

    "tool.execute.before": async (toolInput, output) => {
      const guard = recoveryGuards.get(toolInput.sessionID)
      if (!guard) return

      const signature = toolCallSignature(toolInput.tool, output.args)
      if (signature !== guard.signature) {
        return
      }

      guard.blockedCount += 1
      if (guard.blockedCount >= MAX_IDENTICAL_TOOL_CALLS) {
        await startNoProgressRecovery(toolInput.sessionID, guard.tool, output.args, guard.blockedCount)
      }
      throw new Error(
        `[goal] Recovery required: refusing identical tool call ${guard.blockedCount}/${MAX_IDENTICAL_TOOL_CALLS} for ${guard.tool}. Choose a different approach.`,
      )
    },

    "tool.execute.after": async (toolInput, output) => {
      try {
        if (toolInput.tool === "goal_checkpoint") {
          resetRepeatedToolCall(toolInput.sessionID)
          resetRecovery(toolInput.sessionID)
          return
        }

        const goal = store.get(toolInput.sessionID)
        if (!goal || goal.status !== "active") return

        const recovery = recoveryGuards.get(toolInput.sessionID)
        const signature = toolCallSignature(toolInput.tool, toolInput.args)
        if (recovery && signature !== recovery.signature) resetRecovery(toolInput.sessionID)

        const count = observeToolCall(toolInput.sessionID, toolInput.tool, toolInput.args, output.output)
        if (count >= MAX_IDENTICAL_TOOL_CALLS) {
          await startNoProgressRecovery(toolInput.sessionID, toolInput.tool, toolInput.args, count)
          return
        }

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
