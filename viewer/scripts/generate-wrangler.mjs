#!/usr/bin/env node
/**
 * Generate wrangler.toml from wrangler.template.toml by substituting
 * env vars. Called by `predev` / `predeploy` hooks.
 *
 * Required env:
 *   VIEWER_KV_NAMESPACE_ID
 *
 * Optional env:
 *   VIEWER_DOMAIN            if unset, the [[routes]] block is removed
 *                            (worker deploys to *.workers.dev by default)
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const templatePath = join(root, "wrangler.template.toml")
const outputPath = join(root, "wrangler.toml")

const kvId = process.env.VIEWER_KV_NAMESPACE_ID
const domain = process.env.VIEWER_DOMAIN

if (!kvId) {
  console.error(`Error: VIEWER_KV_NAMESPACE_ID is not set.`)
  console.error(``)
  console.error(`Create a KV namespace once with:`)
  console.error(`  wrangler kv namespace create SHORTENER_KV`)
  console.error(`…then export the returned id as VIEWER_KV_NAMESPACE_ID.`)
  process.exit(1)
}

let content = readFileSync(templatePath, `utf-8`)

// If no custom domain is configured, strip the whole [[routes]] block —
// the worker will fall back to the default *.workers.dev subdomain.
// Match up to (but not including) the next top-level TOML section.
// The template keeps [[routes]] before [vars], so the lazy match to
// `\n[` reliably terminates at `[vars]`. No /m flag: `$` in multiline
// mode would match every end-of-line and the lazy match would truncate
// to the first line of the block.
if (!domain) {
  content = content.replace(/\n\[\[routes\]\][\s\S]*?(?=\n\[)/, ``)
}

// Substitute placeholders.
content = content.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name) => {
  const value = process.env[name]
  if (value === undefined) {
    throw new Error(`Template references $\{${name}\} but no env var is set.`)
  }
  return value
})

writeFileSync(outputPath, content)
console.error(
  `Generated ${outputPath.replace(root + "/", "")}` +
    (domain ? ` (domain: ${domain})` : ` (no custom domain)`)
)
