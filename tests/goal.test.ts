import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { GoalPlugin } from "../plugin/goal.ts"
import { classifyGoalError, isModelTurnError, MAX_IDENTICAL_TOOL_CALLS } from "../plugin/goalpkg/plugin.ts"
import { GoalStore, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from "../plugin/goalpkg/state.ts"
import { parseGoalArgs } from "../plugin/goalpkg/verbs.ts"

const repositoryDir = join(import.meta.dirname, "..")

test("parseGoalArgs keeps control words distinct from objectives", () => {
  assert.deepEqual(parseGoalArgs(""), { kind: "view" })
  assert.deepEqual(parseGoalArgs("  PAUSE  "), { kind: "pause" })
  assert.deepEqual(parseGoalArgs("resume"), { kind: "resume" })
  assert.deepEqual(parseGoalArgs("clear"), { kind: "clear" })
  assert.deepEqual(parseGoalArgs("pause the pipeline"), {
    kind: "set",
    objective: "pause the pipeline",
  })
})

test("GoalStore persists state across store instances and writes atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-goal-state-"))
  const first = new GoalStore(directory)
  first.set("session-a", "finish the task")
  first.recordSuccessfulTurn("session-a")
  first.setStatus("session-a", "paused")

  const second = new GoalStore(directory)
  writeFileSync(
    join(directory, "legacy.json"),
    JSON.stringify({
      sessionID: "legacy",
      objective: "old state",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      turnCount: 4,
    }),
  )
  assert.deepEqual(
    (({ consecutiveFailures, lastSuccessfulTurn, nextRetryAt }: NonNullable<ReturnType<GoalStore["get"]>>) => ({
      consecutiveFailures,
      lastSuccessfulTurn,
      nextRetryAt,
    }))(second.get("legacy")!),
    { consecutiveFailures: 0, lastSuccessfulTurn: 4, nextRetryAt: null },
  )
  const restored = second.get("session-a")!
  assert.deepEqual(restored, {
    sessionID: "session-a",
    objective: "finish the task",
    status: "paused",
    createdAt: restored.createdAt,
    updatedAt: restored.updatedAt,
    turnCount: 1,
    consecutiveFailures: 0,
    lastErrorKind: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    nextRetryAt: null,
    lastSuccessfulTurn: 1,
    lastProgressAt: restored.lastProgressAt,
    lastProgressKind: "turn.success",
    waitingForCompaction: false,
  })
  assert.equal(readFileSync(join(directory, "session-a.json"), "utf8").includes("finish the task"), true)
  second.clear("session-a")
  assert.equal(second.get("session-a"), undefined)
})

