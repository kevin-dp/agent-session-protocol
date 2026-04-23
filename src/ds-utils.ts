import { DurableStream, FetchError } from "@durable-streams/client"
import type { HeadersRecord } from "@durable-streams/client"

export function buildHeaders(token?: string): HeadersRecord {
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export async function createOrConnectStream(
  url: string,
  contentType: string,
  headers: HeadersRecord
): Promise<DurableStream> {
  try {
    return await DurableStream.create({ url, contentType, headers })
  } catch (error) {
    if (error instanceof FetchError && error.status === 409) {
      return new DurableStream({ url, contentType, headers })
    }
    throw error
  }
}

export async function getStreamItemCount(
  url: string,
  headers: HeadersRecord
): Promise<number> {
  try {
    const resolvedHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
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

export async function pushLines(
  streamUrl: string,
  lines: Array<string>,
  headers: HeadersRecord
): Promise<number> {
  // Delta logic: only push new lines that don't already exist in the stream.
  // Each share gets a unique URL so the stream is usually empty on first
  // push; kept as defensive behavior in case an already-populated URL is
  // passed in.
  const existingCount = await getStreamItemCount(streamUrl, headers)
  if (existingCount >= lines.length) return 0
  const newLines = lines.slice(existingCount)
  if (newLines.length === 0) return 0

  const stream = await createOrConnectStream(
    streamUrl,
    `application/json`,
    headers
  )
  const promises = newLines.map((line) => stream.append(line))
  await Promise.all(promises)
  return newLines.length
}

export async function streamExists(
  url: string,
  headers: HeadersRecord
): Promise<boolean> {
  try {
    const stream = new DurableStream({
      url,
      contentType: `application/json`,
      headers,
    })
    const response = await stream.stream({ json: true, live: false })
    const items = await response.json()
    return items.length > 0
  } catch {
    return false
  }
}

export async function readStream<T>(
  url: string,
  headers: HeadersRecord
): Promise<Array<T>> {
  const stream = new DurableStream({
    url,
    contentType: `application/json`,
    headers,
  })
  const response = await stream.stream<T>({ json: true, live: false })
  return response.json()
}
