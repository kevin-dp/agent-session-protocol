import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs"
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
  /**
   * Last-modified time of the session's JSONL file (ms since epoch).
   * Used as a tiebreaker when multiple candidate sessions match the same
   * cwd — the session actively being written to has the newest mtime.
   */
  mtime: number
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
  const projectsDir = join(home, `.claude`, `projects`)
  const sessions: Array<DiscoveredSession> = []
  const seen = new Set<string>()

  // Pass 1: lock files in `~/.claude/sessions/`. Only interactive Claude
  // Code processes drop these (`{pid, sessionId, cwd}`); they're how we
  // know whether a session is currently `active`. Non-interactive `-p`
  // runs do NOT drop a lock file, so we need pass 2 below to see them.
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
          projectsDir,
          sanitized,
          `${sessionId}.jsonl`
        )
        let jsonlStat
        try {
          jsonlStat = await stat(jsonlPath)
        } catch {
          continue
        }

        sessions.push({
          agent: `claude`,
          sessionId,
          path: jsonlPath,
          cwd,
          active: pid != null && isProcessAlive(pid),
          mtime: jsonlStat.mtimeMs,
        })
        seen.add(sessionId)
      } catch {
        continue
      }
    }
  } catch {
    // sessions dir doesn't exist
  }

  // Pass 2: enumerate `~/.claude/projects/<sanitized-cwd>/*.jsonl`
  // directly. This catches sessions written by `claude -p` (no lock
  // file), historical sessions whose lock files have since been pruned,
  // and any other path that bypasses the interactive entrypoint. We
  // recover the true `cwd` by reading the first event in the JSONL
  // that carries one (Claude logs `cwd` on every user-turn event), so
  // un-sanitizing the directory name (lossy for paths with `-`) is
  // unnecessary.
  try {
    const subdirs = await readdir(projectsDir, { withFileTypes: true })
    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) continue
      const dirPath = join(projectsDir, subdir.name)
      let entries
      try {
        entries = await readdir(dirPath)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith(`.jsonl`)) continue
        const sessionId = entry.slice(0, -`.jsonl`.length)
        if (seen.has(sessionId)) continue

        const filePath = join(dirPath, entry)
        let fileStat
        try {
          fileStat = await stat(filePath)
        } catch {
          continue
        }

        let cwd: string | undefined
        try {
          const content = await readFile(filePath, `utf8`)
          for (const line of content.split(`\n`)) {
            if (!line || !line.includes(`"cwd"`)) continue
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>
              const found = parsed.cwd
              if (typeof found === `string` && found.length > 0) {
                cwd = found
                break
              }
            } catch {
              // skip malformed line
            }
          }
        } catch {
          // skip unreadable file
        }

        sessions.push({
          agent: `claude`,
          sessionId,
          path: filePath,
          cwd,
          // Without a lock file we can't know if a process is attached,
          // so report inactive. Callers needing live attachment should
          // cross-check against `~/.claude/sessions/`.
          active: false,
          mtime: fileStat.mtimeMs,
        })
        seen.add(sessionId)
      }
    }
  } catch {
    // projects dir doesn't exist
  }

  // Sort newest-first so `pickLatestSession` and `discoverNewestSession`
  // get the most-recently-written session at the head of the list.
  sessions.sort((a, b) => b.mtime - a.mtime)
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

        let fileMtime = 0
        try {
          const st = await stat(filePath)
          fileMtime = st.mtimeMs
        } catch {
          // skip — leave mtime at 0
        }

        sessions.push({
          agent: `codex`,
          sessionId: threadId,
          path: filePath,
          cwd,
          active: false, // can't easily detect active Codex sessions
          mtime: fileMtime,
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
 *   2. No sessionId given → layered auto-pick (see `pickLatestSession`).
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
    : pickLatestSession(sessions)

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

/**
 * Choose a session when the caller didn't pass a sessionId. Layered to
 * pick the one the caller most likely means:
 *
 *   1. Active session whose cwd matches `process.cwd()` → newest mtime.
 *      This is the case when `capi export` runs inside an agent session
 *      invoking its own `/share` skill — the calling agent's JSONL is
 *      the one being actively appended to in that directory.
 *   2. Any active session → newest mtime. When the caller's cwd doesn't
 *      match any running agent (e.g. running `capi` from a shell in a
 *      different directory), the most-recently-active agent wins.
 *   3. No active sessions → most recently modified session overall.
 *
 * Cwd comparison uses both the raw string and the realpath-resolved form
 * to handle symlink paths like `/tmp` → `/private/tmp` on macOS.
 */
function pickLatestSession(
  sessions: Array<DiscoveredSession>
): DiscoveredSession | undefined {
  if (sessions.length === 0) return undefined

  const activeCwd = process.cwd()
  let resolvedCwd = activeCwd
  try {
    resolvedCwd = realpathSync(activeCwd)
  } catch {
    // cwd might not exist on disk in exotic shells — fall back to raw
  }

  const cwdMatches = (s: DiscoveredSession): boolean =>
    s.cwd != null && (s.cwd === activeCwd || s.cwd === resolvedCwd)

  const byMtimeDesc = (a: DiscoveredSession, b: DiscoveredSession): number =>
    b.mtime - a.mtime

  const activeMatching = sessions
    .filter((s) => s.active && cwdMatches(s))
    .sort(byMtimeDesc)
  if (activeMatching[0]) return activeMatching[0]

  const activeAny = sessions.filter((s) => s.active).sort(byMtimeDesc)
  if (activeAny[0]) return activeAny[0]

  return sessions.slice().sort(byMtimeDesc)[0]
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
