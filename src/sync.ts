import type { HeadersRecord } from "@durable-streams/client"
import {
  buildHeaders,
  createOrConnectStream,
  pushLines,
} from "./ds-utils.js"
import { loadSession } from "./load.js"
import { resolveSession } from "./sessions.js"
import type { AgentType, NormalizedEvent } from "./types.js"

export type SyncProgressEvent =
  | {
      type: "session-found"
      sessionId: string
      path: string
      agent: AgentType
    }
  | { type: "normalized-pushed"; count: number }
  | { type: "native-pushed"; count: number; agent: AgentType }
  | { type: "queue-stream-ready"; queueUrl: string }
  | { type: "queue-stream-failed"; reason: string }
  | { type: "live-watching"; path: string }
  | { type: "live-batch"; native: number; normalized: number }
  | { type: "live-stopping" }
  | { type: "live-error"; message: string }

export interface SyncOptions {
  /** Session ID. If omitted, picks the active session, else most recent. */
  sessionId?: string
  /** Agent type. If omitted, autodetected from discovered sessions. */
  agent?: AgentType
  /** Durable Streams base URL (e.g. `https://ds.example.com`). */
  serverUrl: string
  /** Bearer auth token for the DS server. */
  token?: string
  /**
   * Share-ID suffix in the stream URL: `/asp/{sessionId}/{shareId}`.
   * Defaults to `"live"` so repeated calls append to the same stream.
   */
  shareId?: string
  /**
   * Strip /share skill-invocation rounds from the pushed normalized
   * stream. Default `true`. Has no effect on the native stream, which
   * always ships the full native JSONL so same-agent lossless resume
   * reconstructs the original `parentUuid` chain.
   */
  filterSkills?: boolean
  /**
   * When true, performs an initial push and starts a file watcher that
   * streams further appends to the same DS URL. Creates a prompt-queue
   * stream (`{url}/prompts`) so viewers can submit prompts during the
   * share. Caller must invoke `result.stop()` to emit `session_end` and
   * close the watcher cleanly.
   */
  live?: boolean
  /** Progress callback for intermediate events (logging, UI, etc.). */
  onProgress?: (event: SyncProgressEvent) => void
}

export interface SyncResult {
  /** DS URL the normalized events were pushed to. */
  url: string
  /** Same as `url` — kept for symmetry with older APIs. */
  baseUrl: string
  /** Native-JSONL stream URL (under `{baseUrl}/native/{agent}`). */
  nativeUrl: string
  sessionId: string
  agent: AgentType
  /** New native lines appended this call (initial push only in live mode). */
  nativePushed: number
  /** New normalized events appended this call (initial push only in live mode). */
  normalizedPushed: number
  /** Total normalized events in the session (local file) after this call. */
  totalEvents: number
  /**
   * Present when `live: true`. URL that accepts POSTed user prompts for
   * live collaboration.
   */
  queueUrl?: string
  /**
   * Present when `live: true`. Stops the watcher, emits `session_end` on
   * the normalized stream, and resolves once both have flushed.
   */
  stop?: () => Promise<void>
}

/**
 * Read the session's local JSONL, compute the diff against the DS stream,
 * and push new entries. In `live: true` mode, additionally watches the
 * source file and pushes deltas as the session grows.
 *
 * The stream URL is `/asp/{sessionId}/{shareId}` where shareId defaults to
 * `"live"`. Repeated calls with the same options produce a continuously
 * updated stream.
 */
export async function syncSession(options: SyncOptions): Promise<SyncResult> {
  const {
    sessionId,
    agent: requestedAgent,
    serverUrl,
    token,
    shareId = `live`,
    filterSkills = true,
    live = false,
    onProgress,
  } = options

  const headers = buildHeaders(token)

  // Resolve session metadata first so we can construct URLs before the
  // live watcher is started (the onUpdate callback needs them).
  const meta = await resolveSession(sessionId, requestedAgent)
  const baseUrl = `${serverUrl.replace(/\/$/, ``)}/asp/${meta.sessionId}/${shareId}`
  const normalizedUrl = baseUrl
  const nativeUrl = `${baseUrl}/native/${meta.agent}`

  const loaded = await loadSession({
    sessionId: meta.sessionId,
    agent: meta.agent,
    filterSkills,
    live,
    onUpdate: live
      ? (delta) =>
          pushDelta(delta, headers, nativeUrl, normalizedUrl, onProgress)
      : undefined,
  })

  onProgress?.({
    type: `session-found`,
    sessionId: loaded.sessionId,
    path: loaded.path,
    agent: loaded.agent,
  })

  const normalizedLines = loaded.events.map((e) => JSON.stringify(e))
  const normalizedPushed = await pushLines(
    normalizedUrl,
    normalizedLines,
    headers
  )
  onProgress?.({ type: `normalized-pushed`, count: normalizedPushed })

  const nativePushed = await pushLines(nativeUrl, loaded.rawLines, headers)
  onProgress?.({
    type: `native-pushed`,
    count: nativePushed,
    agent: loaded.agent,
  })

  const base = {
    url: normalizedUrl,
    baseUrl,
    nativeUrl,
    sessionId: loaded.sessionId,
    agent: loaded.agent,
    nativePushed,
    normalizedPushed,
    totalEvents: loaded.events.length,
  }

  if (!live) return base

  // Create the prompt-queue stream so viewers can POST user prompts
  // alongside the shared session.
  const queueUrl = `${baseUrl}/prompts`
  try {
    await createOrConnectStream(queueUrl, `application/json`, headers)
    onProgress?.({ type: `queue-stream-ready`, queueUrl })
  } catch (error) {
    onProgress?.({
      type: `queue-stream-failed`,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  onProgress?.({ type: `live-watching`, path: loaded.path })

  // Wrap the load watcher's stop() to also emit session_end on the
  // normalized stream before resolving.
  const normalizedStream = await createOrConnectStream(
    normalizedUrl,
    `application/json`,
    headers
  )
  const loadStop = loaded.stop
  async function stop(): Promise<void> {
    onProgress?.({ type: `live-stopping` })
    try {
      await loadStop?.()
    } catch (error) {
      onProgress?.({
        type: `live-error`,
        message: `Failed to stop watcher: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
    try {
      const endEvent: NormalizedEvent = {
        v: 1,
        ts: Date.now(),
        type: `session_end`,
      }
      await normalizedStream.append(JSON.stringify(endEvent))
    } catch (error) {
      onProgress?.({
        type: `live-error`,
        message: `Failed to emit session_end: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
    }
  }

  return { ...base, queueUrl, stop }
}

async function pushDelta(
  delta: { newEvents: Array<NormalizedEvent>; newRawLines: Array<string> },
  headers: HeadersRecord,
  nativeUrl: string,
  normalizedUrl: string,
  onProgress: ((event: SyncProgressEvent) => void) | undefined
): Promise<void> {
  try {
    const nativeStream = await createOrConnectStream(
      nativeUrl,
      `application/json`,
      headers
    )
    const normalizedStream = await createOrConnectStream(
      normalizedUrl,
      `application/json`,
      headers
    )

    await Promise.all(
      delta.newRawLines.map((line) => nativeStream.append(line))
    )
    if (delta.newEvents.length > 0) {
      await Promise.all(
        delta.newEvents.map((e) => normalizedStream.append(JSON.stringify(e)))
      )
    }
    onProgress?.({
      type: `live-batch`,
      native: delta.newRawLines.length,
      normalized: delta.newEvents.length,
    })
  } catch (error) {
    onProgress?.({
      type: `live-error`,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
