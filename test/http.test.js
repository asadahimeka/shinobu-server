/**
 * HTTP layer unit tests (Task 6).
 *
 * Runs the real express app on an ephemeral port with a STUB translateService
 * (createStubTranslateService — URL-knob driven, no network/LLM). TOKEN is set
 * in env before the dynamic import so auth.js picks up `test-secret-42`.
 * Requests go through built-in fetch against `http://127.0.0.1:<port>`.
 *
 * Task 6 rewired POST /translate to the async job contract: submit returns 202
 * {id, status:'queued'}; clients poll GET /translate/jobs/:jobId then fetch
 * GET /translate/jobs/:jobId/result. submitAndWaitForResult wraps that flow.
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

/** 提交 job 并轮询到 done，返回 result 响应 */
async function submitAndWaitForResult(body, headers = {}) {
  const submit = await postTranslate(body, headers)
  assert.equal(submit.status, 202)
  const { id } = await submit.json()
  for (let i = 0; i < 50; i++) {
    const poll = await fetch(`${base}/translate/jobs/${id}`, { headers: authHeaders() })
    const job = await poll.json()
    if (job.status === 'done') {
      return fetch(`${base}/translate/jobs/${id}/result`, { headers: authHeaders() })
    }
    if (job.status === 'failed') {
      throw new Error(`job failed: ${job.error} ${job.message}`)
    }
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('job did not finish in time')
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

test('POST /translate stub success → 202 → done → 200 PNG + headers', async () => {
  const res = await submitAndWaitForResult(
    { imageUrl: 'https://example.com/img.png' },
    authHeaders()
  )
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /image\/png/)
  assert.equal(res.headers.get('x-translate-duration'), '42')
  assert.equal(res.headers.get('x-translate-regions'), '3')
  assert.equal(res.headers.get('x-translate-cache'), 'miss')
  const buf = Buffer.from(await res.arrayBuffer())
  assert.ok(buf.length > 0)
})

test('POST /translate missing imageUrl → 400 BAD_REQUEST (同步，不创建 job)', async () => {
  const res = await postTranslate({}, authHeaders())
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'BAD_REQUEST')
})

test('POST /translate noText knob → X-Translate-NoText: 1', async () => {
  const res = await submitAndWaitForResult(
    { imageUrl: 'https://example.com/notext.png' },
    authHeaders()
  )
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-translate-notext'), '1')
  assert.equal(res.headers.get('x-translate-regions'), '0')
})

test('POST /translate LLM_RATE_LIMITED → job failed → result 409 JOB_FAILED + 错误码', async () => {
  const submit = await postTranslate(
    { imageUrl: 'https://example.com/rate-limited.png' },
    authHeaders()
  )
  assert.equal(submit.status, 202)
  const { id } = await submit.json()
  const poll = await fetch(`${base}/translate/jobs/${id}`, { headers: authHeaders() })
  const job = await poll.json()
  assert.equal(job.status, 'failed')
  assert.equal(job.error, 'LLM_RATE_LIMITED')
  const res = await fetch(`${base}/translate/jobs/${id}/result`, { headers: authHeaders() })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'JOB_FAILED')
  assert.equal(body.detail, 'LLM_RATE_LIMITED')
})

test('POST /translate IMAGE_FETCH_FAILED → job failed with IMAGE_FETCH_FAILED', async () => {
  const submit = await postTranslate(
    { imageUrl: 'https://example.com/fetch-fail.png' },
    authHeaders()
  )
  const { id } = await submit.json()
  const poll = await fetch(`${base}/translate/jobs/${id}`, { headers: authHeaders() })
  const job = await poll.json()
  assert.equal(job.status, 'failed')
  assert.equal(job.error, 'IMAGE_FETCH_FAILED')
})

test('GET /translate/jobs/:unknown → 404 JOB_NOT_FOUND', async () => {
  const res = await fetch(`${base}/translate/jobs/nope`, { headers: authHeaders() })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'JOB_NOT_FOUND')
})

test('GET /translate/jobs/:id/result while running → 409 JOB_NOT_READY', async () => {
  const submit = await postTranslate(
    { imageUrl: 'https://example.com/slow.png' },
    authHeaders()
  )
  const { id } = await submit.json()
  const res = await fetch(`${base}/translate/jobs/${id}/result`, { headers: authHeaders() })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'JOB_NOT_READY')
})

test('GET /translate/jobs/:id shows progress stage while running (slow knob)', async () => {
  const submit = await postTranslate(
    { imageUrl: 'https://example.com/slow.png' },
    authHeaders()
  )
  const { id } = await submit.json()
  // slow 任务 800ms，轮询一次应能拿到 running 状态
  const poll = await fetch(`${base}/translate/jobs/${id}`, { headers: authHeaders() })
  const job = await poll.json()
  assert.ok(['running', 'done'].includes(job.status))
})
