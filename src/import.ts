import { randomUUID } from "node:crypto"
import { buildHeaders, readStream, streamExists } from "./ds-utils.js"
import {
  getClaudeFirstUserPrompt,
  registerClaudeHistoryEntry,
  rewriteNativeLines,
  writeClaudeSession,
  writeCodexSession,
} from "./sessions.js"
import { denormalize } from "./denormalize.js"
import type { AgentType, NormalizedEvent } from "./types.js"

export type ImportProgressEvent =
  | { type: "short-url-resolved"; from: string; to: string }
  | { type: "using-native" }
  | { type: "using-normalized"; eventCount: number }
  | { type: "denormalized"; lineCount: number }
  | {
      type: "rewritten"
      count: number
      oldSessionId: string
      newSessionId: string
    }
  | { type: "written"; path: string }

export interface ImportOptions {
  /** DS stream URL or short URL that resolves to one. */
  url: string
  /** Target agent to materialize the session into. */
  agent: AgentType
  /** Target working directory for the imported session. Defaults to `process.cwd()`. */
  cwd?: string
  /** Bearer auth token for the DS server. */
  token?: string
  /** Progress callback for intermediate events (logging, UI, etc.). */
  onProgress?: (event: ImportProgressEvent) => void
}

export interface ImportResult {
  /** Absolute path to the JSONL file that was written. */
  sessionPath: string
  /** Newly-assigned session / thread ID (a fresh UUID). */
  sessionId: string
  agent: AgentType
  /** Target cwd (same as input cwd or `process.cwd()`). */
  cwd: string
  /**
   * `"native"` when a lossless same-agent resume was possible (DS had a
   * native stream for the target agent); `"normalized"` when the
   * normalized stream was denormalized into the target agent's format
   * (cross-agent resume).
   */
  mode: "native" | "normalized"
}

async function resolveShortUrl(url: string): Promise<string | null> {
  // Short URLs are registered on a shortener service and return JSON with
  // the actual DS URL when fetched with Accept: application/json.
  try {
    const response = await fetch(url, {
      headers: { accept: `application/json` },
    })
    if (!response.ok) return null
    const contentType = response.headers.get(`content-type`) ?? ``
    if (!contentType.includes(`application/json`)) return null
    const data = (await response.json()) as { fullUrl?: string }
    return data.fullUrl ?? null
  } catch {
    return null
  }
}

function extractSessionMeta(
  lines: Array<string>,
  agent: AgentType
): { sessionId: string; cwd: string } {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>

      if (agent === `claude`) {
        if (obj.sessionId && obj.cwd) {
          return {
            sessionId: String(obj.sessionId),
            cwd: String(obj.cwd),
          }
        }
      }

      if (agent === `codex` && obj.type === `session_meta`) {
        const payload = obj.payload as Record<string, unknown>
        return {
          sessionId: String(payload.id ?? ``),
          cwd: String(payload.cwd ?? ``),
        }
      }
    } catch {
      continue
    }
  }
  return { sessionId: ``, cwd: `` }
}

/**
 * Fetch a shared session from a DS URL (or short URL) and write it to the
 * local filesystem in the target agent's native format. Prefers the
 * lossless native stream (`{url}/native/{agent}`) when present; otherwise
 * denormalizes from the normalized stream.
 *
 * Does not spawn the agent — callers decide whether to launch it.
 */
export async function importSession(
  options: ImportOptions
): Promise<ImportResult> {
  const {
    url: inputUrl,
    agent,
    cwd = process.cwd(),
    token,
    onProgress,
  } = options

  const headers = buildHeaders(token)
  const newSessionId = randomUUID()

  let streamUrl = inputUrl
  const resolved = await resolveShortUrl(inputUrl)
  if (resolved) {
    streamUrl = resolved
    onProgress?.({ type: `short-url-resolved`, from: inputUrl, to: resolved })
  }

  const nativeUrl = `${streamUrl}/native/${agent}`
  const hasNative = await streamExists(nativeUrl, headers)

  let sessionPath: string
  let mode: "native" | "normalized"
  let writtenLines: Array<string>

  if (hasNative) {
    onProgress?.({ type: `using-native` })
    const nativeLines = (await readStream<string>(nativeUrl, headers)).map(
      (item) => (typeof item === `string` ? item : JSON.stringify(item))
    )
    const meta = extractSessionMeta(nativeLines, agent)
    const rewritten = rewriteNativeLines(
      nativeLines,
      agent,
      newSessionId,
      cwd,
      meta.sessionId,
      meta.cwd
    )
    onProgress?.({
      type: `rewritten`,
      count: rewritten.length,
      oldSessionId: meta.sessionId,
      newSessionId,
    })
    sessionPath =
      agent === `claude`
        ? writeClaudeSession(newSessionId, cwd, rewritten)
        : writeCodexSession(newSessionId, rewritten)
    writtenLines = rewritten
    mode = `native`
  } else {
    const events = await readStream<NormalizedEvent>(streamUrl, headers)
    onProgress?.({ type: `using-normalized`, eventCount: events.length })
    const lines = denormalize(events, agent, { sessionId: newSessionId, cwd })
    onProgress?.({ type: `denormalized`, lineCount: lines.length })
    sessionPath =
      agent === `claude`
        ? writeClaudeSession(newSessionId, cwd, lines)
        : writeCodexSession(newSessionId, lines)
    writtenLines = lines
    mode = `normalized`
  }

  onProgress?.({ type: `written`, path: sessionPath })

  // Register Claude sessions in ~/.claude/history.jsonl so `claude
  // --resume <id>` can find them. Without this entry Claude reports
  // "No conversation found with session ID" even though the JSONL file
  // is on disk.
  if (agent === `claude`) {
    const firstPrompt = getClaudeFirstUserPrompt(writtenLines)
    registerClaudeHistoryEntry(
      newSessionId,
      cwd,
      firstPrompt ?? `Imported session ${newSessionId.slice(0, 8)}`
    )
  }

  return { sessionPath, sessionId: newSessionId, agent, cwd, mode }
}
