import { normalizeToolName } from "../tools.js"
import type { NormalizedEvent, NormalizeOptions } from "../types.js"

export interface CodexEntry {
  timestamp?: string
  type: string
  payload?: Record<string, unknown>
}

function parseTimestamp(entry: CodexEntry): number {
  if (entry.timestamp) {
    const ms = Date.parse(entry.timestamp)
    if (Number.isFinite(ms)) return ms
  }
  return Date.now()
}

function findLastCompactionIndex(entries: Array<CodexEntry>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === `compacted`) {
      return i
    }
  }
  return 0
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === `string`) {
    try {
      return JSON.parse(args) as Record<string, unknown>
    } catch {
      return { raw: args }
    }
  }
  if (args && typeof args === `object`) {
    return args as Record<string, unknown>
  }
  return {}
}

/**
 * Normalize a single Codex session entry — one parsed JSONL line (the
 * `rollout-*.jsonl` format), or one event from `@openai/codex-sdk`
 * (the SDK and the JSONL share a shape: each JSONL line is a
 * serialized agent-loop event).
 *
 * Returns zero or more `NormalizedEvent`s. The function is pure: no
 * cross-event state is carried, so callers driving a live SDK stream
 * can iterate the SDK's async iterator and feed each event in
 * directly. The "filter from the last compaction" behaviour of the
 * batch API lives in `normalizeCodex`, which composes this function
 * over a parsed file.
 */
