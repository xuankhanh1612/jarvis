/**
 * A server-side proxy for the Claude API, so the deployed site never carries a
 * key in its JavaScript.
 *
 * WHY THIS EXISTS
 *
 * `direct` mode calls the Anthropic API from the browser. That works, and it is
 * what makes a static deploy answer at all — but Vite inlines every `VITE_*`
 * value into the bundle at build time, so `VITE_ANTHROPIC_API_KEY` ships to
 * every visitor. Anyone who opens devtools, or opens the network tab, or reads
 * the file from a CDN cache, has the key. On a public URL that is not a
 * theoretical risk; it is a spend limit waiting to be discovered.
 *
 * A static host cannot fix that, because a static host has nowhere to keep a
 * secret. A function does. This one lives at /api/anthropic/* and forwards to
 * api.anthropic.com, adding the key from the environment on the way out. The
 * key lives in Vercel's environment store, is never returned to the browser,
 * and the bundle contains nothing but the path `/api/anthropic`.
 *
 * HOW THE CLIENT USES IT
 *
 * The Anthropic SDK's own `baseURL` option does the routing: the browser
 * constructs `new Anthropic({ baseURL: '/api/anthropic' })` and every request
 * the SDK would have sent to api.anthropic.com arrives here instead, path
 * intact (`/v1/messages`, `/v1/messages/count_tokens`, …). Nothing in the
 * request shape changes, which is why src/lib/anthropic.ts needed no other
 * edit — including MCP servers, hosted tools and streaming, all of which are
 * server-side features that were already opaque to the browser.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No CORS headers. This is same-origin by construction — the page and the
 * function are served from the same hostname — so a browser sending
 * `Origin: https://elsewhere.example` gets no allowance to do so. Adding
 * `Access-Control-Allow-Origin: *` here would turn this into an open relay for
 * anyone's Anthropic bill, which is exactly the problem it was built to fix.
 *
 * No key echoing. Errors are passed through as their upstream body, which
 * describes the problem; the key appears in neither direction.
 */

/**
 * Upstream base. Not configurable by the client, and not by an environment
 * variable either — a host that can be pointed at an arbitrary URL is a proxy
 * for whatever the caller likes, which is what open relays are made of. If you
 * genuinely need a different host (a gateway, a local mock), change this line.
 */
const UPSTREAM = 'https://api.anthropic.com'

/**
 * Request headers that must not be forwarded.
 *
 * `host` is set by each hop and forwarding it corrupts the upstream vhost.
 * `authorization` and `x-api-key` are the interesting ones: the browser has no
 * key to send, but if a caller supplies one it must not be allowed to override
 * the server's, and it must not be logged. Everything else — `anthropic-version`,
 * `anthropic-beta`, `content-type`, `accept` — is what makes the request work,
 * and `x-stainless-*` carries the SDK's own metadata.
 */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'authorization',
  'x-api-key',
  'accept-encoding',
  'cookie',
])

/**
 * Response headers that must not be forwarded.
 *
 * `content-encoding` and `content-length` describe the upstream body as it was
 * on the wire. Node decodes the body before we see it, so relaying either makes
 * the browser try to gunzip plain bytes, or wait for a length that no longer
 * matches. Vercel sets the rest itself.
 */
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

/** Methods the API defines. Anything else is not ours to forward. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE'])

/**
 * Paths the proxy will carry.
 *
 * An allowlist rather than "everything", because the value of a proxy is
 * exactly that it is narrow. These are the endpoints the SDK can reach from the
 * app: messages (create, stream, count tokens, batch) and the models list. A
 * caller cannot use this function to reach an unrelated part of the API.
 */
const ALLOWED_PATH = /^\/(v1\/(messages|messages\/count_tokens|messages\/batches|models)(\/[\w.-]+)*)$/

/**
 * A crude ceiling on request size. The app sends a short voice turn — a few
 * kilobytes of history and a system prompt — so anything megabytes in size is
 * not a conversation, it is someone using the proxy as free storage or trying
 * to make the bill interesting.
 */
const MAX_BODY_BYTES = 1_000_000

/**
 * The handler Vercel calls.
 *
 * Two signatures exist for `api/` functions and which one is used depends on
 * the runtime version rather than on anything this file declares, so both are
 * accepted instead of betting on one:
 *
 *   (request: Request) => Response            — the Web API signature
 *   (req: IncomingMessage, res: ServerResponse) => void   — the classic one
 *
 * Getting that wrong is not a small failure: the function would receive a Node
 * request object where it expects `request.method` to exist, throw on the first
 * property access, and every turn would fail with an opaque 500. The adapter
 * below is short and the alternative is a deploy-time coin flip.
 *
 * `handleRequest` is the real implementation and takes the Web types only, so
 * the tests drive exactly the code that runs.
 */
export default async function handler(
  first: Request | NodeRequest,
  second?: NodeResponse,
): Promise<Response | void> {
  if (isNodePair(first, second)) {
    const response = await handleRequest(await fromNodeRequest(first as NodeRequest))
    await writeNodeResponse(second as NodeResponse, response)
    return
  }
  return handleRequest(first as Request)
}

/**
 * Which calling convention we were given.
 *
 * A Node request has `.headers` as a plain object and a `.socket`; a Web
 * `Request` has a `Headers` instance and no socket. Checking for the response
 * argument as well means a missing second argument can never be mistaken for
 * the Web shape when it is really a Node call that lost its response object.
 */
function isNodePair(
  first: Request | NodeRequest,
  second?: NodeResponse,
): boolean {
  if (!second || typeof (second as NodeResponse).setHeader !== 'function') return false
  return typeof (first as NodeRequest).socket === 'object' && !(first instanceof Request)
}