test("GoalPlugin preserves command UX, project-local state, continuation, and terminal tools", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-project-"))
  const prompts: unknown[] = []
  const input = {
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: async (value: unknown) => {
          prompts.push(value)
          return {}
        },
      },
    },
  } as never
  const hooks = await GoalPlugin(input)
  const before = hooks["command.execute.before"]!
  const system = hooks["experimental.chat.system.transform"]!
  const event = hooks.event!

  const commandOutput = { parts: [{ type: "text", text: "old expanded command" }] }
  await before({ command: "goal", sessionID: "session-a", arguments: "inspect the repository" }, commandOutput as never)
  assert.equal(commandOutput.parts.length, 1)
  assert.equal(commandOutput.parts[0].text, "Continue working toward the active goal.")
  assert.equal(existsSync(join(projectDir, ".opencode/goal/session-a.json")), true)
  assert.equal(existsSync(join(repositoryDir, ".opencode/goal/session-a.json")), false)

  await before({ command: "goal", sessionID: "session-a", arguments: "pause" }, { parts: [] } as never)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get("session-a")?.status, "paused")
  await event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } })
  assert.equal(prompts.length, 0)
  await before({ command: "goal", sessionID: "session-a", arguments: "resume" }, { parts: [] } as never)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get("session-a")?.status, "active")

  const systemOutput = { system: ["base system"] }
  await system({ sessionID: "session-a", model: {} as never }, systemOutput)
  assert.equal(systemOutput.system.length, 1)
  assert.match(systemOutput.system[0], /<objective>\s*inspect the repository\s*<\/objective>/)

  await event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } })
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0], {
    path: { id: "session-a" },
    body: { parts: [{ type: "text", text: "Continue working toward the active goal." }] },
  })
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get("session-a")?.turnCount, 1)
  await event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } })
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get("session-a")?.turnCount, 2)

  const complete = hooks.tool!.goal_complete
  await complete.execute({ summary: "verified" }, { sessionID: "session-a" } as never)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get("session-a")?.status, "complete")

  const blockedID = "session-b"
  await before({ command: "goal", sessionID: blockedID, arguments: "another task" }, { parts: [] } as never)
  await hooks.tool!.goal_blocked.execute({ reason: "missing input" }, { sessionID: blockedID } as never)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get(blockedID)?.status, "blocked")
  await before({ command: "goal", sessionID: blockedID, arguments: "resume" }, { parts: [] } as never)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get(blockedID)?.status, "active")
  await before({ command: "goal", sessionID: blockedID, arguments: "clear" }, { parts: [] } as never)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get(blockedID), undefined)

  const errorID = "session-error"
  await before({ command: "goal", sessionID: errorID, arguments: "error handling" }, { parts: [] } as never)
  await event({ event: { type: "session.error", properties: { sessionID: errorID, error: { name: "UnknownError" } as never } } })
  const recoverableError = new GoalStore(join(projectDir, ".opencode/goal")).get(errorID)!
  assert.equal(recoverableError.status, "active")
  assert.equal(recoverableError.lastErrorKind, "model_turn")
  assert.ok(recoverableError.nextRetryAt! >= Date.now())

  const authID = "session-auth"
  await before({ command: "goal", sessionID: authID, arguments: "requires valid credentials" }, { parts: [] } as never)
  await event({
    event: {
      type: "session.error",
      properties: { sessionID: authID, error: { name: "ProviderAuthError", data: { message: "unauthorized" } } as never },
    },
  })
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get(authID)?.status, "waiting")

  await before({ command: "goal", sessionID: "session-a", arguments: "" }, { parts: [] } as never)
  assert.match((new GoalStore(join(projectDir, ".opencode/goal")).get("session-a")?.objective ?? ""), /inspect/)
})

test("Qwen-compatible system handling and model error policy are preserved", async () => {
  assert.equal(isModelTurnError({ name: "UnknownError" }), true)
  assert.equal(isModelTurnError({ name: "MessageOutputLengthError" }), true)
  assert.equal(isModelTurnError({ name: "ProviderAuthError" }), false)
  assert.equal(isModelTurnError({ name: "MessageAbortedError" }), false)
  assert.equal(isModelTurnError(new Error("ECONNRESET")), false)
  assert.equal(classifyGoalError({ name: "APIError", data: { isRetryable: true, message: "upstream" } }), "api_retryable")
  assert.equal(classifyGoalError({ name: "APIError", data: { isRetryable: false, message: "unauthorized" } }), "api_non_retryable")
  assert.equal(classifyGoalError({ name: "UnknownError", data: { message: "SSE read timed out" } }), "transport")
  assert.equal(classifyGoalError({ name: "ContextOverflowError", data: { message: "too large" } }), "context_overflow")
  assert.equal(classifyGoalError({ name: "MessageAbortedError", data: { message: "aborted" } }), "aborted")

  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-qwen-"))
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: { session: { prompt: async () => ({}) } },
  } as never)
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "qwen", arguments: "task" }, { parts: [] } as never)
  const output = { system: ["existing"] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "qwen", model: {} as never }, output)
  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /existing[\s\S]*Continue working toward the active goal\./)
})

