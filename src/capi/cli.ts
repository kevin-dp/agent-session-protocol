import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { execSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DurableStream, FetchError } from "@durable-streams/client"
import {
  discoverSessions,
  findClaudeSession,
  rewriteNativeLines,
  writeClaudeSession,
  writeCodexSession,
} from "../index.js"
import { SkillInvocationFilter } from "../index.js"
import { denormalize, normalize } from "../index.js"
import type { HeadersRecord } from "@durable-streams/client"
import type {
  AgentType,
  DiscoveredSession,
  NormalizedEvent,
} from "../index.js"

// Tracked-session (git-integrated) support — ported from the old `sesh`
// CLI. These live behind their own subcommands (init / checkin / push /
// list / resume / merge / install-hooks) and are independent from the
// ad-hoc `export / import` flow.
import {
  findRepoRoot,
  readConfig,
  readPreferences,
  saveToken,
  writeConfig,
  writePreferences,
} from "./config.js"
import {
  getGitUser,
  listSessionFiles,
  writeSessionFile,
} from "./tracked-sessions.js"
import { pushAll } from "./push.js"
import { resume as resumeTracked } from "./resume.js"
import { merge as mergeTracked } from "./merge.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let globalHeaders: HeadersRecord = {}

function parseArgs(argv: Array<string>): {
  command: string
  args: Record<string, string | boolean>
  positional: Array<string>
} {
  const command = argv[0] ?? `help`
  const args: Record<string, string | boolean> = {}
  const positional: Array<string> = []

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(`--`)) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith(`--`)) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { command, args, positional }
}

function detectAgent(): AgentType | null {
  if (process.env.CLAUDE_CODE_SESSION_ID) return `claude`
  return null
}

async function createOrConnectStream(
  url: string,
  contentType: string
): Promise<DurableStream> {
  try {
    return await DurableStream.create({
      url,
      contentType,
      headers: globalHeaders,
    })
  } catch (error) {
    if (error instanceof FetchError && error.status === 409) {
      return new DurableStream({
        url,
        contentType,
        headers: globalHeaders,
      })
    }
    throw error
  }
}

async function getStreamItemCount(url: string): Promise<number> {
  try {
    const resolvedHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(globalHeaders)) {
      if (typeof value === `string`) {
        resolvedHeaders[key] = value
      } else if (typeof value === `function`) {
        resolvedHeaders[key] = await (value as () => Promise<string>)()
      }
    }

    const response = await fetch(url, {
      method: `HEAD`,
      headers: resolvedHeaders,
    })
    if (!response.ok) return 0
    const totalSize = response.headers.get(`stream-total-size`)
    return totalSize ? parseInt(totalSize, 10) : 0
  } catch {
    return 0
  }
}

async function pushLines(
  streamUrl: string,
  _producerId: string,
  lines: Array<string>
): Promise<number> {
  // Delta logic: only push new lines that don't already exist in the stream.
  // Previously this was important because each share reused the same stream URL
  // (based on session ID), so re-exporting needed to avoid duplicates.
  // Now each share gets a unique URL ({sessionId}/{entryCount}-{uuid}), so the
  // stream is always empty on first push and this check is effectively a no-op.
  // Kept as defensive behavior in case someone calls pushLines() with an
  // already-populated stream URL.
  const existingCount = await getStreamItemCount(streamUrl)
  if (existingCount >= lines.length) {
    return 0 // already up to date
  }

  const newLines = lines.slice(existingCount)
  if (newLines.length === 0) return 0

  // Use auto-batching: fire-and-forget appends, then await all promises.
  // The DS client batches concurrent appends into single HTTP requests
  // automatically (wraps JSON items in arrays, server flattens them).
  const stream = await createOrConnectStream(streamUrl, `application/json`)
  const promises = newLines.map((line) => stream.append(line))
  await Promise.all(promises)

  return newLines.length
}

async function streamExists(url: string): Promise<boolean> {
  try {
    const stream = new DurableStream({
      url,
      contentType: `application/json`,
      headers: globalHeaders,
    })
    const response = await stream.stream({ json: true, live: false })
    const items = await response.json()
    return items.length > 0
  } catch {
    return false
  }
}

async function readStream<T>(url: string): Promise<Array<T>> {
  const stream = new DurableStream({
    url,
    contentType: `application/json`,
    headers: globalHeaders,
  })
  const response = await stream.stream<T>({ json: true, live: false })
  return response.json()
}

function extractSessionMeta(
  lines: Array<string>,
  agent: AgentType
): { sessionId: string; cwd: string } {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>

      if (agent === `claude`) {
        if (obj.sessionId && obj.cwd) {
          return {
            sessionId: String(obj.sessionId),
            cwd: String(obj.cwd),
          }
        }
      }

      if (agent === `codex` && obj.type === `session_meta`) {
        const payload = obj.payload as Record<string, unknown>
        return {
          sessionId: String(payload.id ?? ``),
          cwd: String(payload.cwd ?? ``),
        }
      }
    } catch {
      continue
    }
  }

  return { sessionId: ``, cwd: `` }
}

