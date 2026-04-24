import { useEffect, useRef } from "react"
import type {
  NormalizedEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../lib/types"
import {
  AssistantMessage,
  Compaction,
  ErrorCallout,
  PermissionRequest,
  PermissionResponse,
  Thinking,
  UserMessage,
} from "./Message"
import { ToolBlock } from "./ToolCall"

interface Props {
  events: Array<NormalizedEvent>
  // When `embedded`, the conversation is rendered inside its own scrollable
  // container that owns the scroll behavior — so we skip the page-level
  // auto-scroll-to-bottom we'd otherwise do as new events arrive.
  embedded?: boolean
}

export function Conversation({ events, embedded }: Props): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    if (embedded) return
    if (stickToBottomRef.current && endRef.current) {
      endRef.current.scrollIntoView({ behavior: `smooth`, block: `end` })
    }
  }, [events.length, embedded])

  // Pair tool_call with tool_result by callId
  const resultsByCallId = new Map<string, ToolResultEvent>()
  for (const event of events) {
    if (event.type === `tool_result`) {
      resultsByCallId.set(event.callId, event)
    }
  }

  // Prompts that arrive while the agent is mid-turn are first recorded
  // as `user_message_queued`; a delivered `user_message` with the same
  // `channelTs` follows once the agent picks them up. Render each queued
  // prompt up front as a "pending" bubble, and drop it once its delivered
  // twin has been seen — so viewers never see two bubbles for one submit.
  const deliveredChannelTs = new Set<number>()
  for (const event of events) {
    if (event.type === `user_message` && event.channelTs !== undefined) {
      deliveredChannelTs.add(event.channelTs)
    }
  }

  const renderedCallIds = new Set<string>()
  const items: Array<JSX.Element> = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    const key = `${event.ts}-${i}`

    switch (event.type) {
      case `session_init`:
      case `turn_complete`:
      case `turn_aborted`:
      case `session_end`:
        // Invisible — fed to stats panel only
        break
      case `user_message`:
        items.push(<UserMessage key={key} text={event.text} user={event.user} />)
        break
      case `user_message_queued`:
        // Suppress once the delivered twin has arrived.
        if (deliveredChannelTs.has(event.channelTs)) break
        items.push(
          <UserMessage
            key={key}
            text={event.text}
            user={event.user}
            pending
          />
        )
        break
      case `assistant_message`:
        items.push(
          <AssistantMessage key={key} text={event.text} phase={event.phase} />
        )
        break
      case `thinking`:
        items.push(<Thinking key={key} summary={event.summary} />)
        break
      case `tool_call`:
        if (renderedCallIds.has(event.callId)) break
        renderedCallIds.add(event.callId)
        items.push(
          <ToolBlock
            key={key}
            call={event as ToolCallEvent}
            result={resultsByCallId.get(event.callId)}
          />
        )
        break
      case `tool_result`:
        // Only render result on its own if no matching tool_call was seen
        // (defensive — shouldn't normally happen)
        break
      case `permission_request`:
        items.push(
          <PermissionRequest
            key={key}
            tool={event.tool}
            input={event.input}
          />
        )
        break
      case `permission_response`:
        items.push(
          <PermissionResponse
            key={key}
            decision={event.decision}
            user={event.user}
          />
        )
        break
      case `compaction`:
        items.push(<Compaction key={key} />)
        break
      case `error`:
        items.push(
          <ErrorCallout key={key} code={event.code} message={event.message} />
        )
        break
    }
  }

  return (
    <div className="conversation">
      {items}
      <div ref={endRef} />
    </div>
  )
}