test("identical tool calls recover without requiring another idle event or stopping the goal", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-no-progress-"))
  const aborts: unknown[] = []
  const prompts: unknown[] = []
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: async (value: unknown) => {
          prompts.push(value)
          return {}
        },
        abort: async (value: unknown) => {
          aborts.push(value)
          return {}
        },
      },
    },
  } as never)
  const before = hooks["command.execute.before"]!
  const beforeTool = hooks["tool.execute.before"]!
  const after = hooks["tool.execute.after"]!
  const store = new GoalStore(join(projectDir, ".opencode/goal"))
  const sessionID = "no-progress"
  const args = { content: "same content", path: "/work/src/container/cpk_reader.h" }

  await before({ command: "goal", sessionID, arguments: "make progress" }, { parts: [] } as never)
  for (let count = 1; count <= MAX_IDENTICAL_TOOL_CALLS; count += 1) {
    await after(
      { sessionID, tool: "acah_re_acah_re_write", callID: `call-${count}`, args },
      { title: "write", output: "wrote 12 characters", metadata: {} },
    )
    if (count < MAX_IDENTICAL_TOOL_CALLS) assert.equal(store.get(sessionID)?.status, "active")
  }

  let goal = store.get(sessionID)!
  assert.equal(goal.status, "active")
  assert.deepEqual(aborts, [{ path: { id: sessionID } }])

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(prompts.length, 1)
  assert.match(((prompts[0] as { body?: { parts?: Array<{ text?: string }> } }).body?.parts?.[0]?.text ?? ""), /goal recovery 1/)
  goal = store.get(sessionID)!
  assert.equal(goal.status, "active")
  assert.equal(goal.lastErrorKind, null)

  await assert.rejects(
    () => beforeTool({ sessionID, tool: "acah_re_acah_re_write", callID: "blocked-1" }, { args } as never),
    /Recovery required: refusing identical tool call 1\/3/,
  )
  for (let count = 2; count <= MAX_IDENTICAL_TOOL_CALLS; count += 1) {
    await assert.rejects(
      () => beforeTool({ sessionID, tool: "acah_re_acah_re_write", callID: `blocked-${count}` }, { args } as never),
      new RegExp(`Recovery required: refusing identical tool call ${count}/${MAX_IDENTICAL_TOOL_CALLS}`),
    )
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  goal = store.get(sessionID)!
  assert.equal(goal.status, "active")
  assert.equal(aborts.length, 2)
  assert.equal(prompts.length, 2)
  assert.match(((prompts[1] as { body?: { parts?: Array<{ text?: string }> } }).body?.parts?.[0]?.text ?? ""), /goal recovery 2/)
  await hooks.dispose?.()
})

test("plugin-issued recovery abort is not counted as a continuation failure", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-self-abort-"))
  const prompts: unknown[] = []
  let hooks: Awaited<ReturnType<typeof GoalPlugin>>
  hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: async (value: unknown) => {
          prompts.push(value)
          return {}
        },
        abort: async () => {
          queueMicrotask(() =>
            void hooks.event!({
              event: {
                type: "session.error",
                properties: { sessionID: "self-abort", error: { name: "MessageAbortedError", data: { message: "Aborted" } } as never },
              },
            }),
          )
          queueMicrotask(() =>
            void hooks.event!({ event: { type: "session.status", properties: { sessionID: "self-abort", status: { type: "idle" } } } }),
          )
          queueMicrotask(() => void hooks.event!({ event: { type: "session.idle", properties: { sessionID: "self-abort" } } }))
          return {}
        },
      },
    },
  } as never)
  await hooks["command.execute.before"]!({ command: "goal", sessionID: "self-abort", arguments: "recover" }, { parts: [] } as never)
  const args = { path: "/tmp/result", content: "same" }
  for (let count = 1; count <= MAX_IDENTICAL_TOOL_CALLS; count += 1) {
    await hooks["tool.execute.after"]!(
      { sessionID: "self-abort", tool: "write", callID: String(count), args },
      { title: "write", output: "unchanged", metadata: {} },
    )
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  const goal = new GoalStore(join(projectDir, ".opencode/goal")).get("self-abort")!
  assert.equal(prompts.length, 1)
  assert.equal(goal.status, "active")
  assert.equal(goal.lastErrorKind, null)
  assert.equal(goal.consecutiveFailures, 0)
  await hooks.dispose?.()
})

test("same polling call with changing output is progress, not a loop", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-polling-"))
  const aborts: unknown[] = []
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: { session: { prompt: async () => ({}), abort: async (value: unknown) => { aborts.push(value); return {} } } },
  } as never)
  const sessionID = "polling"
  await hooks["command.execute.before"]!({ command: "goal", sessionID, arguments: "wait for the build" }, { parts: [] } as never)
  for (let count = 1; count <= 5; count += 1) {
    await hooks["tool.execute.after"]!(
      { sessionID, tool: "build_status", callID: String(count), args: { job: "42" } },
      { title: "status", output: `step ${count}/5`, metadata: {} },
    )
  }
  assert.equal(aborts.length, 0)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get(sessionID)?.status, "active")
  await hooks.dispose?.()
})

