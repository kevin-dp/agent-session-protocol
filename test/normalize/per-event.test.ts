import { describe, expect, it } from "vitest"
import {
  normalizeClaudeEvent,
  normalizeCodexEvent,
  type ClaudeEntry,
  type CodexEntry,
} from "../../src/index.js"

describe(`normalizeClaudeEvent`, () => {
  it(`maps a system/init entry to a session_init event`, () => {
    const entry: ClaudeEntry = {
      type: `system`,
      subtype: `init`,
      timestamp: `2026-04-30T10:00:00Z`,
      sessionId: `s-1`,
      cwd: `/tmp/x`,
      version: `2.1.83`,
      gitBranch: `main`,
      message: { model: `claude-sonnet-4-5` },
    }
    const events = normalizeClaudeEvent(entry)
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({
      type: `session_init`,
      sessionId: `s-1`,
      cwd: `/tmp/x`,
      agent: `claude`,
      agentVersion: `2.1.83`,
      model: `claude-sonnet-4-5`,
      git: { branch: `main` },
    })
  })

  it(`maps a user entry with string content to user_message`, () => {
    const entry: ClaudeEntry = {
      type: `user`,
      timestamp: `2026-04-30T10:00:01Z`,
      message: { role: `user`, content: `hello there` },
    }
    const events = normalizeClaudeEvent(entry)
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({
      type: `user_message`,
      text: `hello there`,
    })
  })

  it(`maps an assistant entry with mixed content blocks`, () => {
    const entry: ClaudeEntry = {
      type: `assistant`,
      timestamp: `2026-04-30T10:00:02Z`,
      message: {
        role: `assistant`,
        content: [
          { type: `thinking`, thinking: `step 1: read the file` },
          { type: `text`, text: `Let me read it.` },
          {
            type: `tool_use`,
            id: `tool-1`,
            name: `Read`,
            input: { file_path: `/tmp/x.txt` },
          },
        ],
      },
    }
    const events = normalizeClaudeEvent(entry)
    expect(events.map((e) => e.type)).toEqual([
      `thinking`,
      `assistant_message`,
      `tool_call`,
    ])
    const tc = events[2]!
    if (tc.type !== `tool_call`) throw new Error(`unexpected`)
    expect(tc.callId).toBe(`tool-1`)
    expect(tc.originalTool).toBe(`Read`)
    expect(tc.tool).toBe(`file_read`)
  })

  it(`maps a user tool_result block`, () => {
    const entry: ClaudeEntry = {
      type: `user`,
      timestamp: `2026-04-30T10:00:03Z`,
      message: {
        role: `user`,
        content: [
          {
            type: `tool_result`,
            tool_use_id: `tool-1`,
            content: `file contents here`,
            is_error: false,
          },
        ],
      },
    }
    const events = normalizeClaudeEvent(entry)
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({
      type: `tool_result`,
      callId: `tool-1`,
      output: `file contents here`,
      isError: false,
    })
  })

  it(`returns an empty array for entries the normaliser doesn't care about`, () => {
    const entry: ClaudeEntry = {
      type: `progress`,
      timestamp: `2026-04-30T10:00:04Z`,
    }
    expect(normalizeClaudeEvent(entry)).toEqual([])
  })
})

describe(`normalizeCodexEvent`, () => {
  it(`maps session_meta to session_init`, () => {
    const entry: CodexEntry = {
      type: `session_meta`,
      timestamp: `2026-04-30T10:00:00Z`,
      payload: {
        id: `c-1`,
        cwd: `/tmp/y`,
        cli_version: `1.0.0`,
        git: {
          branch: `main`,
          commit_hash: `abc123`,
          repository_url: `https://github.com/x/y`,
        },
      },
    }
    const events = normalizeCodexEvent(entry)
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({
      type: `session_init`,
      sessionId: `c-1`,
      cwd: `/tmp/y`,
      agent: `codex`,
      agentVersion: `1.0.0`,
      git: {
        branch: `main`,
        commit: `abc123`,
        remote: `https://github.com/x/y`,
      },
    })
  })

  it(`maps a response_item function_call to tool_call`, () => {
    const entry: CodexEntry = {
      type: `response_item`,
      timestamp: `2026-04-30T10:00:01Z`,
      payload: {
        type: `function_call`,
        call_id: `call-1`,
        name: `shell`,
        arguments: `{"command":["ls","/"]}`,
      },
    }
    const events = normalizeCodexEvent(entry)
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({
      type: `tool_call`,
      callId: `call-1`,
      originalTool: `shell`,
      input: { command: [`ls`, `/`] },
    })
  })

  it(`maps a response_item function_call_output to tool_result`, () => {
    const entry: CodexEntry = {
      type: `response_item`,
      timestamp: `2026-04-30T10:00:02Z`,
      payload: {
        type: `function_call_output`,
        call_id: `call-1`,
        output: `total 0`,
      },
    }
    const events = normalizeCodexEvent(entry)
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({
      type: `tool_result`,
      callId: `call-1`,
      output: `total 0`,
      isError: false,
    })
  })

  it(`maps an assistant message`, () => {
    const entry: CodexEntry = {
      type: `response_item`,
      timestamp: `2026-04-30T10:00:03Z`,
      payload: {
        type: `message`,
        role: `assistant`,
        phase: `final_answer`,
        content: [{ text: `Done.` }],
      },
    }
    const events = normalizeCodexEvent(entry)
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({
      type: `assistant_message`,
      text: `Done.`,
      phase: `final`,
    })
  })

  it(`derives a deterministic callId for web_search_call when none is present`, () => {
    const entry: CodexEntry = {
      type: `response_item`,
      timestamp: `2026-04-30T10:00:04Z`,
      payload: {
        type: `web_search_call`,
        action: { url: `https://example.com/page` },
      },
    }
    const events = normalizeCodexEvent(entry)
    expect(events).toHaveLength(1)
    const tc = events[0]!
    if (tc.type !== `tool_call`) throw new Error(`unexpected`)
    expect(tc.callId).toMatch(/^web-/)
    expect(tc.callId).toContain(`example.com`)
  })

  it(`returns an empty array for a turn_aborted event_msg with no reason`, () => {
    const entry: CodexEntry = {
      type: `event_msg`,
      timestamp: `2026-04-30T10:00:05Z`,
      payload: { type: `token_count`, value: 1234 },
    }
    expect(normalizeCodexEvent(entry)).toEqual([])
  })
})
