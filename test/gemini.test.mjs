/**
 * Tests for the Gemini path: the MCP client in api/gemini/mcp.ts and the chat
 * adapter in api/gemini/chat.ts.
 *
 * Everything here runs against a stubbed `fetch`, so no MCP server and no Google
 * endpoint is contacted and no key is needed. What is worth testing is the part
 * that is easy to get subtly wrong and impossible to see from the outside: the
 * JSON-RPC handshake, the namespacing of tool names, the ordering of the model's
 * turn before its tool results, and whether a broken server takes the whole
 * answer down with it.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const mcp = await import('../api/gemini/mcp.ts')
const { handleChat } = await import('../api/gemini/chat.ts')
const { default: endpoint } = await import('../api/gemini/index.ts')

const realFetch = globalThis.fetch

/** Every outbound request, so assertions can look at what was actually sent. */
let calls = []

/**
 * A stand-in for one MCP server plus the Gemini endpoint, dispatched by URL.
 *
 * `mode` lets a test decide whether the server answers in JSON or as an SSE
 * stream, because the spec allows both for the same request and only one of them
 * tends to be what a developer wrote their parser against.
 */
function stubFetch({ mode = 'json', tools = [], toolResult = 'ok', geminiParts = [], geminiError = null } = {}) {
  calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: target, body, headers: new Headers(init?.headers) })

    if (target.includes('generativelanguage.googleapis.com')) {
      // An error body, when a test wants the round trip to fail rather than
      // answer. Google returns 401/429 as JSON, so this is the shape that
      // actually reaches the client and gets classified.
      if (geminiError) return jsonResponse({ error: geminiError }, 401)
      // A queue of model replies: one per round of the tool loop.
      const reply = geminiParts.shift() ?? { parts: [{ text: 'done' }] }
      return jsonResponse({ candidates: [{ content: { parts: reply.parts } }] })
    }

    if (target.includes('mcp.example')) {
      const reply = (result) => {
        const payload = { jsonrpc: '2.0', id: body?.id, result }
        return mode === 'sse' ? sseResponse(payload) : jsonResponse(payload)
      }
      if (body?.method === 'initialize') {
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
      }
      if (body?.method === 'notifications/initialized') {
        return new Response(null, { status: 202, headers: { 'mcp-session-id': 'sess-1' } })
      }
      if (body?.method === 'tools/list') return reply({ tools })
      if (body?.method === 'tools/call') return reply({ content: [{ type: 'text', text: toolResult }] })
    }

    throw new Error(`unexpected request to ${target}`)
  }
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

const sseResponse = (payload) =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

before(() => stubFetch())
after(() => {
  globalThis.fetch = realFetch
})
beforeEach(() => mcp._resetSessions())

/* ------------------------------------------------------------------ mcp.mts */

