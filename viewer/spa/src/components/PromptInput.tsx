import { useEffect, useLayoutEffect, useRef, useState } from "react"

const NAME_STORAGE_KEY = `live-share-user-name`

interface Props {
  // Base URL of the live session's DS stream (e.g.
  // https://.../asp/<sessionId>/live). We POST prompts to `${fullUrl}/prompts`.
  fullUrl: string
  token: string
  // Disabled when the session has ended — no live Claude to consume prompts.
  disabled?: boolean
}

type SubmitState =
  | { kind: `idle` }
  | { kind: `sending` }
  | { kind: `sent` }
  | { kind: `error`; message: string }

export function PromptInput({ fullUrl, token, disabled }: Props): JSX.Element {
  const [text, setText] = useState(``)
  const [name, setName] = useState(() => {
    if (typeof window === `undefined`) return ``
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? ``
  })
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: `idle` })
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (submitState.kind !== `sent`) return
    // Clear the "sent" badge after a moment so it's not sticky.
    const id = setTimeout(() => setSubmitState({ kind: `idle` }), 2000)
    return () => clearTimeout(id)
  }, [submitState])

  // Auto-grow the textarea to fit its content. Runs after every render that
  // changes `text` — including when we clear it on submit, which shrinks the
  // box back to its min-height via the CSS `min-height`.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = `auto`
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const persistName = (next: string): void => {
    setName(next)
    if (typeof window !== `undefined`) {
      if (next.trim()) {
        window.localStorage.setItem(NAME_STORAGE_KEY, next.trim())
      } else {
        window.localStorage.removeItem(NAME_STORAGE_KEY)
      }
    }
  }

  const submit = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    setSubmitState({ kind: `sending` })

    const body = {
      v: 1,
      ts: Date.now(),
      type: `prompt`,
      text: trimmed,
      user: name.trim() ? { name: name.trim() } : undefined,
    }

    try {
      const res = await fetch(`${fullUrl}/prompts`, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => ``)
        throw new Error(`HTTP ${res.status}${errText ? `: ${errText}` : ``}`)
      }
      setText(``)
      setSubmitState({ kind: `sent` })
      // Keep focus in the textarea so you can fire off another prompt fast.
      textareaRef.current?.focus()
    } catch (error) {
      setSubmitState({
        kind: `error`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter submits, Shift+Enter inserts a newline (standard chat UX).
    if (e.key === `Enter` && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const canSubmit =
    !disabled && text.trim().length > 0 && submitState.kind !== `sending`

  return (
    <div className="prompt-input">
      <form
        className="prompt-input-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <textarea
          ref={textareaRef}
          className="prompt-input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            disabled
              ? `Session ended — no active agent to receive prompts.`
              : `Ask something, or paste a message. Enter to send; Shift+Enter for a new line.`
          }
          disabled={disabled}
          aria-label="Prompt for live session"
        />
        <div className="prompt-input-name-row">
          <label className="prompt-input-name-label">
            <span>name:</span>
            <input
              type="text"
              value={name}
              onChange={(e) => persistName(e.target.value)}
              placeholder="anonymous"
              className="prompt-input-name"
              maxLength={40}
              disabled={disabled}
            />
          </label>
          <div className="prompt-input-submit-right">
            {submitState.kind === `sending` && (
              <span className="prompt-input-status sending">Sending…</span>
            )}
            {submitState.kind === `sent` && (
              <span className="prompt-input-status sent">Sent ✓</span>
            )}
            {submitState.kind === `error` && (
              <span
                className="prompt-input-status error"
                title={submitState.message}
              >
                Failed — {submitState.message}
              </span>
            )}
            <button
              type="submit"
              className="btn primary prompt-input-submit"
              disabled={!canSubmit}
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