async function exportSession(
  args: Record<string, string | boolean>,
  positional: Array<string>
): Promise<void> {
  const server =
    (args.server as string | undefined) ??
    positional[0] ??
    process.env.CAPI_SERVER
  if (!server) {
    console.error(
      `Usage: capi export --server <url> [--agent claude|codex] [--session <id>]`
    )
    console.error(`  Or set the CAPI_SERVER environment variable.`)
    process.exit(1)
  }

  let agent: AgentType | undefined =
    (args.agent as AgentType | undefined) ?? detectAgent() ?? undefined
  const sessionId = args.session as string | undefined

  const sessions = await discoverSessions(agent)

  let session = sessionId
    ? sessions.find((s) => s.sessionId === sessionId)
    : (sessions.find((s) => s.active) ?? sessions[sessions.length - 1])

  // Fallback: search for JSONL file directly when session ID is provided
  // but not found via metadata (e.g., older or continued sessions)
  if (!session && sessionId && (!agent || agent === `claude`)) {
    session = (await findClaudeSession(sessionId)) ?? undefined
  }

  if (!session) {
    console.error(`Session not found: ${sessionId ?? `(none)`}`)
    if (sessions.length > 0) {
      console.error(`Available sessions:`)
      for (const s of sessions) {
        console.error(
          `  ${s.agent} ${s.sessionId} ${s.active ? `(active)` : ``} ${s.cwd ?? ``}`
        )
      }
    }
    process.exit(1)
  }

  agent = session.agent
  const live = args.live === true

  console.error(
    `Exporting ${agent} session ${live ? `(live)` : `(snapshot)`}: ${session.sessionId}`
  )
  console.error(`  Path: ${session.path}`)

  const content = readFileSync(session.path, `utf8`)
  const unfilteredLines = content.split(`\n`).filter((l) => l.trim())
  // Strip out /share skill-invocation rounds so resumed sessions don't
  // show the share plumbing at the tail. Filter is stateful so that
  // skill-execution machinery spanning the initial snapshot and later
  // incremental live-watcher batches is handled as one contiguous round.
  const skillFilter = new SkillInvocationFilter(agent)
  const rawLines = skillFilter.feed(unfilteredLines)
  const events = normalize(rawLines, agent)

  // URL pattern:
  //  - snapshot: /asp/{sessionId}/{entryCount}-{uuid}      (unique per share)
  //  - live:     /asp/{sessionId}/live                     (one per session)
  const shareId = live ? `live` : `${events.length}-${randomUUID()}`
  const baseUrl = `${server.replace(/\/$/, ``)}/asp/${session.sessionId}/${shareId}`
  const nativeUrl = `${baseUrl}/native/${agent}`

  const normalizedLines = events.map((e) => JSON.stringify(e))

  if (!live) {
    console.error(`  Share ID: ${shareId}`)
  }
  console.error(`  Normalized: ${events.length} events`)
  const newNormalized = await pushLines(
    baseUrl,
    `asp-normalized-${session.sessionId}-${shareId}`,
    normalizedLines
  )
  console.error(
    newNormalized > 0
      ? `  Pushed ${newNormalized} normalized events`
      : `  Normalized stream up to date`
  )

  const newNative = await pushLines(
    nativeUrl,
    `asp-native-${session.sessionId}-${shareId}`,
    rawLines
  )
  console.error(
    newNative > 0
      ? `  Pushed ${newNative} native ${agent} lines`
      : `  Native ${agent} stream up to date`
  )

  // Optionally shorten the URL via a shortener service
  const shortener =
    (args.shortener as string | undefined) ?? process.env.CAPI_SHORTENER
  const token =
    (args.token as string | undefined) ??
    process.env.CAPI_TOKEN ??
    process.env.DS_TOKEN

  let outputUrl = baseUrl
  if (shortener) {
    const shortUrl = await createShortUrl(shortener, {
      fullUrl: baseUrl,
      sessionId: session.sessionId,
      entryCount: events.length,
      agent,
      token: token ?? ``,
      live,
    })
    if (shortUrl) {
      console.error(`  Short URL: ${shortUrl}`)
      outputUrl = shortUrl
    } else {
      console.error(`  Shortener failed, using full URL`)
    }
  }

  if (!live) {
    console.log(outputUrl)
    return
  }

  // Live mode: print the URL now, then watch the source file forever
  console.log(outputUrl)
  console.error(``)
  console.error(`Watching ${session.path}`)
  console.error(`Press Ctrl-C to stop sharing.`)

  // Create the prompt queue stream now so viewers can POST to it. Without
  // this the first POST from the viewer would 404.
  const queueUrl = `${baseUrl}/prompts`
  try {
    await createOrConnectStream(queueUrl, `application/json`)
    console.error(`  Queue stream ready: ${queueUrl}`)
  } catch (error) {
    console.error(
      `  Failed to create queue stream (collab disabled):`,
      error instanceof Error ? error.message : error
    )
  }

  // Publish the collab config file so the queue-channel MCP subprocess
  // (already running under CC if the user started claude with
  // --dangerously-load-development-channels server:queue) can pick up
  // the session's queue URL and start forwarding prompts.
  const collabPath = writeCollabConfig({
    sessionId: session.sessionId,
    dsBase: server,
    queueUrl,
    token,
  })
  console.error(`  Collab config: ${collabPath}`)

  try {
    await watchAndPushLive({
      sourcePath: session.path,
      nativeUrl,
      normalizedUrl: baseUrl,
      agent,
      skillFilter,
    })
  } finally {
    removeCollabConfig()
  }
}

