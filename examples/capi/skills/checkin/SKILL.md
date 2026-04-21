---
name: checkin
description: Check in this CC session for tracking via capi
---

Mark the current Claude Code session for tracking in the capi index. This means the session will be persisted to a Durable Stream on each git commit (if the pre-commit hook is installed).

Steps:

1. Run: `capi checkin --session ${CLAUDE_SESSION_ID} --agent claude`

   The `--agent claude` flag is always correct here since this skill runs inside Claude Code. It's passed explicitly so the command works even when the user hasn't configured a local agent preference via `capi init --agent ...`.

2. Tell the user:
   - The session has been checked in
   - It will be pushed to the Durable Stream on each commit (if `capi install-hooks` has been run)
   - They can also manually push with `capi push`
   - Teammates who pull the repo can resume it in either Claude or Codex via `capi resume <id> --agent <agent>`