test('discovers tools, namespaces them, and keeps the schema', async () => {
  stubFetch({
    tools: [
      {
        name: 'search',
        description: 'Search notes',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
      { name: 'no_schema', description: 'No schema' },
    ],
  })

  const { tools, error } = await mcp.discoverTools({ name: 'notion', url: 'https://mcp.example/rpc' })
  assert.equal(error, undefined)
  assert.equal(tools.length, 2)
  // Namespaced: two servers may both have a `search`, and one must not shadow
  // the other in the model's view.
  assert.equal(tools[0].name, 'notion__search')
  assert.equal(tools[0].description, 'Search notes')
  assert.deepEqual(tools[0].inputSchema, { type: 'object', properties: { q: { type: 'string' } } })
  assert.equal(tools[0].server, 'notion')
  // A tool with no schema still gets one: Gemini rejects a declaration without
  // a parameters object.
  assert.deepEqual(tools[1].inputSchema, { type: 'object', properties: {} })
})

test('sends the handshake in the order the spec requires', async () => {
  stubFetch({ tools: [] })
  await mcp.discoverTools({ name: 'notion', url: 'https://mcp.example/rpc' })

  const methods = calls.map((c) => c.body?.method).filter(Boolean)
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list'])
})

test('reads an SSE reply as readily as a JSON one', async () => {
  // The same request may be answered either way; a client that only parses JSON
  // works against one server and mysteriously fails against another.
  stubFetch({ mode: 'sse', tools: [{ name: 'search', description: 'x' }] })
  const { tools, error } = await mcp.discoverTools({ name: 'notion', url: 'https://mcp.example/rpc' })
  assert.equal(error, undefined)
  assert.equal(tools[0].name, 'notion__search')
})

test('carries the bearer token and the negotiated session id', async () => {
  stubFetch({ tools: [] })
  await mcp.discoverTools({ name: 'notion', url: 'https://mcp.example/rpc', token: 'tok-123' })

  const first = calls[0].headers
  assert.equal(first.get('authorization'), 'Bearer tok-123')
  assert.equal(first.get('mcp-protocol-version'), '2025-06-18')
  assert.ok(first.get('accept')?.includes('text/event-stream'))

  // The session id arrives on the initialize reply and must be echoed after,
  // or servers that require it answer 400 to everything that follows.
  const later = calls[calls.length - 1].headers
  assert.equal(later.get('mcp-session-id'), 'sess-1')
})

test('reports a broken server instead of throwing past the caller', async () => {
  globalThis.fetch = async () => jsonResponse({ error: { message: 'bad gateway' } }, 502)
  const { tools, error } = await mcp.discoverTools({ name: 'notion', url: 'https://mcp.example/rpc' })
  assert.deepEqual(tools, [])
  // One dead server must not cost the whole answer — the caller reports it in a
  // line and carries on with whatever else connected.
  assert.match(error, /502|bad gateway/)
})

test('flattens a tool result to text and flags a tool error', async () => {
  stubFetch({ toolResult: 'three notes found' })
  const ok = await mcp.callTool({ name: 'notion', url: 'https://mcp.example/rpc' }, 'search', { q: 'x' })
  assert.deepEqual(ok, { text: 'three notes found', isError: false })

  globalThis.fetch = async () =>
    jsonResponse({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'nope' }], isError: true } })
  const bad = await mcp.callTool({ name: 'notion', url: 'https://mcp.example/rpc' }, 'search', {})
  assert.equal(bad.isError, true)
})

/* ----------------------------------------------------------------- chat.mts */

const body = (over = {}) => ({
  prompt: 'what is on my calendar',
  history: [],
  system: 'You are JARVIS.',
  servers: [{ name: 'notion', url: 'https://mcp.example/rpc' }],
  ...over,
})

const readEvents = async (response) => {
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')))
}

test('refuses to run without a key, and says where a free one comes from', async () => {
  stubFetch()
  const response = await handleChat(jsonRequest(body()), {})
  assert.equal(response.status, 500)
  const payload = await response.json()
  assert.match(payload.error, /GEMINI_API_KEY/)
  assert.match(payload.error, /aistudio\.google\.com/)
})

test('streams text, announces tools, and sends the key in a header', async () => {
  stubFetch({
    tools: [{ name: 'search', description: 'Search' }],
    toolResult: 'two events',
    geminiParts: [
      { parts: [{ functionCall: { name: 'notion__search', args: { q: 'calendar' } } }] },
      { parts: [{ text: 'Two things today, sir.' }] },
    ],
  })

  const response = await handleChat(jsonRequest(body()), { GEMINI_API_KEY: 'g-key' })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)

  const events = await readEvents(response)
  assert.deepEqual(events.find((e) => e.type === 'servers').servers, ['notion'])
  assert.equal(events.find((e) => e.type === 'tool').name, 'notion search')
  assert.equal(events.find((e) => e.type === 'text').text, 'Two things today, sir.')
  assert.equal(events.at(-1).type, 'done')

  // The key travels in a header, never in the URL: a URL ends up in logs.
  const google = calls.find((c) => c.url.includes('generativelanguage'))
  assert.equal(google.headers.get('x-goog-api-key'), 'g-key')
  assert.ok(!google.url.includes('g-key'))
})

