/**
 * capi config management.
 * .capi/config.json — checked into git (server URL)
 * .capi/.local/credentials.json — per-user, gitignored (token)
 * .capi/.local/ — gitignored (push state)
 */

import * as fs from "node:fs"
import * as path from "node:path"

export interface CapiConfig {
  server: string
  version: number
}

export interface Credentials {
  token?: string
}

export interface LocalSessionState {
  lastPushedUuid?: string
}

/**
 * Per-user preferences stored in .capi/.local/ (gitignored) so that one
 * dev's agent choice doesn't leak to teammates via the shared config.json.
 */
export interface CapiPreferences {
  agent?: `claude` | `codex`
}

/**
 * Find the repo root by looking for .git directory.
 */
export function findRepoRoot(from: string = process.cwd()): string | null {
  let dir = path.resolve(from)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    if (fs.existsSync(path.join(dir, `.git`))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Get the .capi directory path.
 */
export function getCapiDir(repoRoot: string): string {
  return path.join(repoRoot, `.capi`)
}

/**
 * Read the capi config. Returns null if not initialized.
 */
export function readConfig(repoRoot: string): CapiConfig | null {
  const configPath = path.join(getCapiDir(repoRoot), `config.json`)
  if (!fs.existsSync(configPath)) return null
  return JSON.parse(fs.readFileSync(configPath, `utf-8`)) as CapiConfig
}

/**
 * Write the capi config.
 */
export function writeConfig(repoRoot: string, config: CapiConfig): void {
  const capiDir = getCapiDir(repoRoot)
  fs.mkdirSync(capiDir, { recursive: true })
  fs.writeFileSync(
    path.join(capiDir, `config.json`),
    JSON.stringify(config, null, 2) + `\n`
  )

  // Create .local directory with .gitignore
  const localDir = path.join(capiDir, `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  const gitignorePath = path.join(capiDir, `.local`, `.gitignore`)
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `*\n`)
  }

  // Create sessions directory
  fs.mkdirSync(path.join(capiDir, `sessions`), { recursive: true })
}

/**
 * Get auth headers for DS requests.
 */
export function getAuthHeaders(repoRoot: string): Record<string, string> {
  // Check env var first
  const envToken = process.env.SESH_TOKEN
  if (envToken) {
    return { Authorization: `Bearer ${envToken}` }
  }

  // Check credentials file in .capi/.local/
  const credPath = path.join(getCapiDir(repoRoot), `.local`, `credentials.json`)
  if (fs.existsSync(credPath)) {
    const creds = JSON.parse(fs.readFileSync(credPath, `utf-8`)) as Credentials
    if (creds.token) {
      return { Authorization: `Bearer ${creds.token}` }
    }
  }

  return {}
}

/**
 * Save token to credentials file in .capi/.local/ (gitignored).
 */
export function saveToken(repoRoot: string, token: string): void {
  const localDir = path.join(getCapiDir(repoRoot), `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(
    path.join(localDir, `credentials.json`),
    JSON.stringify({ token }, null, 2) + `\n`
  )
}

/**
 * Read local push state for a session.
 */
export function readLocalState(
  repoRoot: string,
  sessionId: string
): LocalSessionState {
  const statePath = path.join(
    getCapiDir(repoRoot),
    `.local`,
    `${sessionId}.json`
  )
  if (!fs.existsSync(statePath)) return {}
  return JSON.parse(fs.readFileSync(statePath, `utf-8`)) as LocalSessionState
}

/**
 * Write local push state for a session.
 */
export function writeLocalState(
  repoRoot: string,
  sessionId: string,
  state: LocalSessionState
): void {
  const localDir = path.join(getCapiDir(repoRoot), `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(
    path.join(localDir, `${sessionId}.json`),
    JSON.stringify(state, null, 2) + `\n`
  )
}

/**
 * Read per-user preferences from .capi/.local/preferences.json.
 */
export function readPreferences(repoRoot: string): CapiPreferences {
  const prefsPath = path.join(
    getCapiDir(repoRoot),
    `.local`,
    `preferences.json`
  )
  if (!fs.existsSync(prefsPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(prefsPath, `utf-8`)) as CapiPreferences
  } catch {
    return {}
  }
}

/**
 * Write per-user preferences to .capi/.local/preferences.json.
 */
export function writePreferences(
  repoRoot: string,
  prefs: CapiPreferences
): void {
  const localDir = path.join(getCapiDir(repoRoot), `.local`)
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(
    path.join(localDir, `preferences.json`),
    JSON.stringify(prefs, null, 2) + `\n`
  )
}