test("a successful alternate tool call clears the recovery guard", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-recovery-alternate-"))
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: { session: { prompt: async () => ({}), abort: async () => ({}) } },
  } as never)
  const before = hooks["command.execute.before"]!
  const beforeTool = hooks["tool.execute.before"]!
  const after = hooks["tool.execute.after"]!
  const event = hooks.event!
  const sessionID = "recovery-alternate"
  const writeArgs = { content: "same content", path: "/work/src/container/cpk_reader.h" }

  await before({ command: "goal", sessionID, arguments: "make progress" }, { parts: [] } as never)
  for (let count = 1; count <= MAX_IDENTICAL_TOOL_CALLS; count += 1) {
    await after(
      { sessionID, tool: "acah_re_acah_re_write", callID: `write-${count}`, args: writeArgs },
      { title: "write", output: "wrote 12 characters", metadata: {} },
    )
  }
  await event({ event: { type: "session.idle", properties: { sessionID } } })

  const readArgs = { path: writeArgs.path }
  await beforeTool({ sessionID, tool: "acah_re_acah_re_read", callID: "read-1" }, { args: readArgs } as never)
  await after(
    { sessionID, tool: "acah_re_acah_re_read", callID: "read-1", args: readArgs },
    { title: "read", output: "verified", metadata: {} },
  )
  await beforeTool({ sessionID, tool: "acah_re_acah_re_write", callID: "write-after-recovery" }, { args: writeArgs } as never)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get(sessionID)?.status, "active")
  await hooks.dispose?.()
})

test("transport timeout uses persisted capped backoff until it eventually succeeds", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-timeout-"))
  let calls = 0
  const timeout = { name: "APIError", data: { message: "SSE read timed out", isRetryable: true } }
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: async () => {
          calls += 1
          if (calls <= 8) throw timeout
          return {}
        },
      },
    },
  } as never)
  const before = hooks["command.execute.before"]!
  const event = hooks.event!
  const store = new GoalStore(join(projectDir, ".opencode/goal"))
  const sessionID = "timeout-session"
  await before({ command: "goal", sessionID, arguments: "slow remote task" }, { parts: [] } as never)

  const startedAt = Date.now()
  await event({ event: { type: "session.idle", properties: { sessionID } } })
  let goal = store.get(sessionID)!
  assert.equal(calls, 1)
  assert.equal(goal.status, "active")
  assert.equal(goal.turnCount, 0)
  assert.equal(goal.consecutiveFailures, 1)
  assert.equal(goal.lastErrorKind, "transport")
  assert.equal(goal.lastErrorMessage, "SSE read timed out")
  assert.ok(goal.nextRetryAt! >= startedAt + RETRY_BASE_DELAY_MS)

  await event({ event: { type: "session.idle", properties: { sessionID } } })
  assert.equal(calls, 1)

  for (let expectedCalls = 2; expectedCalls <= 9; expectedCalls += 1) {
    goal = { ...store.get(sessionID)!, nextRetryAt: Date.now() - 1 }
    writeFileSync(join(projectDir, ".opencode/goal", `${sessionID}.json`), JSON.stringify(goal))
    await event({ event: { type: "session.idle", properties: { sessionID } } })
    goal = store.get(sessionID)!
    assert.equal(calls, expectedCalls)
    assert.equal(goal.status, "active")
    if (expectedCalls <= 8) {
      assert.equal(goal.turnCount, 0)
      assert.ok(goal.nextRetryAt! > Date.now())
      assert.ok(goal.nextRetryAt! - goal.lastErrorAt! <= RETRY_MAX_DELAY_MS)
      if (expectedCalls >= 6) assert.equal(goal.nextRetryAt! - goal.lastErrorAt!, RETRY_MAX_DELAY_MS)
    }
  }
  assert.equal(goal.consecutiveFailures, 0)
  assert.equal(goal.nextRetryAt, null)
  assert.equal(store.get(sessionID)!.turnCount, 1)
  await hooks.dispose?.()
})

