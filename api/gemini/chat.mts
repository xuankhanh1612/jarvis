/**
 * The Gemini path.
 *
 * Google's free tier is a real answer to "I do not want to pay for this", and
 * it needs no billing account: roughly 10-15 requests a minute and ~1,500 a day
 * on the Flash models. Pro was removed from the free tier on 1 April 2026,
 * which is why this defaults to Flash — and Flash is the right shape for a voice
 * assistant regardless, because the latency is the thing you hear.
 *
 * WHAT DOES NOT CARRY OVER
 *
 * Anthropic's API takes `mcp_servers` as a parameter and dials them itself. Its
 * hosted `web_search` is likewise its own. Gemini has neither, so this file does
 * both jobs: it discovers tools from the configured remote MCP servers (see
 * ./mcp.mts), hands them to Gemini as function declarations, and runs the call
 * loop itself until the model stops asking for tools.
 *
 * The consequence worth stating plainly: tool calls here execute *inside this
 * function*, during one request. Anthropic's run over there and can pause and
 * resume a turn (`pause_turn`); this cannot, so a long tool chain is bounded by
 * maxDuration (see vercel.json) rather than continued later.
 *
 * WHY THE RESPONSE IS SSE
 *
 * The browser side (src/lib/gemini.ts) parses the same event-stream shape the
 * Anthropic path produces, so App.tsx and the HUD do not know or care which
 * model is answering. Without streaming, a spoken answer would arrive only after
 * the last token had been generated — a walkie-talkie instead of a conversation.
 */

import { callTool, discoverTools, type McpTool } from './mcp.mts'

/** Google's REST surface. Fixed, for the same reason the Anthropic one is. */
const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta'

/** How many tool round-trips one turn may take before we answer with what we have. */
const MAX_TOOL_ROUNDS = 5

/** A hard ceiling on tool calls per turn, so a confused model cannot spin. */
const MAX_TOOL_CALLS = 12

/** How long any single upstream request may take. */
const REQUEST_TIMEOUT_MS = 60_000

type Env = Record<string, string | undefined>

/** The Gemini wire shapes, only as far as this file touches them. */
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  error?: { message?: string; status?: string }
  promptFeedback?: { blockReason?: string }
}

type Server = { name: string; url: string; token?: string }

/**
 * A turn, as one request from the browser.
 *
 * `history` is the caller's conversation, already in Gemini's shape, so the
 * function does not need to know how the browser stores it.
 */
export type ChatBody = {
  /** The user's words for this turn. */
  prompt: string
  /** Prior turns. Kept last-16 by the caller, same as the Anthropic path. */
  history: GeminiContent[]
  /** The persona. Sent every turn because the free tier has no sessions. */
  system: string
  /** Which MCP servers to offer. Anything not remote HTTP cannot work here. */
  servers: Server[]
  model?: string
}

/**
 * One server-sent event the browser understands.
 *
 * The names are chosen to match what the Anthropic path already emits, so
 * src/lib/gemini.ts is a translator rather than a second implementation of the
 * conversation state machine. `text` is a delta; `tool` is a tool starting.
 */
