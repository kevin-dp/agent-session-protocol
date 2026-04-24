export type AgentType = `claude` | `codex`

// -- Normalized event types --

export interface SessionInitEvent {
  v: 1
  ts: number
  type: `session_init`
  sessionId: string
  cwd: string
  model?: string
  agent: AgentType
  agentVersion?: string
  git?: {
    branch?: string
    commit?: string
    remote?: string
  }
}

export interface UserMessageEvent {
  v: 1
  ts: number
  type: `user_message`
  text: string
  user?: {
    name: string
    email?: string
  }
  /**
   * When present, the prompt originally arrived via a queue-channel
   * envelope (`<channel source="queue" user="…" ts="<unix-ms>">`). The
   * `ts` attribute from that envelope — used by viewers to correlate a
   * `user_message_queued` event with its delivered counterpart so an
   * in-flight "queued" bubble can transition to "delivered".
   */
  channelTs?: number
}

/**
 * A user prompt was received by the agent but couldn't be handled
 * immediately (the agent was mid-turn). Emitted when the native stream
 * records `type:"queue-operation" operation:"enqueue"`. A matching
 * `user_message` with the same `channelTs` will follow once the agent
 * dequeues and processes it — viewers should render the queued bubble
 * and replace (or upgrade) it when the delivered event arrives.
 *
 * If the agent was idle when the prompt arrived there's no enqueue
 * record, so this event never fires — only the direct `user_message`.
 */
export interface UserMessageQueuedEvent {
  v: 1
  ts: number
  type: `user_message_queued`
  text: string
  user?: {
    name: string
    email?: string
  }
  /** Channel-envelope ts attribute; pairs this event with its delivered `user_message`. */
  channelTs: number
}

export interface AssistantMessageEvent {
  v: 1
  ts: number
  type: `assistant_message`
  text: string
  phase?: `commentary` | `final`
}

export interface ThinkingEvent {
  v: 1
  ts: number
  type: `thinking`
  summary: string
  text: string | null
}

export interface ToolCallEvent {
  v: 1
  ts: number
  type: `tool_call`
  callId: string
  tool: string
  originalTool?: string
  originalAgent?: AgentType
  input: Record<string, unknown>
}

export interface ToolResultEvent {
  v: 1
  ts: number
  type: `tool_result`
  callId: string
  output: string
  isError: boolean
  exitCode?: number
}

export interface PermissionRequestEvent {
  v: 1
  ts: number
  type: `permission_request`
  requestId: string
  tool: string
  input: Record<string, unknown>
}

export interface PermissionResponseEvent {
  v: 1
  ts: number
  type: `permission_response`
  requestId: string
  decision: `allow` | `allow_session` | `deny` | `cancel`
  user?: {
    name: string
    email?: string
  }
  message?: string
  updatedInput?: Record<string, unknown>
}

export interface TurnCompleteEvent {
  v: 1
  ts: number
  type: `turn_complete`
  success: boolean
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
    reasoningOutputTokens?: number
    costUsd?: number
  }
  durationMs?: number
}

export interface TurnAbortedEvent {
  v: 1
  ts: number
  type: `turn_aborted`
  reason: string
}

export interface CompactionEvent {
  v: 1
  ts: number
  type: `compaction`
  summary?: string
}

export interface ErrorEvent {
  v: 1
  ts: number
  type: `error`
  code?: string
  message: string
  retryable?: boolean
  retryAttempt?: number
  maxRetries?: number
}

export interface SessionEndEvent {
  v: 1
  ts: number
  type: `session_end`
}

export type NormalizedEvent =
  | SessionInitEvent
  | UserMessageEvent
  | UserMessageQueuedEvent
  | AssistantMessageEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResponseEvent
  | TurnCompleteEvent
  | TurnAbortedEvent
  | CompactionEvent
  | ErrorEvent
  | SessionEndEvent

export interface NormalizeOptions {
  fromCompaction?: boolean
}

export interface DenormalizeOptions {
  sessionId?: string
  cwd?: string
}
