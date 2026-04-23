import { denormalizeClaude } from "./denormalize/claude.js"
import { denormalizeCodex } from "./denormalize/codex.js"
import type {
  AgentType,
  DenormalizeOptions,
  NormalizedEvent,
} from "./types.js"

export function denormalize(
  events: Array<NormalizedEvent>,
  agent: AgentType,
  options: DenormalizeOptions = {}
): Array<string> {
  switch (agent) {
    case `claude`:
      return denormalizeClaude(events, options)
    case `codex`:
      return denormalizeCodex(events, options)
    default:
      throw new Error(`Unsupported agent: ${agent as string}`)
  }
}
