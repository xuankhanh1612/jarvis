import { GEMINI_MODEL, SYSTEM_PROMPT, activeServers } from '../config'
import type { AskHandlers, Msg } from './anthropic'

/**
 * The Gemini brain, from the browser side.
 *
 * The shape is deliberately identical to ./anthropic.ts — same `ask`, same
 * handlers, same return value — because src/lib/brain.ts picks between them and
 * App.tsx must not care which model answered. Everything that differs is
 * pushed into the function at api/gemini, including the tool loop; this file is
 * three responsibilities and nothing else:
 *
 *   1. translate the conversation into the body the function expects,
 *   2. read its event stream and turn it back into text deltas and tool events,
 *   3. let a barge-in abort the request.
 *
 * The key is never here. `POST /api/gemini` is same-origin and the function
 * holds the credential, which is the same arrangement api/anthropic uses and the
 * only one that is safe on a public URL.
 */

/** Where the function lives, resolved against the deploy's base path. */
const ENDPOINT = new URL(`${import.meta.env.BASE_URL}api/gemini`, window.location.origin).href

/** Only used to abort the turn in flight; see `cancel`. */
let active: AbortController | null = null

/**
 * A turn of conversation.
 *
 * `history` carries the whole exchange because Gemini's free tier has no
 * server-side session to hold it — every request is self-contained. The caller
 * already trims to the last 16 turns, so this is not unbounded.
 */
export async function ask(
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  const controller = new AbortController()
  active = controller
  const usedTools: string[] = []
  let text = ''

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // The last message is the user's; everything before it is context.
        prompt: lastUserText(history),
        history: toGeminiHistory(history.slice(0, -1)),
        system: SYSTEM_PROMPT,
        model: GEMINI_MODEL,
        // Only remote HTTP servers can work here: a stdio server needs a
        // machine, and the function is not one.
        servers: activeServers().map((s) => ({ name: s.name, url: s.url, token: s.token })),
      }),
      signal: controller.signal,
    })

    // A missing key or a malformed request comes back as JSON, not as a stream.
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}) as { error?: string })
      throw new Error(detail.error ?? `The Gemini endpoint answered ${response.status}.`)
    }

    if (!response.body) throw new Error('The Gemini endpoint returned no body.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Events are separated by a blank line; each `data:` line is one message.
      let split: number
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)

        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (!json) continue

          let event: Record<string, unknown>
          try {
            event = JSON.parse(json)
          } catch {
            continue // a partial frame; the next one will be whole
          }

          if (event.type === 'text' && typeof event.text === 'string') {
            text += event.text
            handlers.onText(event.text)
          } else if (event.type === 'tool' && typeof event.name === 'string') {
            usedTools.push(event.name)
            handlers.onTool(event.name)
          } else if (event.type === 'error') {
            // The function's own sentence, which names the fix rather than a
            // status code. Rethrown so App.tsx shows it in the one place
            // failures are shown.
            throw new Error(typeof event.text === 'string' ? event.text : 'Gemini failed.')
          }
          // `servers` and `notice` are informational. The HUD gets its list
          // from config, so nothing here needs them yet; ignoring them keeps
          // that decision in one place.
        }
      }
    }

    return { text: text.trim(), tools: usedTools }
  } catch (err) {
    // An abort is a barge-in, not a failure. Hand back what he had said, the
    // same as the Anthropic path does.
    if (controller.signal.aborted) return { text: text.trim(), tools: usedTools }
    throw err
  } finally {
    active = null
  }
}

/** Barge-in: stop the request, so Google stops generating. */
export function cancel(): void {
  active?.abort()
}

/**
 * Labels for the HUD's SYSTEMS rail.
 *
 * Same caveat as the Anthropic path: this is what is *configured*. A dead MCP
 * server shows green here and only fails when JARVIS tries to use it — and on
 * this path it fails inside the function, reported as one line on the HUD.
 */
export function connectedLabels(): string[] {
  return activeServers().map((s) => s.label)
}

/* --------------------------------------------------------------- translation */

/** The text of the final user message, which is what this turn is asking. */
function lastUserText(history: Msg[]): string {
  const last = history[history.length - 1]
  if (!last) return ''
  return typeof last.content === 'string' ? last.content : textOf(last.content)
}

/**
 * Prior turns, in Gemini's `contents` shape.
 *
 * Anthropic's `content` is either a string or an array of blocks; the browser
 * only ever builds strings, but tool results appear as arrays in principle, so
 * both are flattened to text. Consecutive same-role turns are merged because
 * Gemini rejects two `user` entries in a row — which happens naturally after a
 * barge-in, where an assistant turn may be empty or missing.
 */
function toGeminiHistory(history: Msg[]): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const out: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []

  for (const message of history) {
    const text = typeof message.content === 'string' ? message.content : textOf(message.content)
    if (!text.trim()) continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    const previous = out[out.length - 1]
    if (previous && previous.role === role) {
      previous.parts[0].text += `\n\n${text}`
    } else {
      out.push({ role, parts: [{ text }] })
    }
  }

  // Gemini requires the history to start with the user. An assistant turn left
  // at the head — possible after a trim to the last 16 — would be rejected.
  while (out.length && out[0].role === 'model') out.shift()
  return out
}

/** Flatten Anthropic content blocks to plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string }
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter(Boolean)
    .join('\n')
}
