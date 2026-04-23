/**
 * Import a locally-stored session into a new local session. Supports
 * both same-agent (lossless native rewrite) and cross-agent (via
 * normalized round-trip) flows.
 *
 * For same-agent imports the source's native JSONL is rewritten with a
 * fresh session id and target cwd, preserving everything the source
 * agent wrote (tool results, thinking blocks, metadata) byte-for-byte
 * except for the id/cwd substitutions.
 *
 * For cross-agent imports the source is loaded via the normalized
 * event stream, then denormalized into the target agent's JSONL format.
 * This is lossy in the way any cross-agent resume is — only the fields
 * the normalized schema captures survive.
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { denormalize } from "./denormalize.js"
import { loadSession } from "./load.js"
import {
  getClaudeFirstUserPrompt,
  registerClaudeHistoryEntry,
  resolveSession,
  rewriteNativeLines,
  writeClaudeSession,
  writeCodexSession,
} from "./sessions.js"
import type { AgentType } from "./types.js"

export interface ImportLocalOptions {
  source: {
    sessionId: string
    agent: AgentType
  }
  target: {
    agent: AgentType
    /** Target working directory. Defaults to the source session's cwd. */
    cwd?: string
  }
  /** Strip `/share` skill rounds before importing. Defaults to true. */
  filterSkills?: boolean
}

export interface ImportLocalResult {
  sessionId: string
  agent: AgentType
  cwd: string
  path: string
  mode: `native` | `normalized`
}

/**
 * Same-process analogue of `importSession` (which reads from a DS URL).
 * Reads an existing local session and writes a new one under a fresh
 * native id, optionally converting between Claude and Codex formats.
 */
export async function importLocalSession(
  options: ImportLocalOptions
): Promise<ImportLocalResult> {
  const { source, target, filterSkills = true } = options

  const newSessionId = randomUUID()
  const sourceSession = await resolveSession(source.sessionId, source.agent)
  const targetAgent = target.agent
  const targetCwd = target.cwd ?? sourceSession.cwd ?? process.cwd()

  if (source.agent === targetAgent) {
    // Same-agent — do a lossless native rewrite.
    const raw = readFileSync(sourceSession.path, `utf8`)
    const originalLines = raw.split(`\n`).filter((l) => l.trim().length > 0)
    const rewritten = rewriteNativeLines(
      originalLines,
      targetAgent,
      newSessionId,
      targetCwd,
      source.sessionId,
      sourceSession.cwd ?? ``
    )
    const writtenPath =
      targetAgent === `claude`
        ? writeClaudeSession(newSessionId, targetCwd, rewritten)
        : writeCodexSession(newSessionId, rewritten)

    if (targetAgent === `claude`) {
      const firstPrompt = getClaudeFirstUserPrompt(rewritten)
      registerClaudeHistoryEntry(
        newSessionId,
        targetCwd,
        firstPrompt ?? `Imported session ${newSessionId.slice(0, 8)}`
      )
    }

    return {
      sessionId: newSessionId,
      agent: targetAgent,
      cwd: targetCwd,
      path: writtenPath,
      mode: `native`,
    }
  }

  // Cross-agent — round-trip through the normalized event stream.
  const loaded = await loadSession({
    sessionId: source.sessionId,
    agent: source.agent,
    filterSkills,
  })
  const targetLines = denormalize(loaded.events, targetAgent, {
    sessionId: newSessionId,
    cwd: targetCwd,
  })

  const writtenPath =
    targetAgent === `claude`
      ? writeClaudeSession(newSessionId, targetCwd, targetLines)
      : writeCodexSession(newSessionId, targetLines)

  if (targetAgent === `claude`) {
    const firstPrompt = getClaudeFirstUserPrompt(targetLines)
    registerClaudeHistoryEntry(
      newSessionId,
      targetCwd,
      firstPrompt ?? `Imported session ${newSessionId.slice(0, 8)}`
    )
  }

  return {
    sessionId: newSessionId,
    agent: targetAgent,
    cwd: targetCwd,
    path: writtenPath,
    mode: `normalized`,
  }
}