test('sends the model turn before its tool results', async () => {
  // Google rejects a function response with nothing that asked for it, so this
  // ordering is load-bearing rather than tidy.
  stubFetch({
    tools: [{ name: 'search', description: 'Search' }],
    geminiParts: [
      { parts: [{ functionCall: { name: 'notion__search', args: {} } }] },
      { parts: [{ text: 'ok' }] },
    ],
  })

  // The body must be read: handleChat hands back a lazy stream, so the turn —
  // and every fetch inside it — only runs as the response is consumed. A test
  // that awaits the Response and stops there is testing nothing.
  await (await handleChat(jsonRequest(body()), { GEMINI_API_KEY: 'g-key' })).text()
  const second = calls.filter((c) => c.url.includes('generativelanguage'))[1]
  const contents = second.body.contents
  const modelIndex = contents.findIndex((c) => c.role === 'model')
  const resultIndex = contents.findIndex((c) => c.parts?.some((p) => p.functionResponse))
  assert.ok(modelIndex !== -1 && resultIndex !== -1)
  assert.ok(modelIndex < resultIndex, 'the model turn must precede the function response')

  // And the namespace is stripped on the way to the server: it knows the tool
  // by its own name.
  const server = calls.find((c) => c.body?.method === 'tools/call')
  assert.equal(server.body.params.name, 'search')
})

test('declares the tools to Gemini with their schemas', async () => {
  stubFetch({
    tools: [{ name: 'search', description: 'Search notes', inputSchema: { type: 'object', properties: {} } }],
    geminiParts: [{ parts: [{ text: 'hi' }] }],
  })
  await (await handleChat(jsonRequest(body()), { GEMINI_API_KEY: 'g-key' })).text()

  const first = calls.find((c) => c.url.includes('generativelanguage'))
  const declared = first.body.tools[0].functionDeclarations
  assert.equal(declared[0].name, 'notion__search')
  assert.equal(declared[0].description, 'Search notes')
  assert.deepEqual(declared[0].parameters, { type: 'object', properties: {} })
})

test('answers a hallucinated tool name without crashing the turn', async () => {
  stubFetch({
    tools: [],
    geminiParts: [
      { parts: [{ functionCall: { name: 'notion__invented', args: {} } }] },
      { parts: [{ text: 'I could not do that, sir.' }] },
    ],
  })
  const events = await readEvents(await handleChat(jsonRequest(body()), { GEMINI_API_KEY: 'g-key' }))
  assert.equal(events.find((e) => e.type === 'text').text, 'I could not do that, sir.')

  // The model is told the tool does not exist rather than being left to guess.
  const second = calls.filter((c) => c.url.includes('generativelanguage'))[1]
  const response = second.body.contents.at(-1).parts[0].functionResponse
  assert.match(response.response.error, /No tool named/)
})

test('turns a quota error into a sentence about midnight Pacific', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ error: { message: 'RESOURCE_EXHAUSTED: quota exceeded' } }, 429)
  const events = await readEvents(
    await handleChat(jsonRequest(body({ servers: [] })), { GEMINI_API_KEY: 'g-key' }),
  )
  const error = events.find((e) => e.type === 'error')
  assert.match(error.text, /quota/i)
  assert.match(error.text, /midnight Pacific/)
})

test('rejects a request that is not JSON, and one with no prompt', async () => {
  stubFetch()
  const bad = await handleChat(
    new Request('https://jarvis.example/api/gemini', { method: 'POST', body: 'not json' }),
    { GEMINI_API_KEY: 'k' },
  )
  assert.equal(bad.status, 400)

  const empty = await handleChat(jsonRequest(body({ prompt: '  ' })), { GEMINI_API_KEY: 'k' })
  assert.equal(empty.status, 400)
})

/* ----------------------------------------------------------------- index.mts */