interface WatchOptions {
  sourcePath: string
  nativeUrl: string
  normalizedUrl: string
  agent: AgentType
  // Shared across the initial export and the watcher so a skill round
  // that spans the boundary (invocation in the snapshot, machinery in
  // later batches) is stripped as a single contiguous round.
  skillFilter: SkillInvocationFilter
}

/**
 * Read bytes [start, end) from the source file.
 */
function readByteRange(
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
      end: end - 1, // createReadStream end is inclusive
      encoding: `utf8`,
    })
    stream.on(`data`, (chunk) => {
      chunks.push(typeof chunk === `string` ? Buffer.from(chunk) : chunk)
    })
    stream.on(`end`, () => resolve(Buffer.concat(chunks).toString(`utf8`)))
    stream.on(`error`, reject)
  })
}

async function watchAndPushLive(opts: WatchOptions): Promise<void> {
  let lastByteOffset = statSync(opts.sourcePath).size
  // Buffer for a trailing partial line (no \n yet) — held until next tick.
  let partialLineBuffer = ``
  let busy = false
  let pending = false
  let stopping = false

  const nativeStream = await createOrConnectStream(
    opts.nativeUrl,
    `application/json`
  )
  const normalizedStream = await createOrConnectStream(
    opts.normalizedUrl,
    `application/json`
  )

  async function processChanges(): Promise<void> {
    if (stopping) return
    if (busy) {
      pending = true
      return
    }
    busy = true
    try {
      const stat = statSync(opts.sourcePath)
      // File was truncated/replaced — re-read from start
      if (stat.size < lastByteOffset) {
        lastByteOffset = 0
        partialLineBuffer = ``
      }
      if (stat.size === lastByteOffset) return

      // Read only the new bytes since the last tick
      const newBytes = await readByteRange(
        opts.sourcePath,
        lastByteOffset,
        stat.size
      )
      lastByteOffset = stat.size

      // Combine with any partial line carried over from last tick
      const combined = partialLineBuffer + newBytes
      const lastNewlineIdx = combined.lastIndexOf(`\n`)
      let completeChunk: string
      if (lastNewlineIdx === -1) {
        // No newline at all — entire chunk is partial
        partialLineBuffer = combined
        completeChunk = ``
      } else {
        completeChunk = combined.slice(0, lastNewlineIdx)
        partialLineBuffer = combined.slice(lastNewlineIdx + 1)
      }

      const unfilteredNewLines = completeChunk
        .split(`\n`)
        .filter((l) => l.trim())
      if (unfilteredNewLines.length === 0) return

      // Run the batch through the stateful skill-invocation filter.
      // State is shared with the initial export, so a /share round that
      // straddles the snapshot boundary is stripped as a single round.
      const newRawLines = opts.skillFilter.feed(unfilteredNewLines)
      if (newRawLines.length === 0) return

      // Push new native lines as-is
      await Promise.all(newRawLines.map((line) => nativeStream.append(line)))

      // Incrementally normalize ONLY the new lines.
      // - fromCompaction: false → don't try to find a compaction boundary
      //   (we want to process every new line as a continuation)
      // - filter out synthetic session_init that the normalizer auto-injects
      //   when no system/init is present in the input (we already emitted one
      //   on the first push)
      const newEvents = normalize(newRawLines, opts.agent, {
        fromCompaction: false,
      }).filter((e) => e.type !== `session_init`)

      if (newEvents.length > 0) {
        await Promise.all(
          newEvents.map((event) =>
            normalizedStream.append(JSON.stringify(event))
          )
        )
      }

      const ts = new Date().toISOString().slice(11, 19)
      console.error(
        `[${ts}] +${newRawLines.length} native, +${newEvents.length} normalized`
      )
    } catch (error) {
      console.error(
        `  Watcher error: ${error instanceof Error ? error.message : error}`
      )
    } finally {
      busy = false
      // eslint can't see that `stopping` is reassigned inside the SIGINT
      // handler closure below, so it thinks `!stopping` is always true.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (pending && !stopping) {
        pending = false
        void processChanges()
      }
    }
  }

  const watcher = watch(opts.sourcePath, () => {
    void processChanges()
  })

  // Also poll periodically as a safety net (fs.watch can miss events on macOS/NFS)
  const pollInterval = setInterval(() => {
    void processChanges()
  }, 2000)

  await new Promise<void>((resolve) => {
    const handleSignal = async (): Promise<void> => {
      stopping = true
      clearInterval(pollInterval)
      watcher.close()
      console.error(``)
      console.error(`Stopping live share — emitting session_end`)
      try {
        const endEvent: NormalizedEvent = {
          v: 1,
          ts: Date.now(),
          type: `session_end`,
        }
        await normalizedStream.append(JSON.stringify(endEvent))
      } catch (error) {
        console.error(
          `  Failed to emit session_end: ${
            error instanceof Error ? error.message : error
          }`
        )
      }
      resolve()
    }

    process.once(`SIGINT`, () => void handleSignal())
    process.once(`SIGTERM`, () => void handleSignal())
  })
}

