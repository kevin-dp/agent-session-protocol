import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import type { AgentType } from "./types.js"

export interface DiscoveredSession {
  agent: AgentType
  sessionId: string
  path: string
  cwd?: string
  active: boolean
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/\//g, `-`)
}

export async function discoverClaudeSessions(): Promise<
  Array<DiscoveredSession>
> {
  const home = homedir()
  const sessionsDir = join(home, `.claude`, `sessions`)
  const sessions: Array<DiscoveredSession> = []

  try {
    const files = await readdir(sessionsDir)
    for (const file of files) {
      if (!file.endsWith(`.json`)) continue

      try {
        const content = await readFile(join(sessionsDir, file), `utf8`)
        const meta = JSON.parse(content) as Record<string, unknown>
        const pid = meta.pid as number | undefined
        const sessionId = meta.sessionId as string | undefined
        const cwd = meta.cwd as string | undefined

        if (!sessionId) continue

        const sanitized = sanitizeCwd(cwd ?? ``)
        const jsonlPath = join(
          home,
          `.claude`,
          `projects`,
          sanitized,
          `${sessionId}.jsonl`
        )
        const hasJsonl = await fileExists(jsonlPath)
        if (!hasJsonl) continue

        sessions.push({
          agent: `claude`,
          sessionId,
          path: jsonlPath,
          cwd,
          active: pid != null && isProcessAlive(pid),
        })
      } catch {
        continue
      }
    }
  } catch {
    // sessions dir doesn't exist
  }

  return sessions
}

export async function discoverCodexSessions(): Promise<
  Array<DiscoveredSession>
> {
  const home = homedir()
  const sessionsDir = join(home, `.codex`, `sessions`)
  const sessions: Array<DiscoveredSession> = []

  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await scanDir(join(dir, entry.name))
          continue
        }

        if (!entry.name.startsWith(`rollout-`) || !entry.name.endsWith(`.jsonl`))
          continue

        const filePath = join(dir, entry.name)
        // Parse thread ID from filename: rollout-{timestamp}-{threadId}.jsonl
        const match = entry.name.match(
          /^rollout-[\dT-]+-(.+)\.jsonl$/
        )
        const threadId = match?.[1]
        if (!threadId) continue

        // Read first line to get cwd
        let cwd: string | undefined
        try {
          const content = await readFile(filePath, `utf8`)
          const firstLine = content.split(`\n`)[0]
          if (firstLine) {
            const parsed = JSON.parse(firstLine) as Record<string, unknown>
            const payload = parsed.payload as Record<string, unknown> | undefined
            cwd = payload?.cwd as string | undefined
          }
        } catch {
          // skip
        }

        sessions.push({
          agent: `codex`,
          sessionId: threadId,
          path: filePath,
          cwd,
          active: false, // can't easily detect active Codex sessions
        })
      }
    } catch {
      // directory doesn't exist
    }
  }

  await scanDir(sessionsDir)
  return sessions
}

export async function discoverSessions(
  agent?: AgentType
): Promise<Array<DiscoveredSession>> {
  if (agent === `claude`) return discoverClaudeSessions()
  if (agent === `codex`) return discoverCodexSessions()

  const [claude, codex] = await Promise.all([
    discoverClaudeSessions(),
    discoverCodexSessions(),
  ])

  return [...claude, ...codex]
}

export async function findSessionPath(
  agent: AgentType,
  sessionId: string
): Promise<string | null> {
  const sessions = await discoverSessions(agent)
  const match = sessions.find((s) => s.sessionId === sessionId)
  if (match) return match.path

  // Fallback: search for the JSONL file directly in projects directories
  if (agent === `claude`) {
    const found = await findClaudeJsonlById(sessionId)
    if (found) return found
  }

  return null
}

async function findClaudeJsonlById(
  sessionId: string
): Promise<string | null> {
  const home = homedir()
  const projectsDir = join(home, `.claude`, `projects`)

  try {
    const dirs = await readdir(projectsDir)
    for (const dir of dirs) {
      const jsonlPath = join(projectsDir, dir, `${sessionId}.jsonl`)
      if (await fileExists(jsonlPath)) {
        return jsonlPath
      }
    }
  } catch {
    // projects dir doesn't exist
  }

  return null
}

/**
 * Resolve a session to its filesystem entry. Preference order:
 *   1. Exact sessionId match among discovered sessions.
 *   2. If no sessionId given → active session, else most-recent.
 *   3. Fallback for Claude: scan JSONL files directly (older/continued sessions).
 *
 * Throws if no session can be located.
 */
