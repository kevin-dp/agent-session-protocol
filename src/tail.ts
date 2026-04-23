import { advanceCursor } from "./load.js"
import type { SessionCursor } from "./load.js"
import type { NormalizedEvent } from "./types.js"

export interface TailOptions {
  /**
   * Cursor from a prior `loadSession` or `tailSession` call. Reads all
   * appends between the cursor position and the file's current size.
   */
  cursor: SessionCursor
}

export interface TailResult {
  /** Cursor advanced past the newly consumed bytes. Pass into the next `tailSession` call. */
  cursor: SessionCursor
  /** Events appended to the session since the input cursor. Empty if nothing new. */
  newEvents: Array<NormalizedEvent>
  /** Native JSONL lines appended since the input cursor. Empty if nothing new. */
  newRawLines: Array<string>
}

/**
 * One-shot delta read. Given a cursor from a prior `loadSession` /
 * `tailSession` call, returns any events and raw lines appended since
 * that cursor was created, along with an advanced cursor.
 *
 * Does not watch or poll — the caller drives when this runs (interval,
 * webhook, manual trigger, etc.). Safe to call repeatedly with the same
 * cursor (returns no delta until the file grows).
 *
 * If the file has been truncated (size shrank below the cursor's
 * offset), the cursor is reset to zero and the entire file is re-read.
 */
export async function tailSession(options: TailOptions): Promise<TailResult> {
  // Drop the synthetic `session_init` that normalize() auto-injects when
  // its input lacks one — the prior load already emitted a session_init,
  // and this call represents a continuation.
  return advanceCursor(options.cursor, { dropSyntheticInit: true })
}