type NodeRequest = AsyncIterable<Uint8Array> & {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { encrypted?: boolean }
}

type NodeResponse = {
  statusCode: number
  setHeader(name: string, value: string): void
  write(chunk: Uint8Array): boolean
  end(chunk?: Uint8Array | string): void
  on(event: string, listener: () => void): void
}

/**
 * Rebuild a Web `Request` from a Node one.
 *
 * Only the fields the proxy reads are translated, which keeps the surface small:
 * method, URL, headers and a body that is collected into bytes. Collecting it
 * costs nothing here because the app's turns are kilobytes; it is the *response*
 * that must stay streaming, and that is handled below.
 */
async function fromNodeRequest(req: NodeRequest): Promise<Request> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(new Uint8Array(chunk))
  const body = chunks.length ? Buffer.concat(chunks) : undefined

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
  }

  // Node hands over a path, not an origin, so the scheme and host have to be
  // reconstructed. They are only used to parse the path and to build the
  // upstream URL, so the exact host does not matter — but it has to be a valid
  // absolute URL, or `new URL()` throws.
  const proto = req.socket?.encrypted ? 'https' : 'http'
  const host = headers.get('host') ?? 'localhost'

  return new Request(`${proto}://${host}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers,
    body: body as BodyInit | undefined,
  })
}

/**
 * Write a Web `Response` back through a Node response, streaming the body.
 *
 * `res.write` returns false when the socket buffer is full; awaiting 'drain'
 * is what stops a long SSE stream from being read into memory faster than it is
 * delivered, which on a large answer is exactly how a function runs out of
 * memory while appearing to work.
 */
async function writeNodeResponse(res: NodeResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.on('drain', resolve))
      }
    }
  } finally {
    reader.releaseLock()
  }
  res.end()
}

/**
 * The proxy itself.
 *
 * Written against the Web standard `Request`/`Response` pair. Streaming is the
 * reason: the app reads the model's answer as server-sent events and starts
 * speaking before it is finished, and a `Response` with a `ReadableStream` body
 * is passed through untouched. Buffering the SSE stream would turn a
 * conversation into a walkie-talkie.
 */
export async function handleRequest(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY

  // No key configured is a deployment mistake, not a user error, so say which
  // one it is and where the fix lives. This message is safe to show on screen:
  // it names a variable, not a value.
  if (!apiKey) {
    return json(500, {
      type: 'error',
      error: {
        type: 'proxy_not_configured',
        message:
          'ANTHROPIC_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables (Production and Preview), then redeploy.',
      },
    })
  }

  if (!ALLOWED_METHODS.has(request.method)) {
    return json(405, {
      type: 'error',
      error: { type: 'method_not_allowed', message: `${request.method} is not proxied.` },
    })
  }

  // `request.url` on a Vercel function is absolute, and its path is already
  // stripped of the function's own prefix (`/api/anthropic`), so this is
  // `/v1/messages` and friends. The fallback covers being mounted elsewhere.
  const incoming = new URL(request.url)
  const path = incoming.pathname.replace(/^\/api\/anthropic/, '') || '/'

  if (!ALLOWED_PATH.test(path)) {
    return json(404, {
      type: 'error',
      error: { type: 'not_found', message: `${path} is not proxied.` },
    })
  }

  // -- body -----------------------------------------------------------------
  //
  // Read as bytes and forward as bytes. Parsing and re-serialising JSON would
  // work for most requests and quietly break the rest (a `null` field the API
  // distinguishes from absent, a number that loses precision), so the body is
  // moved opaquely.
  let body: ArrayBuffer | undefined
  if (request.method !== 'GET') {
    body = await request.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES) {
      return json(413, {
        type: 'error',
        error: { type: 'request_too_large', message: 'That request is too large to proxy.' },
      })
    }
  }

  // -- headers --------------------------------------------------------------
  const headers = new Headers()
  for (const [name, value] of request.headers) {
    if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value)
  }
  // The key is added here and nowhere else. Setting it last means no inbound
  // header can have taken its place.
  headers.set('x-api-key', apiKey)
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')

  // -- forward --------------------------------------------------------------
  const target = new URL(UPSTREAM + path + incoming.search)

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      // A voice turn that has not started answering in two minutes has failed;
      // MCP tool loops are the slow case and the model's own pause_turn
      // handling covers them.
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Timeouts and DNS failures arrive here. The browser should see a plain
    // sentence it can put on the HUD rather than a stack trace.
    return json(504, {
      type: 'error',
      error: { type: 'upstream_unreachable', message: `Could not reach the API: ${reason}` },
    })
  }

  // -- relay ----------------------------------------------------------------
  //
  // The body is handed over as a stream rather than awaited. This is the whole
  // point for a chat app: `text/event-stream` reaches the browser incrementally,
  // so JARVIS starts speaking on the first sentence instead of the last.
  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out.set(name, value)
  }
  out.set('x-proxied-by', 'jarvis')

  return new Response(upstream.body, { status: upstream.status, headers: out })
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Only these methods and paths are meaningful; this tells Vercel's router not to
 * answer OPTIONS itself (there is no preflight to grant, being same-origin).
 */
export const config = { runtime: 'nodejs' }

/**
 * Kept as a named export for the tests, which drive the same allowlist the
 * handler uses rather than a copy of it. A test that re-implemented these rules
 * would pass while the deployed proxy did something else.
 */
export const _internal = { ALLOWED_PATH, DROP_REQUEST_HEADERS, DROP_RESPONSE_HEADERS, MAX_BODY_BYTES }
