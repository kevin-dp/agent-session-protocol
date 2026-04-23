import { createReadStream, readFileSync, statSync, watch } from "node:fs"
import { resolveSession } from "./sessions.js"
import { SkillInvocationFilter } from "./filter-skill-invocations.js"
import { normalize } from "./normalize.js"
import type { SkillInvocationFilterState } from "./filter-skill-invocations.js"
import type { AgentType, NormalizedEvent } from "./types.js"

/**
 * Cursor tracking a caller's read position inside a session's JSONL
 * file. Produced by `loadSession` and `tailSession`; pass it back into
 * `tailSession` to resume reading from where you left off.
 *
 * Safe to persist across process restarts via `serializeCursor` /
 * `deserializeCursor`. The `path` field is a local filesystem path, so
 * when moving across hosts, the caller should re-resolve it (e.g. via
 * `resolveSession(sessionId, agent)`) before deserializing.
 */
export interface SessionCursor {
  /** Path to the session's JSONL file (captured for convenience). */
  path: string
  agent: AgentType
  /** Byte offset into the file that was fully consumed. */
  byteOffset: number
  /** Trailing bytes after the last newline seen, carried into the next read. */
  partialLineBuffer: string
  /**
   * Skill-invocation filter, preserved across tail calls so that skill
   * rounds straddling call boundaries are stripped as a single round.
   * `null` when the caller opted out of filtering.
   */
  skillFilter: SkillInvocationFilter | null
}

/**
 * Plain-object, JSON-serializable snapshot of a `SessionCursor`. Produced
 * by `serializeCursor`; round-tripped back into a live cursor by
 * `deserializeCursor`.
 */
export interface SerializedSessionCursor {
  /** Format version. Bumped on breaking changes to this shape. */
  v: 1
  path: string
  agent: AgentType
  byteOffset: number
  partialLineBuffer: string
  /** Null when the source cursor was created with `filterSkills: false`. */
  skillFilter: SkillInvocationFilterState | null
}

/** Convert a live cursor into a JSON-serializable snapshot. */
export function serializeCursor(cursor: SessionCursor): SerializedSessionCursor {
  return {
    v: 1,
    path: cursor.path,
    agent: cursor.agent,
    byteOffset: cursor.byteOffset,
    partialLineBuffer: cursor.partialLineBuffer,
    skillFilter: cursor.skillFilter ? cursor.skillFilter.getState() : null,
  }
}

/**
 * Reconstruct a live cursor from a snapshot produced by `serializeCursor`.
 * When moving across machines, override `path` on the serialized input
 * before calling this (the library does not re-resolve paths).
 */
export function deserializeCursor(
  serialized: SerializedSessionCursor
): SessionCursor {
  let filter: SkillInvocationFilter | null = null
  if (serialized.skillFilter !== null) {
    filter = new SkillInvocationFilter(serialized.agent)
    filter.setState(serialized.skillFilter)
  }
  return {
    path: serialized.path,
    agent: serialized.agent,
    byteOffset: serialized.byteOffset,
    partialLineBuffer: serialized.partialLineBuffer,
    skillFilter: filter,
  }
}

export interface LoadUpdate {
  /** Newly appended normalized events since the last update (or initial load). */
  newEvents: Array<NormalizedEvent>
  /** Newly appended native JSONL lines since the last update (or initial load). */
  newRawLines: Array<string>
}

export interface LoadOptions {
  /** Session ID. If omitted, picks the active session, else most recent. */
  sessionId?: string
  /** Agent type. If omitted, autodetected from discovered sessions. */
  agent?: AgentType
  /**
   * Strip /share skill-invocation rounds from the normalized `events`
   * stream. Default `true`. Has no effect on `rawLines`, which always
   * reflects the full native JSONL (filtering would break `parentUuid`
   * chains when messages outside a skill round reference uuids inside
   * it — hurting same-agent lossless resume).
   */
  filterSkills?: boolean
  /**
   * When true, the returned result contains the initial snapshot AND a
   * filesystem watcher is started. Each time the source JSONL file grows,
   * `onUpdate` is invoked with the newly-appended events/lines. Call
   * `stop()` to close the watcher.
   */
  live?: boolean
  /** Callback invoked in live mode on every delta. Ignored unless `live: true`. */
  onUpdate?: (delta: LoadUpdate) => void | Promise<void>
}

