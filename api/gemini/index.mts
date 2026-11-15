/**
 * `POST /api/gemini` — the Gemini chat endpoint.
 *
 * Kept separate from `./chat.mts` for one reason worth writing down: Vercel
 * routes by file, and a route has to have a *default export* the platform can
 * call. `chat.mts` exports a named `handleChat` so it can be imported by the
 * tests without the test file pretending to be a deployment, and this file is
 * the two lines of glue that make it addressable.
 *
 * The handler accepts both calling conventions, for the same reason
 * api/anthropic/[...path].ts does: which one Vercel passes depends on the
 * runtime version rather than on anything declared here, and guessing wrong
 * produces an opaque 500 on every turn.
 */

import { handleChat, type ChatBody } from './chat.mts'

export default async function handler(
  first: Request | NodeRequest,
  second?: NodeResponse,
): Promise<Response | void> {
  if (isNodePair(first, second)) {
    const response = await handleChat(await fromNodeRequest(first as NodeRequest), process.env)
    await writeNodeResponse(second as NodeResponse, response)
    return
  }
  return handleChat(first as Request, process.env)
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

function isNodePair(first: Request | NodeRequest, second?: NodeResponse): boolean {
  if (!second || typeof (second as NodeResponse).setHeader !== 'function') return false
  return typeof (first as NodeRequest).socket === 'object' && !(first instanceof Request)
}

async function fromNodeRequest(req: NodeRequest): Promise<Request> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) chunks.push(new Uint8Array(chunk))
  const body = chunks.length ? Buffer.concat(chunks) : undefined

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
  }

  const proto = req.socket?.encrypted ? 'https' : 'http'
  const host = headers.get('host') ?? 'localhost'
  if (req.method && req.method !== 'POST') {
    return new Request(`${proto}://${host}${req.url ?? '/'}`, { method: req.method, headers })
  }

  return new Request(`${proto}://${host}${req.url ?? '/'}`, {
    method: 'POST',
    headers,
    body: body as BodyInit | undefined,
  })
}

/**
 * Relay the SSE body by hand.
 *
 * Written out rather than shared with the Anthropic function because the two
 * live in different files on purpose — that one proxies bytes it never looks at,
 * this one owns the stream it generates — and a shared helper would have to know
 * about both to be worth sharing.
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
      // `drain` matters here more than usual: this stream is the voice, and
      // reading it into memory faster than it is delivered is how a long answer
      // turns into a silent, failed turn.
      if (!res.write(value)) await new Promise<void>((resolve) => res.on('drain', resolve))
    }
  } finally {
    reader.releaseLock()
  }
  res.end()
}

export type { ChatBody }