async function createShortUrl(
  shortener: string,
  payload: {
    fullUrl: string
    sessionId: string
    entryCount: number
    agent: AgentType
    token: string
    live?: boolean
  }
): Promise<string | null> {
  try {
    const endpoint = `${shortener.replace(/\/$/, ``)}/api/create`
    const response = await fetch(endpoint, {
      method: `POST`,
      headers: { "content-type": `application/json` },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const text = await response.text()
      console.error(`  Shortener error (${response.status}): ${text}`)
      return null
    }
    const data = (await response.json()) as { shortUrl: string }
    return data.shortUrl
  } catch (error) {
    console.error(
      `  Shortener request failed: ${error instanceof Error ? error.message : error}`
    )
    return null
  }
}

async function resolveShortUrl(url: string): Promise<string | null> {
  // Short URLs are registered on a shortener service and return JSON
  // with the actual DS URL when fetched with Accept: application/json.
  try {
    const response = await fetch(url, {
      headers: { accept: `application/json` },
    })
    if (!response.ok) return null
    const contentType = response.headers.get(`content-type`) ?? ``
    if (!contentType.includes(`application/json`)) return null
    const data = (await response.json()) as { fullUrl?: string }
    return data.fullUrl ?? null
  } catch {
    return null
  }
}

async function importSession(
  args: Record<string, string | boolean>,
  positional: Array<string>
): Promise<void> {
  const inputUrl = positional[0]
  if (!inputUrl) {
    console.error(
      `Usage: capi import <stream-url> --agent claude|codex [--cwd <dir>] [--resume]`
    )
    process.exit(1)
  }

  const agentArg = args.agent as string | undefined
  if (agentArg !== `claude` && agentArg !== `codex`) {
    console.error(`--agent is required (claude or codex)`)
    process.exit(1)
  }
  const agent: AgentType = agentArg

  // Try resolving as a short URL first. If the URL returns JSON with a
  // fullUrl field, use that; otherwise treat the input as a direct DS URL.
  let streamUrl = inputUrl
  const resolved = await resolveShortUrl(inputUrl)
  if (resolved) {
    streamUrl = resolved
    console.error(`Resolved short URL → ${streamUrl}`)
  }

  const cwd = (args.cwd as string | undefined) ?? process.cwd()
  const shouldResume = args.resume === true
  const newSessionId = randomUUID()

  console.error(`Importing from: ${streamUrl}`)
  console.error(`  Target agent: ${agent}`)
  console.error(`  CWD: ${cwd}`)

  // Try native stream first (same-agent, lossless)
  const nativeUrl = `${streamUrl}/native/${agent}`
  const hasNative = await streamExists(nativeUrl)

  let sessionPath: string

  if (hasNative) {
    console.error(`  Found native ${agent} stream — using lossless resume`)
    const nativeLines = (await readStream<string>(nativeUrl)).map((item) =>
      typeof item === `string` ? item : JSON.stringify(item)
    )

    const meta = extractSessionMeta(nativeLines, agent)
    const rewrittenLines = rewriteNativeLines(
      nativeLines,
      agent,
      newSessionId,
      cwd,
      meta.sessionId,
      meta.cwd
    )

    console.error(
      `  Rewritten ${rewrittenLines.length} lines (${meta.sessionId} → ${newSessionId})`
    )

    if (agent === `claude`) {
      sessionPath = writeClaudeSession(newSessionId, cwd, rewrittenLines)
    } else {
      sessionPath = writeCodexSession(newSessionId, rewrittenLines)
    }
  } else {
    console.error(
      `  No native ${agent} stream — using normalized (cross-agent)`
    )
    const events = await readStream<NormalizedEvent>(streamUrl)
    console.error(`  Read ${events.length} normalized events`)

    const lines = denormalize(events, agent, { sessionId: newSessionId, cwd })
    console.error(`  Denormalized: ${lines.length} lines`)

    if (agent === `claude`) {
      sessionPath = writeClaudeSession(newSessionId, cwd, lines)
    } else {
      sessionPath = writeCodexSession(newSessionId, lines)
    }
  }

  console.error(`  Wrote: ${sessionPath}`)

  if (agent === `claude`) {
    console.log(`Session ID: ${newSessionId}`)
    console.log(`Resume with: claude --resume ${newSessionId}`)
  } else {
    console.log(`Thread ID: ${newSessionId}`)
    console.log(`Resume with: codex resume ${newSessionId}`)
  }

  if (shouldResume) {
    const cmd =
      agent === `claude`
        ? `claude --resume ${newSessionId}`
        : `codex resume ${newSessionId}`
    console.error(`  Launching ${agent}...`)
    execSync(cmd, { stdio: `inherit`, cwd })
  }
}

function installSkills(args: Record<string, string | boolean>): void {
  // Locate the skills directory bundled with the package
  const cliDir = dirname(fileURLToPath(import.meta.url))
  // When running from dist/, skills is two levels up; when running from src/,
  // it's one level up. Check both.
  const candidates = [
    join(cliDir, `..`, `skills`),
    join(cliDir, `..`, `..`, `skills`),
  ]
  const skillsSource = candidates.find((p) => existsSync(p))
  if (!skillsSource) {
    console.error(`Could not find skills directory`)
    process.exit(1)
  }

  const targets: Array<{ agent: string; path: string }> = []
  const claudeOnly = args.claude === true
  const codexOnly = args.codex === true
  const installClaude = !codexOnly
  const installCodex = !claudeOnly

  if (installClaude) {
    targets.push({
      agent: `claude`,
      path: join(homedir(), `.claude`, `skills`),
    })
  }
  if (installCodex) {
    targets.push({
      agent: `codex`,
      path: join(homedir(), `.codex`, `skills`),
    })
  }

  // Install both skills: `share` (works in both Claude and Codex) and
  // `checkin` (Claude-only — registers a session for git-tracked push on
  // commit). The checkin skill is skipped silently for Codex since it
  // assumes Claude's session-ID env var.
  const allSkills: Array<{ name: string; claude: boolean; codex: boolean }> = [
    { name: `share`, claude: true, codex: true },
    { name: `checkin`, claude: true, codex: false },
  ]

  for (const target of targets) {
    mkdirSync(target.path, { recursive: true })
    for (const skill of allSkills) {
      if (target.agent === `claude` && !skill.claude) continue
      if (target.agent === `codex` && !skill.codex) continue

      const skillTarget = join(target.path, skill.name)
      const skillSource = join(skillsSource, skill.name)
      if (!existsSync(skillSource)) continue

      if (existsSync(skillTarget)) {
        console.log(
          `  ${target.agent}: ${skill.name} skill already exists, skipping`
        )
        continue
      }

      try {
        symlinkSync(skillSource, skillTarget)
        console.log(
          `  ${target.agent}: ${skill.name} skill linked → ${skillSource}`
        )
      } catch (error) {
        console.error(
          `  ${target.agent}: failed to link ${skill.name}: ${
            error instanceof Error ? error.message : error
          }`
        )
      }
    }
  }

  console.log(
    `\nSkills installed. Use the "share" skill from within an agent session.`
  )
}

/**
 * Install the queue-channel MCP server into Claude Code's global MCP
 * config (~/.claude.json). Safe to run repeatedly; overwrites the
 * existing `queue` entry. The MCP subprocess sits idle until a live
 * share writes ~/.capi/active-collab.json, so global registration
 * doesn't do anything risky by default.
 */
function installChannel(): void {
  // This file compiles to dist/capi/cli.js, so the bin dir sits two
  // levels up (../../bin/). The skill-installer uses the same dance.
  const queueBinPath = fileURLToPath(
    new URL(`../../bin/capi-queue-channel.mjs`, import.meta.url)
  )

  if (!existsSync(queueBinPath)) {
    console.error(`Channel binary not found at ${queueBinPath}`)
    console.error(
      `Make sure the agent-session-protocol package is built (pnpm build).`
    )
    process.exit(1)
  }

  const claudeConfigPath = join(homedir(), `.claude.json`)
  interface ClaudeConfig {
    mcpServers?: Record<string, unknown>
    [key: string]: unknown
  }
  let config: ClaudeConfig = {}
  if (existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(
        readFileSync(claudeConfigPath, `utf8`)
      ) as ClaudeConfig
    } catch (error) {
      console.error(
        `Failed to parse ${claudeConfigPath}:`,
        error instanceof Error ? error.message : error
      )
      process.exit(1)
    }
  }

  config.mcpServers ??= {}
  config.mcpServers[`queue`] = {
    command: `node`,
    args: [queueBinPath],
  }

  writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2) + `\n`)
  console.log(`Registered queue channel in ${claudeConfigPath}`)
  console.log(`  command: node ${queueBinPath}`)
  console.log(``)
  console.log(
    `To enable live-collaboration for new CC sessions, start claude with:`
  )
  console.log(``)
  console.log(`  claude --dangerously-load-development-channels server:queue`)
  console.log(``)
  console.log(
    `You can alias this in your shell. Once CC is running with channels,`
  )
  console.log(
    `every \`/share live\` in that session enables remote prompt submission`
  )
  console.log(`from the share URL — no CC restart needed.`)
}

