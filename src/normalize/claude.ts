import { normalizeToolName } from "../tools.js"
import type { NormalizedEvent, NormalizeOptions } from "../types.js"

export interface ClaudeEntry {
  type?: string
  subtype?: string
  timestamp?: string
  uuid?: string
  sessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  message?: {
    role?: string
    model?: string
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    stop_reason?: string
  }
  durationMs?: number
  messageCount?: number
  error?: {
    status?: number
    error?: {
      type?: string
      message?: string
    }
  }
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
  level?: string
  request?: {
    subtype?: string
    tool_name?: string
    input?: Record<string, unknown>
  }
  request_id?: string | number
  response?: {
    request_id?: string | number
    subtype?: string
    response?: Record<string, unknown>
  }
  data?: {
    type?: string
  }
  permissionMode?: string
  [key: string]: unknown
}

function parseTimestamp(entry: ClaudeEntry): number {
  if (entry.timestamp) {
    const ms = Date.parse(entry.timestamp)
    if (Number.isFinite(ms)) return ms
  }
  return Date.now()
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === `string`) return content
  if (!Array.isArray(content)) return ``

  return content
    .filter(
      (block: Record<string, unknown>) =>
        block.type === `text` && typeof block.text === `string`
    )
    .map((block: Record<string, unknown>) => block.text as string)
    .join(`\n`)
}

/**
 * Unwrap the `<channel source="..." user="..." ts="...">...</channel>`
 * envelope that Claude Code wraps queue-channel submissions in. Both
 * direct user messages (the first prompt in a burst) and queued_command
 * attachments (subsequent prompts) carry this wrapper. Returning the
 * inner text + extracted attributes lets the normalized event render
 * cleanly in viewers and lets a `user_message_queued` event be paired
 * with its eventual delivered `user_message` via `channelTs`.
 */
function unwrapChannelEnvelope(text: string): {
  text: string
  user?: { name: string }
  channelTs?: number
} {
  const trimmed = text.trim()
  const outer = trimmed.match(/^<channel\s+([^>]+)>([\s\S]*?)<\/channel>$/)
  if (!outer) return { text }
  const attrs = outer[1]!
  const inner = outer[2]!.trim()
  const userMatch = attrs.match(/user="([^"]*)"/)
  const tsMatch = attrs.match(/ts="(\d+)"/)
  return {
    text: inner,
    user: userMatch ? { name: userMatch[1]! } : undefined,
    channelTs: tsMatch ? parseInt(tsMatch[1]!, 10) : undefined,
  }
}

function findLastCompactionIndex(entries: Array<ClaudeEntry>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === `system` && entry.subtype === `compact_boundary`) {
      return i
    }
  }
  return 0
}

/**
 * Normalize a single Claude session entry — one parsed JSONL line, or
 * one `SDKMessage` from `@anthropic-ai/claude-agent-sdk` (the SDK and
 * the JSONL share a shape: each JSONL line is a serialized SDKMessage).
 *
 * Returns zero or more `NormalizedEvent`s. The function is pure: no
 * cross-event state is carried, so callers driving a live SDK stream
 * can iterate the SDK's async iterator and feed each event in
 * directly. Cross-event semantics that the batch API depends on
 * (auto-injecting a synthetic `session_init` when the file lacks one,
 * filtering "from the last compaction") live in `normalizeClaude`,
 * which composes this function over a parsed file.
 */