test('is addressable the way Vercel calls it, both ways', async () => {
  stubFetch({ geminiParts: [{ parts: [{ text: 'sir' }] }] })

  // The endpoint reads the key from process.env rather than taking it as an
  // argument — that is what a real deployment has — so the test has to provide
  // it there for both conventions.
  process.env.GEMINI_API_KEY = 'g-key'
  try {
    // Web signature.
    const web = await endpoint(jsonRequest(body({ servers: [] })))
    assert.equal(web.status, 200)
    await web.text()
  } finally {
    delete process.env.GEMINI_API_KEY
  }

  // Classic Node signature: the same turn must work, writing to res.
  const written = []
  const headers = {}
  const res = {
    statusCode: 0,
    setHeader: (k, v) => {
      headers[k.toLowerCase()] = v
    },
    write: (chunk) => {
      written.push(Buffer.from(chunk))
      return true
    },
    end: () => {},
    on: () => {},
  }
  const req = {
    method: 'POST',
    url: '/api/gemini',
    headers: { host: 'jarvis.example', 'content-type': 'application/json' },
    socket: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body({ servers: [] })))
    },
  }

  process.env.GEMINI_API_KEY = 'g-key'
  try {
    const result = await endpoint(req, res)
    assert.equal(result, undefined, 'a Node-style call writes to res')
    assert.equal(res.statusCode, 200)
    assert.match(Buffer.concat(written).toString(), /"type":"text"/)
  } finally {
    delete process.env.GEMINI_API_KEY
  }
})

const jsonRequest = (payload) =>
  new Request('https://jarvis.example/api/gemini', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

/* ------------------------------------------------------- unusable key formats */

test('names the AQ. key problem instead of reporting an invalid key', async () => {
  // AI Studio started issuing AQ.Ab8RN6… keys, and the Gemini API rejects them
  // with a 401 ACCESS_TOKEN_TYPE_UNSUPPORTED no matter how they are sent. Calling
  // that "invalid key" sends the user round a loop of regenerating the same
  // unusable thing, so it gets its own sentence.
  stubFetch()
  globalThis.fetch = async () =>
    jsonResponse({
      error: { message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' },
    })

  const events = await readEvents(
    await handleChat(jsonRequest(body({ servers: [] })), { GEMINI_API_KEY: 'AQ.Ab8RN6test' }),
  )
  const error = events.find((e) => e.type === 'error')
  assert.match(error.text, /AQ\./)
  assert.match(error.text, /AIza/)
  assert.match(error.text, /ACCESS_TOKEN_TYPE_UNSUPPORTED/)
})

test('warns about an AQ. key before the request goes out', async () => {
  stubFetch({ geminiParts: [{ parts: [{ text: 'hi' }] }] })
  const events = await readEvents(
    await handleChat(jsonRequest(body({ servers: [] })), { GEMINI_API_KEY: 'AQ.Ab8RN6test' }),
  )
  const notice = events.find((e) => e.type === 'notice')
  assert.ok(notice, 'a notice should arrive up front')
  assert.match(notice.text, /AIza/)
})

test('says nothing about a key format it does not recognise', async () => {
  stubFetch({ geminiParts: [{ parts: [{ text: 'hi' }] }] })
  const events = await readEvents(
    await handleChat(jsonRequest(body({ servers: [] })), { GEMINI_API_KEY: 'AIzaSyTest' }),
  )
  assert.equal(events.find((e) => e.type === 'notice'), undefined)
})

/* ------------------------------------------------- notices are not failures */

test('a notice and an error are separate events, not one overwriting the other', async () => {
  // The reason this matters is concrete: a valid-looking but unusable AQ. key
  // produces a notice up front, and then the turn fails with an error. If the
  // client funnelled both into the same handler the HUD had one line, and the
  // note explaining the failure was what got overwritten by it.
  stubFetch({
    geminiError: { message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' },
  })

  const events = await readEvents(
    await handleChat(jsonRequest(body({ servers: [] })), { GEMINI_API_KEY: 'AQ.Ab8RN6test' }),
  )

  const notices = events.filter((e) => e.type === 'notice')
  const errors = events.filter((e) => e.type === 'error')

  assert.equal(notices.length, 1, 'exactly one notice, before the failure')
  assert.equal(errors.length, 1)
  // The notice is emitted first, which is what lets the UI keep it visible while
  // the error is what gets spoken.
  assert.ok(events.indexOf(notices[0]) < events.indexOf(errors[0]))
  assert.notEqual(notices[0].text, errors[0].text)
})
