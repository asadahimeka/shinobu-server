/**
 * HTTP layer unit tests (Task 16).
 *
 * Runs the real express app on an ephemeral port with a STUB translateService
 * (createStubTranslateService — URL-knob driven, no network/LLM). TOKEN is set
 * in env before the dynamic import so auth.js picks up `test-secret-42`.
 * Requests go through built-in fetch against `http://127.0.0.1:<port>`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

process.env.TOKEN = 'test-secret-42'

const { createApp } = await import('../src/http/app.js')
const { createStubTranslateService } = await import('../src/http/stubTranslateService.js')

const TOKEN = 'test-secret-42'
let server
let base

before(async () => {
  const app = createApp({ translateService: createStubTranslateService() })
  server = app.listen(0)
  await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
})

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra }
}

async function postTranslate(body, headers) {
  return fetch(`${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('/health without token → 401 UNAUTHORIZED', async () => {
  const res = await fetch(`${base}/health`)
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'UNAUTHORIZED')
})

test('/health with wrong token → 401', async () => {
  const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer wrong-token' } })
  assert.equal(res.status, 401)
})

test('/health with correct token → 200 {status, models}', async () => {
  const res = await fetch(`${base}/health`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.deepEqual(Object.keys(body.models).sort(), ['bubble', 'detector', 'inpaint', 'ocr'])
  for (const v of Object.values(body.models)) {
    assert.ok(v === 'loaded' || v === 'missing')
  }
})

test('POST /translate missing imageUrl → 400 BAD_REQUEST', async () => {
  const res = await postTranslate({}, authHeaders())
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'BAD_REQUEST')
})

test('POST /translate stub success → 200 PNG + X-Translate-* headers', async () => {
  const res = await postTranslate({ imageUrl: 'https://example.com/img.png' }, authHeaders())
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /image\/png/)
  assert.equal(res.headers.get('x-translate-duration'), '42')
  assert.equal(res.headers.get('x-translate-regions'), '3')
  assert.equal(res.headers.get('x-translate-cache'), 'miss')
  const buf = Buffer.from(await res.arrayBuffer())
  assert.ok(buf.length > 0)
})

test('POST /translate noText knob → X-Translate-NoText: 1', async () => {
  const res = await postTranslate({ imageUrl: 'https://example.com/notext.png' }, authHeaders())
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-translate-notext'), '1')
  assert.equal(res.headers.get('x-translate-regions'), '0')
})

test('POST /translate LLM_RATE_LIMITED → 429 + Retry-After', async () => {
  const res = await postTranslate({ imageUrl: 'https://example.com/rate-limited.png' }, authHeaders())
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '30')
  assert.equal((await res.json()).error, 'LLM_RATE_LIMITED')
})

test('POST /translate IMAGE_FETCH_FAILED → 502', async () => {
  const res = await postTranslate({ imageUrl: 'https://example.com/fetch-fail.png' }, authHeaders())
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error, 'IMAGE_FETCH_FAILED')
})
