/**
 * Tests for the server-side Claude proxy in api/anthropic/[...path].ts.
 *
 * These drive the handler directly with a synthetic `Request`, so they need no
 * deployment and no network: the interesting behaviour is which requests get
 * through, which headers survive in both directions, and what the browser sees
 * when the deployment is misconfigured.
 *
 * `npm test` runs with `--import tsx`, and that import is load-bearing rather
 * than convenience. Both CI and the Vercel deploy run Node 20, and Node only
 * learned to strip TypeScript types from modules in 22 — a plain import of a
 * `.ts` module here passed on a dev machine and failed on CI with
 * ERR_INVALID_TYPESCRIPT_SYNTAX. tsx handles the transpile on every supported
 * Node. A `.mts` extension would also have worked, and does not: Vercel's `api`
 * directory does not recognise it, and the deploy fails with "the pattern does
 * not match any Serverless Functions".
 *
 * No test here uses a real key, and none contacts Anthropic: `fetch` is stubbed
 * where a request would go out.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const { default: handler } = await import('../api/anthropic/[...path].ts')

/** What the stub `fetch` was handed, so assertions can look at the relay. */
let seen = null
const realFetch = globalThis.fetch

before(() => {
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init }
    return new Response('event: message_start\ndata: {}\n\n', {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        // Deliberately present: the proxy must strip these two, because it
        // decodes the upstream body before relaying it.
        'content-encoding': 'gzip',
        'content-length': '12345',
      },
    })
  }
})

after(() => {
  globalThis.fetch = realFetch
  delete process.env.ANTHROPIC_API_KEY
})

const withKey = () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key'
}