export interface LoadResult {
  sessionId: string
  agent: AgentType
  /** Working directory recorded in the session metadata (if known). */
  cwd?: string
  /** Absolute path to the source JSONL file. */
  path: string
  /** Normalized events from the session (after optional skill filtering). */
  events: Array<NormalizedEvent>
  /** Native JSONL lines (after optional skill filtering). */
  rawLines: Array<string>
  /**
   * Cursor positioned just after the last consumed byte. Pass to
   * `tailSession` to read subsequent appends without rescanning the file.
   */
  cursor: SessionCursor
  /**
   * Present only when `live: true`. Closes the file watcher. Safe to
   * call more than once.
   */
  stop?: () => Promise<void>
}

export function readByteRange(
  path: string,
  start: number,
  end: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (end <= start) {
      resolve(``)
      return
    }
    const chunks: Array<Buffer> = []
    const stream = createReadStream(path, {
      start,
      end: end - 1,
      encoding: `utf8`,
    })
    stream.on(`data`, (chunk) => {
      chunks.push(typeof chunk === `string` ? Buffer.from(chunk) : chunk)
    })
    stream.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf8`)))
    stream.on(`error`, reject)
  })
}

/**
 * Consume new bytes from `cursor.byteOffset` to the file's current size,
 * split into lines, apply the cursor's skill filter, normalize, and
 * advance the cursor. Returned cursor is a fresh object — the input
 * cursor is not mutated (except for the internal skill-filter state,
 * which is designed to be carried forward).
 */
export async function advanceCursor(
  cursor: SessionCursor,
  opts: { fromCompaction?: boolean; dropSyntheticInit?: boolean } = {}
): Promise<{
  cursor: SessionCursor
  newEvents: Array<NormalizedEvent>
  newRawLines: Array<string>
}> {
  const stat = statSync(cursor.path)
  // File truncated / replaced — reset to beginning. Caller should treat
  // this as a fresh load if they care about prior state; we just re-read
  // from offset 0.
  if (stat.size < cursor.byteOffset) {
    const reset: SessionCursor = {
      ...cursor,
      byteOffset: 0,
      partialLineBuffer: ``,
    }
    return advanceCursor(reset, opts)
  }
  if (stat.size === cursor.byteOffset) {
    return { cursor, newEvents: [], newRawLines: [] }
  }

  const newBytes = await readByteRange(
    cursor.path,
    cursor.byteOffset,
    stat.size
  )
  const combined = cursor.partialLineBuffer + newBytes
  const lastNewlineIdx = combined.lastIndexOf(`\n`)
  let completeChunk: string
  let newPartial: string
  if (lastNewlineIdx === -1) {
    completeChunk = ``
    newPartial = combined
  } else {
    completeChunk = combined.slice(0, lastNewlineIdx)
    newPartial = combined.slice(lastNewlineIdx + 1)
  }

  const nextCursor: SessionCursor = {
    ...cursor,
    byteOffset: stat.size,
    partialLineBuffer: newPartial,
  }

  const unfilteredNewLines = completeChunk
    .split(`\n`)
    .filter((l) => l.trim())
  if (unfilteredNewLines.length === 0) {
    return { cursor: nextCursor, newEvents: [], newRawLines: [] }
  }

  // The skill filter affects only the NORMALIZED events — /share skill
  // rounds get stripped from what viewers/consumers see. Raw native
  // lines pass through unfiltered so downstream same-agent resume
  // preserves the original parentUuid chain (stripping skill-round
  // uuids would break references from later messages that parent into
  // the filtered range).
  const linesToNormalize = cursor.skillFilter
    ? cursor.skillFilter.feed(unfilteredNewLines)
    : unfilteredNewLines

  let newEvents: Array<NormalizedEvent> = []
  if (linesToNormalize.length > 0) {
    newEvents = normalize(linesToNormalize, cursor.agent, {
      fromCompaction: opts.fromCompaction ?? false,
    })
    if (opts.dropSyntheticInit ?? false) {
      newEvents = newEvents.filter((e) => e.type !== `session_init`)
    }
  }

  return { cursor: nextCursor, newEvents, newRawLines: unfilteredNewLines }
}

interface LiveWatcher {
  stop: () => Promise<void>
}

function startLiveWatcher(
  initialCursor: SessionCursor,
  onUpdate: (delta: LoadUpdate) => void | Promise<void>
): LiveWatcher {
  let cursor = initialCursor
  let busy = false
  let pending = false
  let stopping = false

  async function processChanges(): Promise<void> {
    if (stopping) return
    if (busy) {
      pending = true
      return
    }
    busy = true
    try {
      const {
        cursor: next,
        newEvents,
        newRawLines,
      } = await advanceCursor(cursor, { dropSyntheticInit: true })
      cursor = next
      if (newRawLines.length === 0) return
      await onUpdate({ newEvents, newRawLines })
    } finally {
      busy = false
      // eslint can't see that `stopping` is reassigned inside the stop()
      // closure below, so it thinks `!stopping` is always true.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (pending && !stopping) {
        pending = false
        void processChanges()
      }
    }
  }

  const watcher = watch(cursor.path, () => {
    void processChanges()
  })
  // Poll every 2s as a safety net (fs.watch can miss events on macOS/NFS).
  const pollInterval = setInterval(() => {
    void processChanges()
  }, 2000)

  let stopped = false
  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    stopping = true
    clearInterval(pollInterval)
    watcher.close()
    while (busy) {
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  return { stop }
}

/**
 * Read a local agent session, filter out /share skill bookkeeping, and
 * normalize it into a common event stream. Does not touch the network.
 *
 * In `live: true` mode, the result also contains a `stop()` handle;
 * until stopped, each new append to the source JSONL triggers an
 * `onUpdate` callback with the new events/lines.
 *
 * In all modes the result carries a `cursor` that can be passed to
 * `tailSession` later for poll-based delta reads.
 */
export async function loadSession(
  options: LoadOptions
): Promise<LoadResult> {
  const {
    sessionId,
    agent: requestedAgent,
    filterSkills = true,
    live = false,
    onUpdate,
  } = options

  const session = await resolveSession(sessionId, requestedAgent)
  const agent = session.agent

  const content = readFileSync(session.path, `utf8`)
  // Preserve trailing partial-line bytes so a subsequent `tailSession`
  // call starting from this cursor doesn't emit a truncated record.
  const lastNewlineIdx = content.lastIndexOf(`\n`)
  let completeChunk: string
  let partialLineBuffer: string
  if (lastNewlineIdx === -1) {
    completeChunk = ``
    partialLineBuffer = content
  } else {
    completeChunk = content.slice(0, lastNewlineIdx)
    partialLineBuffer = content.slice(lastNewlineIdx + 1)
  }

  const unfilteredLines = completeChunk
    .split(`\n`)
    .filter((l) => l.trim())
  const skillFilter = filterSkills ? new SkillInvocationFilter(agent) : null
  // The skill filter affects only the NORMALIZED events — /share skill
  // rounds get stripped from what viewers/consumers see. Raw native
  // lines pass through unfiltered so downstream same-agent resume
  // preserves the original parentUuid chain (stripping skill-round
  // uuids would break references from later messages that parent into
  // the filtered range).
  const linesToNormalize = skillFilter
    ? skillFilter.feed(unfilteredLines)
    : unfilteredLines
  const events = normalize(linesToNormalize, agent)
  const rawLines = unfilteredLines

  const byteOffset = statSync(session.path).size
  const cursor: SessionCursor = {
    path: session.path,
    agent,
    byteOffset,
    partialLineBuffer,
    skillFilter,
  }

  const result: LoadResult = {
    sessionId: session.sessionId,
    agent,
    cwd: session.cwd,
    path: session.path,
    events,
    rawLines,
    cursor,
  }

  if (!live) return result

  const cb = onUpdate ?? (() => {})
  const watcher = startLiveWatcher(cursor, cb)
  result.stop = watcher.stop
  return result
}