/**
 * Write the per-session collab config so the queue-channel MCP
 * subprocess (already running under CC) picks up the session's DS
 * queue URL and auth token. The subprocess watches
 * ~/.capi/active-collab.json via fs.watch.
 */
function writeCollabConfig(opts: {
  sessionId: string
  dsBase: string
  queueUrl: string
  token: string | undefined
}): string {
  const dir = join(homedir(), `.capi`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `active-collab.json`)
  const payload = {
    sessionId: opts.sessionId,
    dsBase: opts.dsBase,
    queueUrl: opts.queueUrl,
    dsToken: opts.token,
    // Include the watcher's PID so a new CC session's queue-channel MCP
    // can detect stale configs (previous watcher crashed or was killed
    // without running its SIGINT handler) and refuse to use them.
    pid: process.pid,
  }
  writeFileSync(path, JSON.stringify(payload, null, 2) + `\n`)
  return path
}

function removeCollabConfig(): void {
  const path = join(homedir(), `.capi`, `active-collab.json`)
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // best-effort on shutdown
    }
  }
}

// ---------------------------------------------------------------------
// Tracked-session commands (git-integrated workflow)
//
// These subcommands work against a per-repo `.capi/` directory. They are
// independent of the ad-hoc `export` / `import` flow. Use them when
// sessions should travel with the code (via git), checkpoint on every
// commit, and be restorable by any teammate at any commit.
// ---------------------------------------------------------------------

