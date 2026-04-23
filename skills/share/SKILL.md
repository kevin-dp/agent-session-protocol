---
name: share
description: Share the current agent session (Claude Code or Codex) via Durable Streams. Produces a URL that can be resumed in any supported agent. Supports two modes - "snapshot" (default) creates a frozen point-in-time copy, "live" creates a continuously-updated URL viewers can watch in real-time.
metadata:
  short-description: Share this session so it can be resumed elsewhere
---

# Share Agent Session

Export the current session to a Durable Stream. Produces a URL that can be imported into Claude Code, Codex, or any other supported agent — and optionally watched live in a browser.

## Modes

The user invokes the skill in one of two ways:

- **`/share`** (no argument) — **snapshot mode**. A frozen point-in-time copy of the session. Each invocation creates a new URL.
- **`/share live`** — **live mode**. A single URL that keeps updating as the session grows. The same URL is reused across invocations for the same session. Viewers can watch the conversation unfold in their browser. The watcher process runs in the background until killed.

If the user's argument is exactly `live` (case-insensitive), use live mode. Otherwise use snapshot mode.

## Prerequisites

The `capi` CLI must be available (from the `agent-session-protocol` npm package).

The Durable Streams server URL must be configured via the `CAPI_SERVER` environment variable, or passed with `--server`. If the server requires auth, set `CAPI_TOKEN` or pass `--token`.

Optionally, a shortener URL can be configured via `CAPI_SHORTENER` or `--shortener` — when set, the output is a short, human-friendly URL instead of the raw DS URL.

### One-time setup for live collaboration (optional)

Live mode can also accept prompts from viewers in the browser — they type a prompt on the share page and Claude picks it up and responds. This requires a one-time setup on the user's machine:

1. Register the channel MCP server: `capi install-channel`
2. From then on, start Claude with `claude --dangerously-load-development-channels server:queue` (aliasable). Plain `claude` still works, but `/share live` won't accept viewer prompts in that session.

If the user hasn't done this setup, `/share live` still works for read-only live viewing — just no bidirectional prompt submission.

## Steps

Agent type is auto-detected. If auto-detection fails, pass `--agent claude` or `--agent codex` explicitly. The calling session ID is also picked up automatically when running inside a CC session.

1. Run the appropriate command:

   **Snapshot** (`/share`):

   ```bash
   capi export
   ```

   The share URL is the last line printed to stdout.

   **Live** (`/share live`) — must be backgrounded so the agent session can continue. A plain `capi export --live &` doesn't work because the URL is printed AFTER the initial push returns, so capturing it requires redirecting to a file and polling:

   ```bash
   OUT=$(mktemp /tmp/capi-live.XXXXXX)
   capi export --live > "$OUT" 2>&1 &
   PID=$!
   for i in 1 2 3 4 5 6 7 8 9 10; do
     URL=$(grep -oE 'https?://[^ ]+' "$OUT" | tail -1)
     [ -n "$URL" ] && break
     sleep 0.5
   done
   echo "URL: $URL"
   echo "PID: $PID"
   echo "Log: $OUT"
   ```

   Record both `URL` and `PID` — the user will need the PID to stop the share. If `URL` is still empty after the loop, fall back to printing the contents of `$OUT` so the user can see what went wrong.

2. Tell the user, adapting based on mode:

   **Snapshot mode:**
   - A snapshot of this session has been shared at: **\<share-url\>**
   - Open the URL in a browser to see metadata and resume instructions. With a valid auth token, you can also watch the session content directly in the browser.
   - To resume from the CLI in Claude Code:
     ```bash
     capi import <share-url> --agent claude --resume
     ```
   - To resume from the CLI in Codex:
     ```bash
     capi import <share-url> --agent codex --resume
     ```

   **Live mode:**
   - This session is now being **live-shared** at: **\<share-url\>**
   - The share will keep updating as the conversation grows. Anyone with the URL can open it in a browser to watch the session unfold in real-time (with a valid auth token).
   - **If Claude was started with `--dangerously-load-development-channels server:queue`**: viewers can also type prompts on the share page; they arrive as `<channel source="queue" user="...">` events and Claude responds to them automatically. See the "One-time setup for live collaboration" section above.
   - To stop sharing: `kill <PID>` (or `pkill -f 'capi export --live'` if the PID is lost).
   - To resume the current state from the CLI in Claude Code:
     ```bash
     capi import <share-url> --agent claude --resume
     ```
   - To resume the current state in Codex:
     ```bash
     capi import <share-url> --agent codex --resume
     ```
   - Resuming creates a snapshot of the session as it is at import time — it doesn't keep streaming updates.

In both cases, importing requires a valid auth token. Add `--token <token>` if needed (or set `CAPI_TOKEN`).

## Notes

- Same-agent resume (Claude → Claude or Codex → Codex) is lossless — full history preserved via a native stream.
- Cross-agent resume (Claude → Codex or Codex → Claude) uses the normalized format — semantic content is preserved but tool calls are represented generically.
- Snapshot URLs are unique per export. Live URLs are stable for the lifetime of a single agent session — if the user restarts their agent, `/share live` produces a new URL.
