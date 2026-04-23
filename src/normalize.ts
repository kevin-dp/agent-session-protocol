import { normalizeClaude } from "./normalize/claude.js"
import { normalizeCodex } from "./normalize/codex.js"
import type {
  AgentType,
  NormalizeOptions,
  NormalizedEvent,
} from "./types.js"

export function normalize(
  lines: Array<string>,
  agent: AgentType,
  options: NormalizeOptions = {}
): Array<NormalizedEvent> {
  switch (agent) {
    case `claude`:
      return normalizeClaude(lines, options)
    case `codex`:
      return normalizeCodex(lines, options)
    default:
      throw new Error(`Unsupported agent: ${agent as string}`)
  }
}