function requireRepoRoot(): string {
  const root = findRepoRoot()
  if (!root) {
    console.error(
      `Not inside a git repository. Tracked-session commands (init, checkin, push, list, resume, merge, install-hooks) require one.`
    )
    process.exit(1)
  }
  return root
}

function requireCapiConfig(repoRoot: string): void {
  if (!readConfig(repoRoot)) {
    console.error(
      `capi not initialized in this repo. Run 'capi init --server <url>' first.`
    )
    process.exit(1)
  }
}

/**
 * Resolve the agent to use for a tracked-session command. Checks --agent
 * first, then the user's local preference (.capi/.local/preferences.json,
 * gitignored so it doesn't leak across teammates). When `required`,
 * errors out if neither is set — no silent default, since a mismatched
 * default would bite codex-only users.
 */
function resolveTrackedAgent(
  args: Record<string, string | boolean>,
  repoRoot: string,
  required: boolean
): AgentType | undefined {
  const flag = args.agent as AgentType | undefined
  const prefs = readPreferences(repoRoot)
  const resolved = flag ?? prefs.agent
  if (!resolved && required) {
    console.error(`No agent specified and no preferred agent configured.`)
    console.error(`Either:`)
    console.error(`  - pass --agent claude|codex to this command, or`)
    console.error(
      `  - set a local preference: capi init --agent claude|codex --server <url>`
    )
    process.exit(1)
  }
  return resolved
}

/** Read the Claude session slug from the first entry that has one. */
function readClaudeSlug(jsonlPath: string): string | null {
  try {
    const content = fs.readFileSync(jsonlPath, `utf-8`)
    for (const line of content.split(`\n`)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (typeof entry.slug === `string`) return entry.slug
      } catch {
        continue
      }
    }
  } catch {
    return null
  }
  return null
}

async function cmdInit(args: Record<string, string | boolean>): Promise<void> {
  const server = args.server as string | undefined
  if (!server) {
    console.error(`Error: --server <url> is required\n`)
    showHelp()
    process.exit(1)
  }

  const repoRoot = requireRepoRoot()
  writeConfig(repoRoot, { server, version: 1 })

  const agent = args.agent as AgentType | undefined
  if (agent) {
    writePreferences(repoRoot, { agent })
  }

  const token = args.token as string | undefined
  if (token) {
    saveToken(repoRoot, token)
    console.log(`Token saved to .capi/.local/credentials.json`)
  }

  console.log(`Initialized capi in ${repoRoot}`)
  console.log(`  Config: .capi/config.json (shared)`)
  if (agent) {
    console.log(
      `  Preferred agent: ${agent} (local only — .capi/.local/preferences.json)`
    )
  } else {
    console.log(
      `  No preferred agent set. Pass --agent to checkin/resume, or re-init with --agent.`
    )
  }
  console.log(
    `  Add to git: git add .capi/config.json .capi/sessions/ .capi/.local/.gitignore`
  )
}