export function normalizeClaudeEvent(
  entry: ClaudeEntry
): Array<NormalizedEvent> {
  const ts = parseTimestamp(entry)
  const out: Array<NormalizedEvent> = []

  if (entry.type === `system`) {
    if (entry.subtype === `init`) {
      out.push({
        v: 1,
        ts,
        type: `session_init`,
        sessionId: entry.sessionId ?? ``,
        cwd: entry.cwd ?? ``,
        model:
          entry.message?.model ??
          ((entry as Record<string, unknown>).model as string | undefined),
        agent: `claude`,
        agentVersion: entry.version,
        git: entry.gitBranch ? { branch: entry.gitBranch } : undefined,
      })
      return out
    }

    if (entry.subtype === `compact_boundary`) {
      out.push({ v: 1, ts, type: `compaction` })
      return out
    }

    if (entry.subtype === `turn_duration`) {
      out.push({
        v: 1,
        ts,
        type: `turn_complete`,
        success: true,
        durationMs: entry.durationMs,
      })
      return out
    }

    if (entry.subtype === `api_error`) {
      out.push({
        v: 1,
        ts,
        type: `error`,
        code: entry.error?.error?.type,
        message:
          entry.error?.error?.message ?? `API error ${entry.error?.status}`,
        retryable: (entry.retryAttempt ?? 0) < (entry.maxRetries ?? 0),
        retryAttempt: entry.retryAttempt,
        maxRetries: entry.maxRetries,
      })
      return out
    }

    // skip other system subtypes
    return out
  }

  if (entry.type === `user`) {
    const content = entry.message?.content

    if (Array.isArray(content)) {
      // Check for tool_result blocks
      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b.type === `tool_result`) {
          const output =
            typeof b.content === `string`
              ? b.content
              : Array.isArray(b.content)
                ? (b.content as Array<Record<string, unknown>>)
                    .map((p) =>
                      typeof p.text === `string`
                        ? p.text
                        : JSON.stringify(p)
                    )
                    .join(``)
                : JSON.stringify(b.content ?? ``)

          out.push({
            v: 1,
            ts,
            type: `tool_result`,
            callId: String(b.tool_use_id ?? ``),
            output,
            isError: b.is_error === true,
          })
        }
      }

      // Also extract user text
      const text = extractTextFromContent(content)
      if (text) {
        const { text: unwrapped, user, channelTs } = unwrapChannelEnvelope(text)
        out.push({
          v: 1,
          ts,
          type: `user_message`,
          text: unwrapped,
          ...(user && { user }),
          ...(channelTs !== undefined && { channelTs }),
        })
      }
    } else if (typeof content === `string` && content) {
      const { text: unwrapped, user, channelTs } =
        unwrapChannelEnvelope(content)
      out.push({
        v: 1,
        ts,
        type: `user_message`,
        text: unwrapped,
        ...(user && { user }),
        ...(channelTs !== undefined && { channelTs }),
      })
    }

    return out
  }

  // Queue-channel submissions that arrive while the agent is mid-turn
  // are first recorded as queue-operation "enqueue" entries. The
  // matching delivered event (type="attachment" / "queued_command"
  // below) won't appear until the agent drains the queue. Emit a
  // `user_message_queued` up front so viewers can render an in-flight
  // "queued" bubble that transitions to the delivered `user_message`
  // via the shared channelTs.
  if (
    entry.type === `queue-operation` &&
    (entry as Record<string, unknown>).operation === `enqueue`
  ) {
    const content = (entry as Record<string, unknown>).content
    if (typeof content === `string` && content.length > 0) {
      const { text: unwrapped, user, channelTs } =
        unwrapChannelEnvelope(content)
      if (channelTs !== undefined) {
        out.push({
          v: 1,
          ts,
          type: `user_message_queued`,
          text: unwrapped,
          ...(user && { user }),
          channelTs,
        })
      }
    }
    return out
  }

  // Claude Code stores prompts that arrive while an assistant turn is
  // already in flight (e.g. queue-channel submissions from the viewer)
  // as type="attachment" with attachment.type="queued_command". They
  // never get rewritten into type="user" entries, so without this
  // branch only the first prompt in a burst makes it into the
  // normalized stream.
  if (entry.type === `attachment`) {
    const attachment = (entry as Record<string, unknown>).attachment as
      | Record<string, unknown>
      | undefined
    if (
      attachment?.type === `queued_command` &&
      typeof attachment.prompt === `string` &&
      attachment.prompt.length > 0
    ) {
      const { text: unwrapped, user, channelTs } = unwrapChannelEnvelope(
        attachment.prompt
      )
      out.push({
        v: 1,
        ts,
        type: `user_message`,
        text: unwrapped,
        ...(user && { user }),
        ...(channelTs !== undefined && { channelTs }),
      })
    }
    return out
  }

  if (
    entry.type === `assistant` ||
    (!entry.type && entry.message?.role === `assistant`)
  ) {
    const content = entry.message?.content
    if (!Array.isArray(content)) return out

    for (const block of content) {
      const b = block as Record<string, unknown>

      if (b.type === `thinking`) {
        const thinkingText =
          typeof b.thinking === `string` && b.thinking.length > 0
            ? b.thinking
            : null
        out.push({
          v: 1,
          ts,
          type: `thinking`,
          summary:
            typeof b.thinking === `string` && b.thinking.length > 0
              ? b.thinking.slice(0, 200)
              : `(thinking)`,
          text: thinkingText,
        })
        continue
      }

      if (b.type === `text` && typeof b.text === `string` && b.text) {
        out.push({
          v: 1,
          ts,
          type: `assistant_message`,
          text: b.text,
        })
        continue
      }

      if (b.type === `tool_use`) {
        const mapping = normalizeToolName(
          String(b.name ?? ``),
          `claude`,
          b.input as Record<string, unknown> | undefined
        )

        out.push({
          v: 1,
          ts,
          type: `tool_call`,
          callId: String(b.id ?? ``),
          tool: mapping.normalized,
          originalTool: mapping.originalTool,
          originalAgent: `claude`,
          input: (b.input as Record<string, unknown>) ?? {},
        })
        continue
      }
    }

    // Emit turn_complete if this was the final assistant message
    if (entry.message?.stop_reason === `end_turn` && entry.message.usage) {
      const usage = entry.message.usage
      out.push({
        v: 1,
        ts,
        type: `turn_complete`,
        success: true,
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens:
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0),
        },
      })
    }

    return out
  }

  if (entry.type === `result`) {
    out.push({
      v: 1,
      ts,
      type: `turn_complete`,
      success: entry.subtype === `success`,
      usage: entry.message?.usage
        ? {
            inputTokens: entry.message.usage.input_tokens,
            outputTokens: entry.message.usage.output_tokens,
          }
        : undefined,
      durationMs: entry.durationMs,
    })
    return out
  }

  // skip: progress, file-history-snapshot, last-prompt, etc.
  return out
}

export function normalizeClaude(
  lines: Array<string>,
  options: NormalizeOptions = {}
): Array<NormalizedEvent> {
  const { fromCompaction = true } = options

  const entries: Array<ClaudeEntry> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as ClaudeEntry)
    } catch {
      // skip malformed lines
    }
  }

  const startIndex = fromCompaction ? findLastCompactionIndex(entries) : 0
  const events: Array<NormalizedEvent> = []

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i]!
    for (const ev of normalizeClaudeEvent(entry)) events.push(ev)
  }

  // Inject session_init from first entry metadata if none emitted
  if (!events.some((e) => e.type === `session_init`) && entries.length > 0) {
    const first = entries[startIndex]
    if (first) {
      events.unshift({
        v: 1,
        ts: parseTimestamp(first),
        type: `session_init`,
        sessionId: first.sessionId ?? ``,
        cwd: first.cwd ?? ``,
        agent: `claude`,
        agentVersion: first.version,
        git: first.gitBranch ? { branch: first.gitBranch } : undefined,
      })
    }
  }

  return events
}