export async function resolveSession(
  sessionId?: string,
  agent?: AgentType
): Promise<DiscoveredSession> {
  const sessions = await discoverSessions(agent)
  let session = sessionId
    ? sessions.find((s) => s.sessionId === sessionId)
    : (sessions.find((s) => s.active) ?? sessions[sessions.length - 1])

  if (!session && sessionId && (!agent || agent === `claude`)) {
    session = (await findClaudeSession(sessionId)) ?? undefined
  }

  if (!session) {
    const available = sessions.length
      ? `Available: ${sessions.map((s) => `${s.agent}/${s.sessionId}`).join(`, `)}`
      : `No local sessions discovered.`
    throw new Error(
      `Session not found${sessionId ? `: ${sessionId}` : ``}. ${available}`
    )
  }

  return session
}

export async function findClaudeSession(
  sessionId: string
): Promise<DiscoveredSession | null> {
  // First try metadata-based discovery
  const sessions = await discoverClaudeSessions()
  const match = sessions.find((s) => s.sessionId === sessionId)
  if (match) return match

  // Fallback: search JSONL directly
  const path = await findClaudeJsonlById(sessionId)
  if (!path) return null

  // Extract cwd from the directory name
  const dirName = path.split(`/`).at(-2) ?? ``
  const cwd = dirName.startsWith(`-`)
    ? dirName.slice(1).replace(/-/g, `/`)
    : dirName.replace(/-/g, `/`)

  return {
    agent: `claude`,
    sessionId,
    path,
    cwd: `/${cwd}`,
    active: false,
  }
}

/**
 * Register a Claude session in `~/.claude/history.jsonl`, which is the
 * index `claude --resume <id>` consults to find a session's project
 * directory. Without an entry here Claude reports "No conversation found
 * with session ID" even when the `<id>.jsonl` file is on disk.
 *
 * `display` becomes the label Claude shows for the session in its
 * interactive resume picker — pass the imported session's first user
 * prompt when available, or a placeholder like "Imported session".
 */
export function registerClaudeHistoryEntry(
  sessionId: string,
  cwd: string,
  display: string
): void {
  const entry = {
    display,
    pastedContents: {},
    timestamp: Date.now(),
    project: cwd,
    sessionId,
  }
  const historyPath = join(homedir(), `.claude`, `history.jsonl`)
  appendFileSync(historyPath, JSON.stringify(entry) + `\n`)
}

/**
 * Extract the first user prompt from a Claude-native JSONL session.
 * Returns `null` if none is found (e.g. session with only assistant
 * messages, or malformed input). Content is normalized to a single
 * string — text-block arrays are joined by newlines.
 */
export function getClaudeFirstUserPrompt(
  lines: Array<string>
): string | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type !== `user`) continue
      // Skip synthetic continuation markers that Claude injects on resume.
      if (obj.isMeta === true) continue
      const message = obj.message as Record<string, unknown> | undefined
      const content = message?.content
      if (typeof content === `string`) return content
      if (Array.isArray(content)) {
        const texts: Array<string> = []
        for (const block of content) {
          if (
            typeof block === `object` &&
            block !== null &&
            (block as { type?: string }).type === `text` &&
            typeof (block as { text?: string }).text === `string`
          ) {
            texts.push((block as { text: string }).text)
          }
        }
        if (texts.length > 0) return texts.join(`\n`)
      }
    } catch {
      continue
    }
  }
  return null
}

export function writeClaudeSession(
  sessionId: string,
  cwd: string,
  lines: Array<string>
): string {
  
  const sanitizedCwd = cwd.replace(/\//g, `-`)
  const projectDir = join(homedir(), `.claude`, `projects`, sanitizedCwd)
  mkdirSync(projectDir, { recursive: true })
  const sessionPath = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(sessionPath, lines.join(`\n`) + `\n`)
  return sessionPath
}

export function writeCodexSession(
  sessionId: string,
  lines: Array<string>
): string {
  
  const now = new Date()
  const datePath = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, `0`),
    String(now.getDate()).padStart(2, `0`),
  ].join(`/`)
  const timestamp = now.toISOString().replace(/[:.]/g, `-`).slice(0, 19)
  const sessionsDir = join(homedir(), `.codex`, `sessions`, datePath)
  mkdirSync(sessionsDir, { recursive: true })
  const rolloutPath = join(
    sessionsDir,
    `rollout-${timestamp}-${sessionId}.jsonl`
  )
  writeFileSync(rolloutPath, lines.join(`\n`) + `\n`)
  return rolloutPath
}

export function rewriteNativeLines(
  lines: Array<string>,
  agent: AgentType,
  newSessionId: string,
  newCwd: string,
  originalSessionId: string,
  originalCwd: string
): Array<string> {
  return lines.map((line) => {
    let rewritten = line
    if (originalSessionId) {
      rewritten = rewritten.replaceAll(originalSessionId, newSessionId)
    }
    if (originalCwd) {
      rewritten = rewritten.replaceAll(originalCwd, newCwd)
    }
    return rewritten
  })
}