test("in-flight, busy, and compaction states suppress duplicate continuations", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-flight-"))
  const prompts: unknown[] = []
  let release!: (value: unknown) => void
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: async (value: unknown) => {
          prompts.push(value)
          if (prompts.length > 1) return {}
          return new Promise((resolve) => {
            release = resolve
          })
        },
      },
    },
  } as never)
  const before = hooks["command.execute.before"]!
  const event = hooks.event!
  await before({ command: "goal", sessionID: "flight", arguments: "avoid duplicates" }, { parts: [] } as never)

  const first = event({ event: { type: "session.idle", properties: { sessionID: "flight" } } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await event({ event: { type: "session.idle", properties: { sessionID: "flight" } } })
  assert.equal(prompts.length, 1)
  release({})
  await first
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(prompts.length, 2)
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get("flight")?.turnCount, 2)

  await before({ command: "goal", sessionID: "busy", arguments: "wait for busy session" }, { parts: [] } as never)
  await event({ event: { type: "session.status", properties: { sessionID: "busy", status: { type: "busy" } } } })
  await event({ event: { type: "session.idle", properties: { sessionID: "busy" } } })
  assert.equal(prompts.length, 2)

  await before({ command: "goal", sessionID: "retry", arguments: "wait for provider retry" }, { parts: [] } as never)
  await event({
    event: {
      type: "session.status",
      properties: { sessionID: "retry", status: { type: "retry", attempt: 1, message: "provider retry", next: Date.now() + 1_000 } },
    },
  })
  await event({ event: { type: "session.idle", properties: { sessionID: "retry" } } })
  assert.equal(prompts.length, 2)

  await before({ command: "goal", sessionID: "compaction", arguments: "wait for compaction" }, { parts: [] } as never)
  await hooks["experimental.session.compacting"]!({ sessionID: "compaction" }, { context: [] })
  await event({ event: { type: "session.idle", properties: { sessionID: "compaction" } } })
  assert.equal(prompts.length, 2)
  await event({ event: { type: "session.compacted", properties: { sessionID: "compaction" } } })
  await event({ event: { type: "session.idle", properties: { sessionID: "compaction" } } })
  assert.equal(prompts.length, 3)
  await hooks.dispose?.()
})

test("externally aborted continuation keeps retrying without stopping the goal", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-aborted-"))
  let calls = 0
  const aborted = { name: "MessageAbortedError", data: { message: "Aborted" } }
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: async () => {
          calls += 1
          throw aborted
        },
      },
    },
  } as never)
  const before = hooks["command.execute.before"]!
  const event = hooks.event!
  const store = new GoalStore(join(projectDir, ".opencode/goal"))
  const sessionID = "aborted-session"
  await before({ command: "goal", sessionID, arguments: "recover from a transient abort" }, { parts: [] } as never)

  await event({ event: { type: "session.idle", properties: { sessionID } } })
  let goal = store.get(sessionID)!
  assert.equal(calls, 1)
  assert.equal(goal.status, "active")
  assert.equal(goal.lastErrorKind, "aborted")
  assert.ok(goal.nextRetryAt! >= Date.now())

  for (let expectedCalls = 2; expectedCalls <= 4; expectedCalls += 1) {
    goal = { ...goal, nextRetryAt: Date.now() - 1 }
    writeFileSync(join(projectDir, ".opencode/goal", `${sessionID}.json`), JSON.stringify(goal))
    await event({ event: { type: "session.idle", properties: { sessionID } } })
    goal = store.get(sessionID)!
    assert.equal(calls, expectedCalls)
    assert.equal(goal.status, "active")
    assert.equal(goal.lastErrorKind, "aborted")
    assert.ok(goal.nextRetryAt! >= Date.now())
  }
  await hooks.dispose?.()
})

test("context overflow waits for compaction and progress is persisted", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-progress-"))
  let calls = 0
  const hooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: {
      session: {
        prompt: async () => {
          calls += 1
          if (calls === 1) throw { name: "ContextOverflowError", data: { message: "context window exceeded" } }
          return {}
        },
      },
    },
  } as never)
  const before = hooks["command.execute.before"]!
  const event = hooks.event!
  const store = new GoalStore(join(projectDir, ".opencode/goal"))
  await before({ command: "goal", sessionID: "context", arguments: "compact safely" }, { parts: [] } as never)
  await event({ event: { type: "session.idle", properties: { sessionID: "context" } } })
  const contextGoal = store.get("context")!
  assert.deepEqual(
    (({ status, waitingForCompaction, nextRetryAt, turnCount }) => ({
      status,
      waitingForCompaction,
      nextRetryAt,
      turnCount,
    }))(contextGoal),
    { status: "waiting", waitingForCompaction: true, nextRetryAt: null, turnCount: 0 },
  )
  await event({ event: { type: "session.idle", properties: { sessionID: "context" } } })
  assert.equal(calls, 1)
  await event({ event: { type: "session.compacted", properties: { sessionID: "context" } } })
  assert.equal(store.get("context")?.status, "active")
  await event({ event: { type: "session.idle", properties: { sessionID: "context" } } })
  assert.equal(calls, 2)
  assert.equal(store.get("context")?.turnCount, 1)

  const checkpoint = hooks.tool!.goal_checkpoint
  await checkpoint.execute({ summary: "verified checkpoint" }, { sessionID: "context" } as never)
  assert.equal(store.get("context")?.lastProgressKind, "goal_checkpoint")
  await hooks["tool.execute.after"]!({ sessionID: "context", tool: "shell" } as never, {} as never)
  assert.equal(store.get("context")?.lastProgressKind, "tool:shell")
  await event({ event: { type: "file.edited", properties: { file: "README.md" } } })
  assert.equal(store.get("context")?.lastProgressKind, "file.edited")
  await hooks.dispose?.()
})

