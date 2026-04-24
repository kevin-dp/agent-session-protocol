import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { normalize } from "../../src/index.js"

const fixture = readFileSync(
  join(__dirname, `..`, `fixtures`, `claude-session.jsonl`),
  `utf8`
)
const lines = fixture.split(`\n`).filter((l) => l.trim())

describe(`normalize claude`, () => {
  const events = normalize(lines, `claude`)

  it(`emits session_init from system/init`, () => {
    const init = events.find((e) => e.type === `session_init`)
    expect(init).toBeDefined()
    expect(init!.type).toBe(`session_init`)
    if (init!.type !== `session_init`) return
    expect(init.sessionId).toBe(`test-session-001`)
    expect(init.cwd).toBe(`/tmp/test-project`)
    expect(init.agent).toBe(`claude`)
    expect(init.agentVersion).toBe(`2.1.83`)
  })

  it(`emits user_message`, () => {
    const userMsgs = events.filter((e) => e.type === `user_message`)
    expect(userMsgs.length).toBeGreaterThanOrEqual(1)
    const first = userMsgs[0]!
    if (first.type !== `user_message`) return
    expect(first.text).toContain(`health check`)
  })

  it(`emits thinking from assistant thinking blocks`, () => {
    const thinking = events.filter((e) => e.type === `thinking`)
    expect(thinking.length).toBeGreaterThanOrEqual(1)
    const first = thinking[0]!
    if (first.type !== `thinking`) return
    expect(first.text).toBe(`I need to read the file first`)
  })

  it(`emits assistant_message from text blocks`, () => {
    const msgs = events.filter((e) => e.type === `assistant_message`)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
  })

  it(`emits tool_call with normalized tool name`, () => {
    const calls = events.filter((e) => e.type === `tool_call`)
    expect(calls.length).toBe(2)

    const readCall = calls[0]!
    if (readCall.type !== `tool_call`) return
    expect(readCall.tool).toBe(`file_read`)
    expect(readCall.originalTool).toBe(`Read`)
    expect(readCall.callId).toBe(`tool-001`)

    const editCall = calls[1]!
    if (editCall.type !== `tool_call`) return
    expect(editCall.tool).toBe(`file_edit`)
    expect(editCall.originalTool).toBe(`Edit`)
    expect(editCall.callId).toBe(`tool-002`)
  })

  it(`emits tool_result paired by callId`, () => {
    const results = events.filter((e) => e.type === `tool_result`)
    expect(results.length).toBe(2)

    const readResult = results[0]!
    if (readResult.type !== `tool_result`) return
    expect(readResult.callId).toBe(`tool-001`)
    expect(readResult.output).toContain(`express`)
    expect(readResult.isError).toBe(false)
  })

  it(`emits turn_complete`, () => {
    const completes = events.filter((e) => e.type === `turn_complete`)
    expect(completes.length).toBeGreaterThanOrEqual(1)
  })

  it(`preserves event ordering`, () => {
    const types = events.map((e) => e.type)
    const initIdx = types.indexOf(`session_init`)
    const userIdx = types.indexOf(`user_message`)
    const toolCallIdx = types.indexOf(`tool_call`)
    const toolResultIdx = types.indexOf(`tool_result`)

    expect(initIdx).toBeLessThan(userIdx)
    expect(userIdx).toBeLessThan(toolCallIdx)
    expect(toolCallIdx).toBeLessThan(toolResultIdx)
  })

  it(`normalizes queued_command attachments as user_message`, () => {
    // Claude Code queues prompts that arrive while an assistant turn is
    // in flight and writes them as type="attachment" with
    // attachment.type="queued_command" instead of type="user" entries.
    // Without dedicated handling, prompts from viewer queue channels are
    // silently dropped from the normalized stream.
    const queuedLines = [
      JSON.stringify({
        type: `user`,
        message: { role: `user`, content: `first prompt` },
        uuid: `u-1`,
        timestamp: `2026-04-24T09:29:12.340Z`,
      }),
      JSON.stringify({
        type: `attachment`,
        attachment: {
          type: `queued_command`,
          prompt: `<channel source="queue" user="anonymous">\nsecond prompt\n</channel>`,
          commandMode: `prompt`,
          origin: { kind: `channel`, server: `queue` },
          isMeta: true,
        },
        uuid: `u-2`,
        timestamp: `2026-04-24T09:31:48.120Z`,
      }),
      JSON.stringify({
        type: `attachment`,
        attachment: {
          type: `queued_command`,
          prompt: `<channel source="queue" user="Sam">\nthird prompt\n</channel>`,
          commandMode: `prompt`,
          origin: { kind: `channel`, server: `queue` },
          isMeta: true,
        },
        uuid: `u-3`,
        timestamp: `2026-04-24T09:31:48.120Z`,
      }),
    ]

    const evts = normalize(queuedLines, `claude`)
    const userMsgs = evts.filter((e) => e.type === `user_message`)
    expect(userMsgs).toHaveLength(3)
    if (userMsgs[0]!.type !== `user_message`) return
    if (userMsgs[1]!.type !== `user_message`) return
    if (userMsgs[2]!.type !== `user_message`) return
    expect(userMsgs[0]!.text).toBe(`first prompt`)
    // The channel envelope is stripped and the user attribute is lifted
    // onto the event so viewers don't need to parse XML.
    expect(userMsgs[1]!.text).toBe(`second prompt`)
    expect(userMsgs[1]!.user).toEqual({ name: `anonymous` })
    expect(userMsgs[2]!.text).toBe(`third prompt`)
    expect(userMsgs[2]!.user).toEqual({ name: `Sam` })
  })

  it(`emits user_message_queued from queue-operation enqueue records`, () => {
    // When a viewer POSTs a prompt while Claude is mid-turn, CC records
    // it as a queue-operation "enqueue" entry (with the channel envelope
    // in .content) before later dequeuing and processing it as a
    // queued_command attachment. The normalizer should emit
    // `user_message_queued` for the enqueue so viewers can render an
    // in-flight "queued" bubble.
    const enqueue = JSON.stringify({
      type: `queue-operation`,
      operation: `enqueue`,
      timestamp: `2026-04-24T09:31:40.552Z`,
      content: `<channel source="queue" user="anonymous" ts="1777023099910">\nWhat's the model name\n</channel>`,
    })
    const delivered = JSON.stringify({
      type: `attachment`,
      attachment: {
        type: `queued_command`,
        prompt: `<channel source="queue" user="anonymous" ts="1777023099910">\nWhat's the model name\n</channel>`,
        commandMode: `prompt`,
      },
      uuid: `u-delivered`,
      timestamp: `2026-04-24T09:31:48.120Z`,
    })

    const evts = normalize([enqueue, delivered], `claude`)
    const queued = evts.filter((e) => e.type === `user_message_queued`)
    const delivereds = evts.filter((e) => e.type === `user_message`)

    expect(queued).toHaveLength(1)
    expect(delivereds).toHaveLength(1)
    if (queued[0]!.type !== `user_message_queued`) return
    if (delivereds[0]!.type !== `user_message`) return
    // Both events share channelTs so viewers can pair them up.
    expect(queued[0]!.channelTs).toBe(1777023099910)
    expect(delivereds[0]!.channelTs).toBe(1777023099910)
    // And both carry the same user attribution.
    expect(queued[0]!.user).toEqual({ name: `anonymous` })
    expect(delivereds[0]!.user).toEqual({ name: `anonymous` })
    expect(queued[0]!.text).toBe(`What's the model name`)
  })

  it(`unwraps channel envelope on direct user messages`, () => {
    // First prompt in a burst lands as type="user" with the channel
    // envelope directly in message.content — same unwrap applies.
    const line = JSON.stringify({
      type: `user`,
      message: {
        role: `user`,
        content: `<channel source="queue" user="Chromy" ts="1777024532105">\nWhat is the magic word?\n</channel>`,
      },
      uuid: `u-direct`,
      timestamp: `2026-04-24T10:00:00Z`,
    })

    const evts = normalize([line], `claude`)
    const userMsg = evts.find((e) => e.type === `user_message`)!
    expect(userMsg).toBeDefined()
    if (userMsg.type !== `user_message`) return
    expect(userMsg.text).toBe(`What is the magic word?`)
    expect(userMsg.user).toEqual({ name: `Chromy` })
  })
})