async function cmdCheckin(
  args: Record<string, string | boolean>
): Promise<void> {
  const repoRoot = requireRepoRoot()
  requireCapiConfig(repoRoot)
  const checkinAgent = resolveTrackedAgent(args, repoRoot, true)!

  let sessionId = args.session as string | undefined
  let cwd: string | undefined
  let match: DiscoveredSession | undefined

  if (!sessionId) {
    const all = await discoverSessions(checkinAgent)
    const active = all.filter((s) => s.active)
    let candidates = active.filter((s) => s.cwd === process.cwd())
    if (candidates.length === 0) candidates = active
    if (candidates.length === 0) {
      console.error(`No active ${checkinAgent} sessions found.`)
      console.error(`Use --session <id> to specify one explicitly.`)
      process.exit(1)
    }
    if (candidates.length > 1) {
      console.error(`Multiple active sessions found:`)
      for (const s of candidates) {
        console.error(`  ${s.sessionId} (cwd: ${s.cwd ?? `?`})`)
      }
      console.error(`\nUse --session <id> to specify which one.`)
      process.exit(1)
    }
    match = candidates[0]
    sessionId = match.sessionId
    cwd = match.cwd
  } else {
    const all = await discoverSessions(checkinAgent)
    match = all.find((s) => s.sessionId === sessionId)
    cwd = match?.cwd
  }

  const resolvedCwd = cwd ?? process.cwd()
  const realCwd = fs.existsSync(resolvedCwd)
    ? fs.realpathSync(resolvedCwd)
    : resolvedCwd
  const realRoot = fs.realpathSync(repoRoot)
  let relativeCwd: string
  if (realCwd.startsWith(realRoot)) {
    const rel = realCwd.slice(realRoot.length + 1)
    relativeCwd = rel ? `./${rel}` : `.`
  } else if (resolvedCwd.startsWith(repoRoot)) {
    const rel = resolvedCwd.slice(repoRoot.length + 1)
    relativeCwd = rel ? `./${rel}` : `.`
  } else {
    relativeCwd = resolvedCwd
  }

  let name = args.name as string | undefined
  if (!name) {
    if (checkinAgent === `claude` && match?.path) {
      name = readClaudeSlug(match.path) ?? sessionId.slice(0, 8)
    } else {
      name = sessionId.slice(0, 8)
    }
  }

  const existing = listSessionFiles(repoRoot)
  if (existing.find((s) => s.sessionId === sessionId)) {
    console.log(`Session ${sessionId} is already checked in.`)
    process.exit(0)
  }

  writeSessionFile(repoRoot, {
    sessionId,
    parentSessionId: null,
    streamUrl: null,
    lastOffset: null,
    entryCount: 0,
    name,
    cwd: relativeCwd,
    agent: checkinAgent,
    createdBy: getGitUser(),
    forkedFromOffset: null,
  })

  console.log(`Checked in session: ${name} (${sessionId})`)
  console.log(`  cwd: ${relativeCwd}`)
  console.log(`  agent: ${checkinAgent}`)
  console.log(`  File: .capi/sessions/${sessionId}.json`)
}

async function cmdPush(): Promise<void> {
  const repoRoot = requireRepoRoot()
  requireCapiConfig(repoRoot)

  console.log(`Pushing sessions...`)
  const results = await pushAll(repoRoot)

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.sessionId.slice(0, 8)}: skipped (${r.reason})`)
    } else {
      console.log(
        `  ${r.sessionId.slice(0, 8)}: ${r.entriesPushed} entries → offset ${r.newOffset?.slice(-8) ?? `?`}`
      )
    }
  }

  console.log(`Done. Remember to commit updated session files.`)
}

function cmdList(): void {
  const repoRoot = requireRepoRoot()
  const sessions = listSessionFiles(repoRoot)

  if (sessions.length === 0) {
    console.log(`No sessions checked in. Use 'capi checkin' to add one.`)
    process.exit(0)
  }

  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  const children = new Map<string | null, Array<(typeof sessions)[0]>>()
  for (const s of sessions) {
    const parent = s.parentSessionId
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(s)
  }

  function printSession(s: (typeof sessions)[0], indent: number): void {
    const prefix = indent > 0 ? `${`  `.repeat(indent - 1)}└── ` : ``
    const offset = s.lastOffset
      ? `offset: ...${s.lastOffset.slice(-8)}`
      : `not pushed`
    console.log(
      `${prefix}${s.sessionId}  "${s.name}"  by ${s.createdBy}  cwd: ${s.cwd}  agent: ${s.agent}  ${offset}`
    )
    const kids = children.get(s.sessionId) ?? []
    for (const kid of kids) {
      printSession(kid, indent + 1)
    }
  }

  console.log(`Sessions:`)
  const roots = children.get(null) ?? []
  for (const s of sessions) {
    if (s.parentSessionId && !byId.has(s.parentSessionId)) {
      roots.push(s)
    }
  }
  for (const s of roots) {
    printSession(s, 0)
  }
}

async function cmdResume(
  args: Record<string, string | boolean>,
  positional: Array<string>
): Promise<void> {
  const repoRoot = requireRepoRoot()
  requireCapiConfig(repoRoot)

  let sessionId = positional[0]
  if (!sessionId || sessionId.startsWith(`-`)) {
    const sessions = listSessionFiles(repoRoot)
    if (sessions.length === 0) {
      console.error(`No sessions to resume.`)
      process.exit(1)
    }
    if (sessions.length === 1) {
      sessionId = sessions[0]!.sessionId
    } else {
      console.error(`Multiple sessions available:`)
      for (const s of sessions) {
        console.error(`  ${s.sessionId}  "${s.name}"  by ${s.createdBy}`)
      }
      console.error(`\nSpecify which one: capi resume <session-id>`)
      process.exit(1)
    }
  }

  const allSessions = listSessionFiles(repoRoot)
  const match =
    allSessions.find((s) => s.sessionId === sessionId) ??
    allSessions.find((s) => s.name === sessionId)
  if (match) {
    sessionId = match.sessionId
  }

  const noCheckin = args[`no-checkin`] === true
  const atCommit = args.at as string | undefined
  const targetAgent = resolveTrackedAgent(args, repoRoot, false)

  console.log(`Forking session ${sessionId.slice(0, 8)}...`)

  const result = await resumeTracked({
    sessionId,
    repoRoot,
    noCheckin,
    atCommit,
    targetAgent,
  })

  console.log(`  New session: ${result.newSessionId}`)
  console.log(`  Restored ${result.entriesRestored} entries`)
  console.log(`  Agent: ${result.agent}`)
  if (!noCheckin) {
    console.log(`  Checked in: .capi/sessions/${result.newSessionId}.json`)
  }

  if (result.agent === `codex`) {
    console.log(
      `\nResume with: cd ${result.cwd} && codex resume ${result.newSessionId}`
    )
  } else {
    console.log(
      `\nResume with: cd ${result.cwd} && claude --resume ${result.newSessionId}`
    )
  }
}

function cmdMerge(positional: Array<string>): void {
  const repoRoot = requireRepoRoot()
  requireCapiConfig(repoRoot)

  const sessionA = positional[0]
  const sessionB = positional[1]
  if (
    !sessionA ||
    !sessionB ||
    sessionA.startsWith(`-`) ||
    sessionB.startsWith(`-`)
  ) {
    console.error(`Error: two session IDs are required\n`)
    showHelp()
    process.exit(1)
  }

  mergeTracked({ sessionA, sessionB, repoRoot })
}

function cmdInstallHooks(): void {
  const repoRoot = requireRepoRoot()
  const hooksDir = `${repoRoot}/.git/hooks`
  const hookPath = `${hooksDir}/pre-commit`
  const capiCliPath = new URL(`./cli.js`, import.meta.url).pathname

  const hookContent = `#!/bin/sh
