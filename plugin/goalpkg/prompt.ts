import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Goal } from "./state.ts"

export const CONTINUE_NUDGE = "Continue working toward the active goal."

export function renderNoProgressRecovery(tool: string, attempt: number, maxAttempts: number): string {
  return [
    `[goal recovery ${attempt}/${maxAttempts}]`,
    `The tool call ${tool} was repeated with identical arguments and made no progress.`,
    "Do not issue that same tool call again.",
    "First inspect the current state and the actual tool result, then choose a different evidence-backed approach such as read, list, bash, a test, or a different implementation.",
    "Do not claim progress until the alternative approach has been verified.",
  ].join(" ")
}

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "continuation.template.md")
let templateCache: string | null = null

function template(): string {
  if (templateCache === null) {
    const raw = readFileSync(TEMPLATE_PATH, "utf8")
    templateCache = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, "")
  }
  return templateCache
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function renderGoalSystem(goal: Goal): string {
  return template().replace(/\{\{objective\}\}/g, xmlEscape(goal.objective))
}