const event = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const apiKey = env.GEMINI_API_KEY

  if (!apiKey) {
    return json(500, {
      error:
        'GEMINI_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables (Production and Preview), then redeploy. A free key comes from https://aistudio.google.com/apikey and needs no billing account.',
    })
  }

  let body: ChatBody
  try {
    body = (await request.json()) as ChatBody
  } catch {
    return json(400, { error: 'That request was not JSON.' })
  }

  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return json(400, { error: 'No prompt.' })
  }

  // Discovery is sequential rather than parallel on purpose: a first turn
  // against several servers, all handshaking at once, is the shape most likely
  // to hit a cold-start timeout. Tools are cached per function instance, so the
  // cost is paid once.
  const tools: McpTool[] = []
  const failures: string[] = []
  for (const server of body.servers ?? []) {
    if (!server?.url) continue
    const found = await discoverTools(server)
    tools.push(...found.tools)
    if (found.error) failures.push(`${server.name}: ${found.error}`)
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) =>
        controller.enqueue(new TextEncoder().encode(event(payload)))

      try {
        // Tell the browser which tools are live, so the HUD's SYSTEMS rail has
        // something true to show and a broken server is visible rather than
        // silent.
        send({ type: 'servers', servers: [...new Set(tools.map((t) => t.server))] })
        for (const failure of failures) send({ type: 'notice', text: failure })

        await runTurn({ body, apiKey, tools, send, signal: request.signal })
        send({ type: 'done' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // One line the HUD can show and the voice can read. Never the key.
        send({ type: 'error', text: readableUpstreamError(message) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // No buffering anywhere along the way: a proxy that batches this would
      // undo the point of streaming it.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

/** The conversation loop: ask, run any tool calls, ask again. */
async function runTurn(args: {
  body: ChatBody
  apiKey: string
  tools: McpTool[]
  send: (payload: Record<string, unknown>) => void
  signal: AbortSignal
}): Promise<void> {
  const { body, apiKey, tools, send, signal } = args

  let contents: GeminiContent[] = [
    ...(body.history ?? []),
    { role: 'user', parts: [{ text: body.prompt }] },
  ]

  const declarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }))

  let callsMade = 0

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const reply = await ask({
      apiKey,
      model: body.model || 'gemini-3-flash',
      system: body.system,
      contents,
      declarations,
      signal,
    })

    const parts = reply.candidates?.[0]?.content?.parts ?? []
    const said = parts.map((p) => ('text' in p ? p.text : '')).join('')
    if (said) send({ type: 'text', text: said })

    const calls = parts.flatMap((p) => ('functionCall' in p ? [p.functionCall] : []))
    if (calls.length === 0) return

    // The round budget is checked before the calls, not after: a model that
    // keeps asking for tools on the last round should get an answer rather
    // than another round of them.
    if (round === MAX_TOOL_ROUNDS || callsMade + calls.length > MAX_TOOL_CALLS) {
      send({
        type: 'text',
        text: ' That is taking longer than it should, sir. Ask me again.',
      })
      return
    }

    // The model's turn has to be appended before its results, or the next
    // request has a function response with nothing that asked for it and
    // Google rejects the whole thing.
    contents = [...contents, { role: 'model', parts }]

    const responses: GeminiPart[] = []
    for (const call of calls) {
      callsMade++
      const tool = tools.find((t) => t.name === call.name)
      send({ type: 'tool', name: humanToolName(call.name) })

      if (!tool) {
        // A hallucinated tool name. Telling the model it does not exist is
        // cheaper and more honest than pretending it ran.
        responses.push({
          functionResponse: {
            name: call.name,
            response: { error: `No tool named ${call.name} is connected.` },
          },
        })
        continue
      }

      const server = body.servers.find((s) => s.name === tool.server)
      if (!server) {
        responses.push({
          functionResponse: { name: call.name, response: { error: 'That server is not configured.' } },
        })
        continue
      }

      // Strip the namespace before calling: the server knows the tool by its
      // own name, not the one we prefixed it with.
      const bare = call.name.slice(tool.server.length + 2)
      const result = await callTool(server, bare, call.args ?? {})
      responses.push({
        functionResponse: {
          name: call.name,
          // `content` is the key Google's documented shape uses for a tool
          // result; `error` is honoured as a hint for the model to retry
          // differently.
          response: result.isError
            ? { error: result.text }
            : { content: result.text.slice(0, 20_000) },
        },
      })
    }

    contents = [...contents, { role: 'user', parts: responses }]
  }
}

/**
 * One call to Gemini.
 *
 * Hand-rolled rather than using @google/genai, for the same reason the OpenAI
 * SDK is not here: this is three fields and a fetch, and a dependency in a
 * serverless function is cold-start time on every scale-to-zero.
 */
async function ask(args: {
  apiKey: string
  model: string
  system: string
  contents: GeminiContent[]
  declarations: Array<Record<string, unknown>>
  signal: AbortSignal
}): Promise<GeminiResponse> {
  const { apiKey, model, system, contents, declarations, signal } = args

  const payload: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      // A spoken answer is a few sentences. Capping here keeps the model from
      // writing an essay that costs a minute of silence to read out.
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
  }

  if (declarations.length) {
    payload.tools = [{ functionDeclarations: declarations }]
  }

  const response = await fetch(
    `${UPSTREAM}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header rather than ?key=, so the key cannot end up in a log line that
        // records URLs.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    },
  )

  const text = await response.text()
  let parsed: GeminiResponse
  try {
    parsed = JSON.parse(text) as GeminiResponse
  } catch {
    throw new Error(`Gemini answered ${response.status} with something that was not JSON.`)
  }

  if (!response.ok || parsed.error) {
    const message = parsed.error?.message ?? `HTTP ${response.status}`
    throw new Error(message)
  }

  if (parsed.promptFeedback?.blockReason) {
    throw new Error(`The request was blocked (${parsed.promptFeedback.blockReason}).`)
  }

  return parsed
}

/**
 * `notion__search` reads as `notion search` on the HUD, which is what a person
 * would say out loud and what the filler lines are keyed to.
 */
function humanToolName(namespaced: string): string {
  return namespaced.replace('__', ' ').replace(/_/g, ' ')
}

/**
 * Turn Google's error strings into sentences that name the fix.
 *
 * The three that actually happen on a free tier are a bad key, a quota, and a
 * model name that does not exist in the region — and the raw forms of all three
 * are unhelpful on a HUD.
 */
function readableUpstreamError(message: string): string {
  if (/API key not valid|API_KEY_INVALID|permission/i.test(message)) {
    return 'The Gemini key was refused. Check GEMINI_API_KEY in the deployment settings.'
  }
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(message)) {
    return 'The free Gemini quota is used up for today. It resets at midnight Pacific time.'
  }
  if (/not found|NOT_FOUND|404/i.test(message)) {
    return 'That Gemini model is not available on this key. Try VITE_GEMINI_MODEL=gemini-3-flash.'
  }
  return message
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
