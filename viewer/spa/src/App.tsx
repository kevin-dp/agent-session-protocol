import { useEffect, useState } from "react"
import { Landing } from "./components/Landing"
import { extractTokenFromFragment } from "./lib/token"
import type { ResolvedEntry } from "./lib/types"

function getShortIdFromPath(): string | null {
  const path = window.location.pathname
  const match = path.match(/^\/([A-Za-z0-9]+)\/?$/)
  return match ? match[1]! : null
}

// Hardcoded DS service token for the hosted viewer so visitors don't need
// to paste it themselves. Scoped to this service's read-only streams; a
// URL fragment token still overrides when present.
const DEFAULT_TOKEN =
  `eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzZXJ2aWNlX2lkIjoic3ZjLXNwb250YW5lb3VzLWdpcmFmZmUtNTFqeHU2ejE0ayIsImlhdCI6MTc3NjMyNzQwNn0.cR4gX36eDHFPydNO966ZT5K6VWXCzNd5GNtFa0D95OA`

export function App(): JSX.Element {
  const [entry, setEntry] = useState<ResolvedEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(DEFAULT_TOKEN)

  useEffect(() => {
    const shortId = getShortIdFromPath()
    if (!shortId) {
      setError(`No short URL in path`)
      return
    }

    const fragmentToken = extractTokenFromFragment()
    if (fragmentToken) {
      setToken(fragmentToken)
    }

    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/${shortId}`, {
          headers: { accept: `application/json` },
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = (await response.json()) as ResolvedEntry
        if (!cancelled) setEntry(data)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <div className="container">
        <div className="brand">
          <span className="brand-dot"></span>
          <span>Powered by Electric</span>
        </div>
        <h1>Not found</h1>
        <p className="lede">{error}</p>
      </div>
    )
  }

  if (!entry) {
    return <div className="center-state">Loading…</div>
  }

  const shortUrl = `${window.location.origin}${window.location.pathname}`
  return (
    <Landing
      shortUrl={shortUrl}
      entry={entry}
      activeToken={token}
      onWatch={setToken}
    />
  )
}
