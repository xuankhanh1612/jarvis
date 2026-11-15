/**
 * A minimal MCP client, for the Gemini path.
 *
 * WHY THIS EXISTS AT ALL
 *
 * On the Anthropic path, `mcp_servers` is a parameter: Anthropic's own
 * infrastructure dials each server, discovers its tools, and executes the calls
 * mid-turn. The browser sends one request and reads one event stream.
 *
 * Google's API has no such arrangement. Nothing dials an MCP server on your
 * behalf, so if JARVIS is going to keep its tools on Gemini, something has to.
 * That something is api/gemini — and this is the part of it that speaks the
 * protocol.
 *
 * WHAT IT IMPLEMENTS, AND WHAT IT DOES NOT
 *
 * The 2025-06-18 Streamable HTTP transport: a POST carrying a JSON-RPC message,
 * whose reply is either a JSON body or an SSE stream of them. That is what the
 * remote servers in src/config.ts speak. It is a deliberate subset:
 *
 *   - no stdio. There is no machine to run a local server on inside a function.
 *   - no OAuth dance. Servers that want a browser flow need a token pasted in
 *     as a bearer, which is what the existing MCP config already does.
 *   - no reconnection / resumability. A turn is short and a failed turn is
 *     retried by the user saying the thing again.
 *
 * A roughly 150-line client that does the thing beats a complete one that does
 * not fit in a serverless function's startup budget.
 */

/** One tool as the model needs to see it: name, description, JSON schema. */
export type McpTool = {
  /** Namespaced — `notion__search` — because two servers can share a name. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Which server it came from, so a call can be routed back. */
  server: string
}

type JsonRpcResponse = {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string }
}

/** How long to wait on any single step of the handshake or a call. */
const STEP_TIMEOUT_MS = 20_000

/**
 * A connection is nothing but a URL and a token.
 *
 * The MCP session id is negotiated per server and kept on the object, because
 * some servers require it on every subsequent request and will 400 without it.
 */
type Session = { id: string | null }

const sessions = new Map<string, Session>()

function headersFor(server: { url: string; token?: string }, session?: Session): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    // Both are required by the spec for the Streamable HTTP transport.
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  })
  if (server.token) headers.set('authorization', `Bearer ${server.token}`)
  if (session?.id) headers.set('mcp-session-id', session.id)
  return headers
}

/**
 * Send one JSON-RPC message and return its response, or null for a
 * notification (which has no id and gets no reply by definition).
 *
 * The response can arrive in two shapes. A server may answer `application/json`
 * with one object, or `text/event-stream` with a stream of them — the spec
 * allows either for the same request, and large servers switch based on whether
 * the request carries a session. Both are parsed here so callers do not have to
 * know which they got.
 */
async function rpc(
  server: { url: string; token?: string },
  message: Record<string, unknown>,
  session: Session,
): Promise<JsonRpcResponse | null> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: headersFor(server, session),
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  })

  // The session id is assigned on initialize and must be echoed afterwards.
  const assigned = response.headers.get('mcp-session-id')
  if (assigned) session.id = assigned

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${server.url} answered ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const type = response.headers.get('content-type') ?? ''
  if (type.includes('text/event-stream')) {
    // Read only as far as the reply that matches this id. The stream may stay
    // open for notifications afterwards, and waiting for it to close would hang
    // until the timeout.
    return await readSseReply(response, message.id)
  }

  if (response.status === 202 || response.status === 204) return null
  const body = await response.text()
  if (!body.trim()) return null
  return JSON.parse(body) as JsonRpcResponse
}

/** Pull the first SSE `data:` payload whose id matches, then stop reading. */
async function readSseReply(response: Response, id: unknown): Promise<JsonRpcResponse | null> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let last: JsonRpcResponse | null = null

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Events are separated by a blank line; each `data:` line is one JSON-RPC
      // message.
      let split: number
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const json = line.slice(5).trim()
          if (!json) continue
          try {
            const parsed = JSON.parse(json) as JsonRpcResponse
            last = parsed
            // The reply to our request. Notifications (no id) are ignored —
            // there is nothing here that wants them.
            if (parsed.id !== undefined && (id === undefined || parsed.id === id)) return parsed
          } catch {
            /* a partial or malformed event — keep reading */
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return last
}

/**
 * Connect, handshake, and list the tools of one server.
 *
 * Failure is deliberately non-fatal at the call site: an MCP server being down
 * should cost JARVIS those tools, not the whole answer. The error is returned
 * rather than thrown so the caller can report it in one line and carry on.
 */
export async function discoverTools(server: {
  name: string
  url: string
  token?: string
}): Promise<{ tools: McpTool[]; error?: string }> {
  const session: Session = sessions.get(server.name) ?? { id: null }
  sessions.set(server.name, session)

  try {
    const init = await rpc(
      server,
      {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'jarvis', version: '0.0.0' },
        },
      },
      session,
    )
    if (init?.error) throw new Error(init.error.message ?? 'initialize failed')

    // Required by the spec before any other request will be served.
    await rpc(server, { method: 'notifications/initialized' }, session)

    const list = await rpc(server, { id: 2, method: 'tools/list', params: {} }, session)
    if (list?.error) throw new Error(list.error.message ?? 'tools/list failed')

    const raw = (list?.result as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? []
    const tools = raw
      .filter((t) => typeof t.name === 'string')
      .map((t) => ({
        // Namespaced so two servers can both have a `search` without one
        // silently shadowing the other.
        name: `${server.name}__${t.name as string}`,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema:
          (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
        server: server.name,
      }))

    return { tools }
  } catch (err) {
    sessions.delete(server.name)
    return { tools: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Call one tool.
 *
 * The result is flattened to text because that is what both Gemini and the
 * spoken answer want; images and audio in a tool result are described rather
 * than relayed, which keeps this path free of a media pipeline.
 */
export async function callTool(
  server: { name: string; url: string; token?: string },
  /** The raw tool name, without the `server__` namespace. */
  tool: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const session = sessions.get(server.name) ?? { id: null }
  sessions.set(server.name, session)

  try {
    const reply = await rpc(
      server,
      { id: 3, method: 'tools/call', params: { name: tool, arguments: args } },
      session,
    )
    if (reply?.error) return { text: reply.error.message ?? 'tool call failed', isError: true }

    const result = reply?.result as
      | { content?: Array<Record<string, unknown>>; isError?: boolean }
      | undefined

    const parts: string[] = []
    for (const item of result?.content ?? []) {
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      } else if (typeof item.type === 'string') {
        // Deliberately descriptive. A tool that returns an image cannot reach
        // the screen through this path, so saying so is better than sending
        // the model a mystery blob it will try to describe anyway.
        parts.push(`[${item.type} content omitted]`)
      }
    }

    return {
      text: parts.join('\n').trim() || '(no content)',
      isError: Boolean(result?.isError),
    }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}

/** For the tests: drop any cached sessions. */
export function _resetSessions(): void {
  sessions.clear()
}
