import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { GoalPlugin } from "../plugin/goal.ts"
import { isModelTurnError } from "../plugin/goalpkg/plugin.ts"
import { GoalStore } from "../plugin/goalpkg/state.ts"
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
  first.incrementTurn("session-a")
  first.setStatus("session-a", "paused")

  const second = new GoalStore(directory)
  assert.deepEqual(second.get("session-a"), {
    sessionID: "session-a",
    objective: "finish the task",
    status: "paused",
    createdAt: second.get("session-a")?.createdAt,
    updatedAt: second.get("session-a")?.updatedAt,
    turnCount: 1,
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
  assert.equal(new GoalStore(join(projectDir, ".opencode/goal")).get(errorID)?.status, "blocked")

  await before({ command: "goal", sessionID: "session-a", arguments: "" }, { parts: [] } as never)
  assert.match((new GoalStore(join(projectDir, ".opencode/goal")).get("session-a")?.objective ?? ""), /inspect/)
})

test("Qwen-compatible system handling and model error policy are preserved", async () => {
  assert.equal(isModelTurnError({ name: "UnknownError" }), true)
  assert.equal(isModelTurnError({ name: "MessageOutputLengthError" }), true)
  assert.equal(isModelTurnError({ name: "ProviderAuthError" }), false)
  assert.equal(isModelTurnError({ name: "MessageAbortedError" }), false)
  assert.equal(isModelTurnError(new Error("ECONNRESET")), false)

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