# capi pre-commit hook — pushes tracked session data to DS and stages updated files
# set -e so a failing push aborts the commit.
set -e
node ${capiCliPath} push
# Stage any updated session files (best-effort — no sessions is fine).
git add .capi/sessions/ 2>/dev/null || true
`

  if (
    fs.existsSync(hookPath) &&
    !fs.readFileSync(hookPath, `utf-8`).includes(`capi`)
  ) {
    fs.appendFileSync(hookPath, `\n${hookContent}`)
    console.log(`Appended capi to existing pre-commit hook.`)
  } else {
    fs.writeFileSync(hookPath, hookContent)
    fs.chmodSync(hookPath, `755`)
    console.log(`Installed pre-commit hook: ${hookPath}`)
  }
  console.log(`Tracked sessions will be auto-pushed on each commit.`)
}

function showHelp(): void {
  console.log(`capi - Agent Session Protocol CLI

Usage:
  # Ad-hoc share / import
  capi export [--server <url>] [--agent claude|codex] [--session <id>] [--token <token>] [--shortener <url>] [--live]
  capi import <stream-or-short-url> --agent claude|codex [--cwd <dir>] [--resume] [--token <token>]
  capi install-skills [--claude] [--codex] [--global]
  capi install-channel

  # Tracked sessions (git-integrated workflow, inside a git repo)
  capi init --server <url> [--token <token>] [--agent claude|codex]
  capi checkin [--session <id>] [--name <n>] [--agent claude|codex]
  capi push
  capi list
  capi resume [<session-id-or-name>] [--agent claude|codex] [--no-checkin] [--at <commit>]
  capi merge <session-A> <session-B>
  capi install-hooks

Options:
  --server <url>     Durable Streams server URL (export/init)
  --agent <type>     Agent type: claude or codex
  --session <id>     Session/thread ID (defaults to active/most recent)
  --cwd <dir>        Working directory for imported session
  --resume           After importing, immediately resume the session
  --token <token>    Auth token for the DS server (or set CAPI_TOKEN)
  --shortener <url>  URL of a share-URL shortener
  --live             Live mode: keep watching the source session

Environment variables:
  CAPI_SERVER         Default Durable Streams server URL
  CAPI_TOKEN          Auth token (same as --token)
  CAPI_SHORTENER      Default shortener URL (same as --shortener)`)
}

async function main(): Promise<void> {
  const { command, args, positional } = parseArgs(process.argv.slice(2))

  const token =
    (args.token as string | undefined) ??
    process.env.CAPI_TOKEN ??
    process.env.DS_TOKEN
  if (token) {
    globalHeaders = { Authorization: `Bearer ${token}` }
  }

  switch (command) {
    case `export`:
      await exportSession(args, positional)
      break
    case `import`:
      await importSession(args, positional)
      break
    case `install-skills`:
      installSkills(args)
      break
    case `install-channel`:
      installChannel()
      break
    // Tracked-session subcommands
    case `init`:
      await cmdInit(args)
      break
    case `checkin`:
      await cmdCheckin(args)
      break
    case `push`:
      await cmdPush()
      break
    case `list`:
      cmdList()
      break
    case `resume`:
      await cmdResume(args, positional)
      break
    case `merge`:
      cmdMerge(positional)
      break
    case `install-hooks`:
      cmdInstallHooks()
      break
    case `help`:
    case `--help`:
    case `-h`:
      showHelp()
      break
    default:
      console.error(`Unknown command: ${command}`)
      showHelp()
      process.exit(1)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