const post = (path, body = '{}', headers = {}) =>
  new Request(`https://jarvis.example${path}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  })

test('refuses to run without a key, and says where to put one', async () => {
  delete process.env.ANTHROPIC_API_KEY
  const res = await handler(post('/api/anthropic/v1/messages'))
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.error.type, 'proxy_not_configured')
  // The message has to be actionable — this one reaches the HUD.
  assert.match(body.error.message, /ANTHROPIC_API_KEY/)
  assert.match(body.error.message, /Vercel/)
})

test('forwards the messages endpoint and its query string', async () => {
  withKey()
  seen = null
  const res = await handler(post('/api/anthropic/v1/messages?beta=true'))
  assert.equal(res.status, 200)
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages?beta=true')
  assert.equal(seen.init.method, 'POST')
})

test('adds the key from the environment and never from the request', async () => {
  withKey()
  seen = null
  // A caller-supplied key must not survive: that is the whole point of not
  // shipping one to the browser.
  await handler(
    post('/api/anthropic/v1/messages', '{}', {
      'x-api-key': 'sk-ant-attacker',
      authorization: 'Bearer sk-ant-attacker',
    }),
  )
  const sent = new Headers(seen.init.headers)
  assert.equal(sent.get('x-api-key'), 'sk-ant-test-not-a-real-key')
  assert.equal(sent.get('authorization'), null)
})

test('keeps the headers that make the request work', async () => {
  withKey()
  seen = null
  await handler(
    post('/api/anthropic/v1/messages', '{}', {
      'anthropic-beta': 'mcp-client-2025-11-20,fast-mode-2026-02-01',
      'anthropic-version': '2024-01-01',
    }),
  )
  const sent = new Headers(seen.init.headers)
  assert.equal(sent.get('anthropic-beta'), 'mcp-client-2025-11-20,fast-mode-2026-02-01')
  // An explicit version from the caller is respected rather than overwritten.
  assert.equal(sent.get('anthropic-version'), '2024-01-01')
})

test('supplies a version when the caller sent none', async () => {
  withKey()
  seen = null
  await handler(new Request('https://jarvis.example/api/anthropic/v1/models'))
  const sent = new Headers(seen.init.headers)
  assert.equal(sent.get('anthropic-version'), '2023-06-01')
})

test('moves the body through as bytes', async () => {
  withKey()
  seen = null
  const payload = '{"model":"claude-opus-5","messages":[]}'
  await handler(post('/api/anthropic/v1/messages', payload))
  // A Uint8Array, not a string: re-serialising JSON would change the bytes.
  assert.ok(seen.init.body instanceof Uint8Array || seen.init.body instanceof ArrayBuffer)
  assert.equal(new TextDecoder().decode(seen.init.body), payload)
})

test('drops encoding headers that describe the upstream wire format', async () => {
  withKey()
  seen = null
  const res = await handler(post('/api/anthropic/v1/messages'))
  // If these were relayed the browser would try to gunzip plain text, or wait
  // for a length that no longer matches, and the SSE stream would never start.
  assert.equal(res.headers.get('content-encoding'), null)
  assert.equal(res.headers.get('content-length'), null)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
})

test('relays the body as a stream rather than buffering it', async () => {
  withKey()
  const res = await handler(post('/api/anthropic/v1/messages'))
  // The app speaks the model's sentences as they arrive; an awaited string
  // here would make every answer arrive after the last token.
  assert.ok(res.body instanceof ReadableStream)
  assert.equal(await res.text(), 'event: message_start\ndata: {}\n\n')
})

test('proxies only the endpoints the app can reach', async () => {
  withKey()
  const allowed = ['/v1/messages', '/v1/messages/count_tokens', '/v1/models']
  for (const path of allowed) {
    const res = await handler(post(`/api/anthropic${path}`))
    assert.equal(res.status, 200, `${path} should be proxied`)
  }

  // Anything else is refused, so this cannot be used as a general-purpose
  // relay to arbitrary parts of the API.
  for (const path of ['/v1/organizations', '/v1/api_keys', '/admin', '/']) {
    const res = await handler(post(`/api/anthropic${path}`))
    assert.equal(res.status, 404, `${path} should be refused`)
  }
})

test('refuses methods the API does not take here', async () => {
  withKey()
  const res = await handler(
    new Request('https://jarvis.example/api/anthropic/v1/messages', { method: 'PUT', body: '{}' }),
  )
  assert.equal(res.status, 405)
})

test('refuses an oversized body', async () => {
  withKey()
  const res = await handler(post('/api/anthropic/v1/messages', 'x'.repeat(1_000_001)))
  assert.equal(res.status, 413)
})

test('reports an unreachable upstream as a sentence, not a stack trace', async () => {
  withKey()
  const stub = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.anthropic.com')
  }
  try {
    const res = await handler(post('/api/anthropic/v1/messages'))
    assert.equal(res.status, 504)
    const body = await res.json()
    assert.equal(body.error.type, 'upstream_unreachable')
    assert.match(body.error.message, /ENOTFOUND|Could not reach/)
  } finally {
    globalThis.fetch = stub
  }
})

test('grants no cross-origin allowance', async () => {
  withKey()
  seen = null
  const res = await handler(post('/api/anthropic/v1/messages'))
  // Same-origin by construction. An Access-Control-Allow-Origin here would make
  // this an open relay for anyone's Anthropic bill.
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  const sent = new Headers(seen.init.headers)
  assert.equal(sent.get('origin'), null)
})

test('works when Vercel calls it the Node way', async () => {
  // The Web signature is the one above; this covers the other convention, which
  // some runtime versions still use. A wrong guess here fails on the first
  // property access with an opaque 500, so both are exercised.
  withKey()
  seen = null

  const chunks = [Buffer.from('{"model":"claude-opus-5"}')]
  const req = {
    method: 'POST',
    url: '/api/anthropic/v1/messages',
    headers: { host: 'jarvis.example', 'content-type': 'application/json' },
    socket: {},
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }

  const written = []
  const headers = {}
  let status = 0
  const res = {
    statusCode: 0,
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value
    },
    write: (chunk) => {
      written.push(Buffer.from(chunk))
      return true
    },
    end: () => {},
    on: () => {},
  }

  const result = await handler(req, res)
  assert.equal(result, undefined, 'Node-style calls write to res, not return')
  status = res.statusCode
  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'text/event-stream')
  assert.equal(Buffer.concat(written).toString(), 'event: message_start\ndata: {}\n\n')
  // The body arrived at the proxy intact through the Node adapter.
  assert.equal(new TextDecoder().decode(seen.init.body), '{"model":"claude-opus-5"}')
})
