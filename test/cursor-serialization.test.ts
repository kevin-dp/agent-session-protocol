import { mkdtempSync, writeFileSync, appendFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  deserializeCursor,
  serializeCursor,
  SkillInvocationFilter,
} from "../src/index.js"
import { advanceCursor } from "../src/load.js"
import type { SessionCursor } from "../src/load.js"

function makeTmpJsonl(lines: Array<string>): string {
  const dir = mkdtempSync(join(tmpdir(), `asp-cursor-test-`))
  const path = join(dir, `session.jsonl`)
  writeFileSync(path, lines.map((l) => `${l}\n`).join(``))
  return path
}

function makeCursor(
  path: string,
  agent: `claude` | `codex`,
  opts: { filterSkills?: boolean } = {}
): SessionCursor {
  const filterSkills = opts.filterSkills ?? true
  return {
    path,
    agent,
    byteOffset: 0,
    partialLineBuffer: ``,
    skillFilter: filterSkills ? new SkillInvocationFilter(agent) : null,
  }
}

describe(`serializeCursor / deserializeCursor`, () => {
  it(`round-trips a fresh cursor unchanged`, () => {
    const path = makeTmpJsonl([])
    const cursor = makeCursor(path, `claude`)

    const serialized = serializeCursor(cursor)
    const restored = deserializeCursor(serialized)

    expect(restored.path).toBe(cursor.path)
    expect(restored.agent).toBe(cursor.agent)
    expect(restored.byteOffset).toBe(cursor.byteOffset)
    expect(restored.partialLineBuffer).toBe(cursor.partialLineBuffer)
    expect(restored.skillFilter).toBeInstanceOf(SkillInvocationFilter)
    expect(restored.skillFilter?.getState()).toEqual({ inSkillRound: false })
  })

  it(`preserves null skillFilter when filtering was disabled`, () => {
    const path = makeTmpJsonl([])
    const cursor = makeCursor(path, `codex`, { filterSkills: false })

    const serialized = serializeCursor(cursor)
    expect(serialized.skillFilter).toBeNull()

    const restored = deserializeCursor(serialized)
    expect(restored.skillFilter).toBeNull()
  })

  it(`round-trips JSON.stringify without loss`, () => {
    const path = makeTmpJsonl([])
    const cursor = makeCursor(path, `claude`)
    cursor.byteOffset = 1234
    cursor.partialLineBuffer = `{"partial":`
    cursor.skillFilter?.setState({ inSkillRound: true })

    const json = JSON.stringify(serializeCursor(cursor))
    const restored = deserializeCursor(JSON.parse(json))

    expect(restored.byteOffset).toBe(1234)
    expect(restored.partialLineBuffer).toBe(`{"partial":`)
    expect(restored.skillFilter?.getState()).toEqual({ inSkillRound: true })
  })

  it(`advances identically before and after a serialize/deserialize cycle`, async () => {
    const lineA = JSON.stringify({
      type: `user`,
      message: { role: `user`, content: `hello` },
      uuid: `u1`,
      timestamp: `2026-04-14T10:00:00Z`,
    })
    const lineB = JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [{ type: `text`, text: `hi` }],
      },
      uuid: `u2`,
      timestamp: `2026-04-14T10:00:01Z`,
    })

    const path = makeTmpJsonl([lineA])
    const initial = makeCursor(path, `claude`)

    // Baseline — advance directly, no serialization.
    const direct = await advanceCursor(initial)
    appendFileSync(path, `${lineB}\n`)
    const directAfter = await advanceCursor(direct.cursor)

    // Reset the file to its pre-append state by re-creating it, then
    // replay the same sequence with a serialize/deserialize step inserted
    // between the two advances.
    writeFileSync(path, `${lineA}\n`)
    const fresh = makeCursor(path, `claude`)
    const viaSerialized1 = await advanceCursor(fresh)
    const hopped = deserializeCursor(serializeCursor(viaSerialized1.cursor))
    appendFileSync(path, `${lineB}\n`)
    const viaSerialized2 = await advanceCursor(hopped)

    expect(viaSerialized1.newRawLines).toEqual(direct.newRawLines)
    expect(viaSerialized2.newRawLines).toEqual(directAfter.newRawLines)
    expect(viaSerialized2.cursor.byteOffset).toBe(directAfter.cursor.byteOffset)
  })

  it(`preserves in-progress skill-round state across a serialize boundary`, async () => {
    // Claude-style /share invocation, then its machinery, then a real
    // user turn. The invocation + machinery must be stripped as one
    // round even when the serialize/deserialize happens mid-round.
    const invocation = JSON.stringify({
      type: `user`,
      message: {
        role: `user`,
        content: `<command-name>/share</command-name>`,
      },
      uuid: `u-inv`,
      timestamp: `2026-04-14T10:00:00Z`,
    })
    const machinery = JSON.stringify({
      type: `assistant`,
      message: {
        role: `assistant`,
        content: [{ type: `text`, text: `running share skill` }],
      },
      uuid: `u-mach`,
      timestamp: `2026-04-14T10:00:01Z`,
    })
    const realUser = JSON.stringify({
      type: `user`,
      message: { role: `user`, content: `ok thanks, continue` },
      uuid: `u-real`,
      timestamp: `2026-04-14T10:00:02Z`,
    })

    // First batch: invocation only. Filter sets inSkillRound=true and
    // drops the line from the normalized event stream. rawLines always
    // reflects the full native JSONL (filter only affects events).
    const path = makeTmpJsonl([invocation])
    const cursor0 = makeCursor(path, `claude`)
    const step1 = await advanceCursor(cursor0)
    expect(step1.newRawLines).toHaveLength(1)
    expect(
      step1.newEvents.filter((e) => e.type === `user_message`)
    ).toEqual([])
    expect(step1.cursor.skillFilter?.getState().inSkillRound).toBe(true)

    // Cross a serialize/deserialize boundary while the round is open.
    const hopped = deserializeCursor(serializeCursor(step1.cursor))
    expect(hopped.skillFilter?.getState().inSkillRound).toBe(true)

    // Second batch: machinery (stripped from events) + real user turn
    // (kept). Both still appear in rawLines — the filter only affects
    // the normalized event stream. The restored filter must still know
    // it's inside a skill round so the machinery line is dropped from
    // events.
    appendFileSync(path, `${machinery}\n${realUser}\n`)
    const step2 = await advanceCursor(hopped)
    expect(step2.newRawLines).toHaveLength(2)
    const userEvents = step2.newEvents.filter(
      (e) => e.type === `user_message`
    )
    expect(userEvents).toHaveLength(1)
    expect(step2.cursor.skillFilter?.getState().inSkillRound).toBe(false)
  })

  it(`reflects byteOffset advance in the serialized snapshot`, async () => {
    const lineA = `{"type":"session_meta","payload":{"id":"s1","cwd":"/tmp"}}`
    const path = makeTmpJsonl([lineA])
    const cursor = makeCursor(path, `codex`, { filterSkills: false })
    const advanced = await advanceCursor(cursor)

    const serialized = serializeCursor(advanced.cursor)
    expect(serialized.byteOffset).toBe(statSync(path).size)
    expect(serialized.skillFilter).toBeNull()
    expect(serialized.v).toBe(1)
  })
})