test("nextRetryAt survives a plugin restart", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-goal-restart-"))
  const timeout = new Error("ECONNRESET")
  const firstHooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: { session: { prompt: async () => { throw timeout } } },
  } as never)
  const before = firstHooks["command.execute.before"]!
  const event = firstHooks.event!
  const sessionID = "restart"
  await before({ command: "goal", sessionID, arguments: "persist retry" }, { parts: [] } as never)
  await event({ event: { type: "session.idle", properties: { sessionID } } })
  const store = new GoalStore(join(projectDir, ".opencode/goal"))
  assert.ok(store.get(sessionID)!.nextRetryAt! > Date.now())
  await firstHooks.dispose?.()

  let restartedCalls = 0
  const secondHooks = await GoalPlugin({
    directory: projectDir,
    worktree: projectDir,
    client: { session: { prompt: async () => { restartedCalls += 1; return {} } } },
  } as never)
  await secondHooks.event!({ event: { type: "session.idle", properties: { sessionID } } })
  assert.equal(restartedCalls, 0)
  const due = { ...store.get(sessionID)!, nextRetryAt: Date.now() - 1 }
  writeFileSync(join(projectDir, ".opencode/goal", `${sessionID}.json`), JSON.stringify(due))
  await secondHooks.event!({ event: { type: "session.idle", properties: { sessionID } } })
  assert.equal(restartedCalls, 1)
  assert.equal(store.get(sessionID)!.turnCount, 1)
  await secondHooks.dispose?.()
})

test("install and uninstall are idempotent and never overwrite unrelated files", () => {
  const configDir = mkdtempSync(join(tmpdir(), "opencode-goal-config-"))
  const environment = { ...process.env, OPENCODE_CONFIG_DIR: configDir }
  const install = join(repositoryDir, "install.sh")
  const uninstall = join(repositoryDir, "uninstall.sh")
  execFileSync(install, [], { env: environment, encoding: "utf8" })
  execFileSync(install, [], { env: environment, encoding: "utf8" })

  assert.equal(readlinkSync(join(configDir, "plugins/opencode-codex-goal.ts")), join(repositoryDir, "plugin/goal.ts"))
  assert.equal(readlinkSync(join(configDir, "plugins/goalpkg")), join(repositoryDir, "plugin/goalpkg"))
  assert.equal(readlinkSync(join(configDir, "commands/goal.md")), join(repositoryDir, "command/goal.md"))

  const unrelated = join(configDir, "plugins/unrelated.ts")
  writeFileSync(unrelated, "export const Unrelated = async () => ({})\n")
  execFileSync(uninstall, [], { env: environment, encoding: "utf8" })
  assert.equal(readFileSync(unrelated, "utf8").includes("Unrelated"), true)
  assert.equal(spawnSync(uninstall, [], { env: environment }).status, 0)
  execFileSync(install, [], { env: environment, encoding: "utf8" })
  assert.equal(readlinkSync(join(configDir, "commands/goal.md")), join(repositoryDir, "command/goal.md"))
  execFileSync(uninstall, [], { env: environment, encoding: "utf8" })

  const conflictConfig = mkdtempSync(join(tmpdir(), "opencode-goal-conflict-"))
  const conflictPluginDir = join(conflictConfig, "plugins")
  const otherTarget = join(conflictConfig, "other-plugin.ts")
  mkdirSync(conflictPluginDir, { recursive: true })
  writeFileSync(otherTarget, "export const Other = async () => ({})\n")
  symlinkSync(otherTarget, join(conflictPluginDir, "opencode-codex-goal.ts"))
  const conflict = spawnSync(install, [], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: conflictConfig },
    encoding: "utf8",
  })
  assert.notEqual(conflict.status, 0)
  assert.equal(readlinkSync(join(conflictPluginDir, "opencode-codex-goal.ts")), otherTarget)
})