export function normalizeCodexEvent(
  entry: CodexEntry
): Array<NormalizedEvent> {
  const ts = parseTimestamp(entry)
  const payload = entry.payload ?? {}
  const out: Array<NormalizedEvent> = []

  if (entry.type === `session_meta`) {
    const git = payload.git as Record<string, unknown> | null | undefined
    out.push({
      v: 1,
      ts,
      type: `session_init`,
      sessionId: String(payload.id ?? ``),
      cwd: String(payload.cwd ?? ``),
      model: undefined,
      agent: `codex`,
      agentVersion: payload.cli_version
        ? String(payload.cli_version)
        : undefined,
      git: git
        ? {
            branch: git.branch ? String(git.branch) : undefined,
            commit: git.commit_hash ? String(git.commit_hash) : undefined,
            remote: git.repository_url
              ? String(git.repository_url)
              : undefined,
          }
        : undefined,
    })
    return out
  }

  if (entry.type === `compacted`) {
    out.push({ v: 1, ts, type: `compaction` })
    return out
  }

  if (entry.type === `event_msg`) {
    const msgType = payload.type as string | undefined

    if (msgType === `turn_aborted`) {
      out.push({
        v: 1,
        ts,
        type: `turn_aborted`,
        reason: String(payload.reason ?? `interrupted`),
      })
      return out
    }

    if (msgType === `context_compacted`) {
      out.push({ v: 1, ts, type: `compaction` })
      return out
    }

    // skip: token_count, agent_reasoning, agent_message, user_message (mirrors)
    return out
  }

  if (entry.type === `response_item`) {
    const itemType = payload.type as string | undefined

    if (itemType === `message`) {
      const role = payload.role as string | undefined
      const content = payload.content as
        | Array<Record<string, unknown>>
        | undefined

      if (role === `user`) {
        const text = content
          ?.filter((c) => typeof c.text === `string`)
          .map((c) => c.text as string)
          .join(`\n`)
        if (text) {
          out.push({ v: 1, ts, type: `user_message`, text })
        }
        return out
      }

      if (role === `assistant`) {
        const text = content
          ?.filter((c) => typeof c.text === `string`)
          .map((c) => c.text as string)
          .join(`\n`)
        if (text) {
          out.push({
            v: 1,
            ts,
            type: `assistant_message`,
            text,
            phase:
              payload.phase === `commentary`
                ? `commentary`
                : payload.phase === `final_answer`
                  ? `final`
                  : undefined,
          })
        }
        return out
      }

      // skip developer messages (system instructions)
      return out
    }

    if (itemType === `function_call`) {
      const args = parseArguments(payload.arguments)
      const mapping = normalizeToolName(
        String(payload.name ?? ``),
        `codex`,
        args
      )

      out.push({
        v: 1,
        ts,
        type: `tool_call`,
        callId: String(payload.call_id ?? ``),
        tool: mapping.normalized,
        originalTool: mapping.originalTool,
        originalAgent: `codex`,
        input: args,
      })
      return out
    }

    if (itemType === `function_call_output`) {
      out.push({
        v: 1,
        ts,
        type: `tool_result`,
        callId: String(payload.call_id ?? ``),
        output: String(payload.output ?? ``),
        isError: false,
      })
      return out
    }

    if (itemType === `custom_tool_call`) {
      const mapping = normalizeToolName(String(payload.name ?? ``), `codex`, {
        input: payload.input,
      })

      out.push({
        v: 1,
        ts,
        type: `tool_call`,
        callId: String(payload.call_id ?? ``),
        tool: mapping.normalized,
        originalTool: mapping.originalTool,
        originalAgent: `codex`,
        input:
          typeof payload.input === `string`
            ? { raw: payload.input }
            : ((payload.input as Record<string, unknown>) ?? {}),
      })
      return out
    }

    if (itemType === `custom_tool_call_output`) {
      let output = String(payload.output ?? ``)
      let isError = false

      try {
        const parsed = JSON.parse(output) as Record<string, unknown>
        if (typeof parsed.output === `string`) {
          output = parsed.output
        }
        const meta = parsed.metadata as Record<string, unknown> | undefined
        if (
          meta &&
          typeof meta.exit_code === `number` &&
          meta.exit_code !== 0
        ) {
          isError = true
        }
      } catch {
        // use raw output
      }

      out.push({
        v: 1,
        ts,
        type: `tool_result`,
        callId: String(payload.call_id ?? ``),
        output,
        isError,
      })
      return out
    }

    if (itemType === `reasoning`) {
      const summaryArr = payload.summary as
        | Array<Record<string, unknown>>
        | undefined
      const summaryText =
        summaryArr
          ?.map((s) => (typeof s.text === `string` ? s.text : ``))
          .filter(Boolean)
          .join(` `) ?? `(thinking)`

      out.push({
        v: 1,
        ts,
        type: `thinking`,
        summary: summaryText || `(thinking)`,
        text: null,
      })
      return out
    }

    if (itemType === `web_search_call`) {
      const action = payload.action as Record<string, unknown> | undefined
      const mapping = normalizeToolName(`web_search`, `codex`, {
        action,
      })

      // The original batch normaliser used the iteration index to
      // synthesize a unique callId here. For the per-event API we
      // derive a deterministic id from the payload + ts so consecutive
      // searches don't collide. (Codex's response_item for
      // web_search_call doesn't carry a `call_id` of its own.)
      const callId = (() => {
        const explicit = payload.call_id ?? payload.id
        if (typeof explicit === `string` && explicit) return explicit
        const url =
          typeof action?.url === `string` ? (action.url as string) : ``
        return `web-${ts}-${url.slice(0, 32)}`
      })()

      out.push({
        v: 1,
        ts,
        type: `tool_call`,
        callId,
        tool: mapping.normalized,
        originalTool: `web_search`,
        originalAgent: `codex`,
        input: action ? { url: action.url } : {},
      })
      return out
    }

    // skip other response_item types
    return out
  }

  // skip: turn_context, etc.
  return out
}

export function normalizeCodex(
  lines: Array<string>,
  options: NormalizeOptions = {}
): Array<NormalizedEvent> {
  const { fromCompaction = true } = options

  const entries: Array<CodexEntry> = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as CodexEntry)
    } catch {
      // skip malformed lines
    }
  }

  const startIndex = fromCompaction ? findLastCompactionIndex(entries) : 0
  const events: Array<NormalizedEvent> = []

  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i]!
    for (const ev of normalizeCodexEvent(entry)) events.push(ev)
  }

  return events
}
