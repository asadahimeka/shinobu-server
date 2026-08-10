/**
 * imageFetcher unit tests (Task 16).
 *
 * All network I/O is mocked: `global.fetch` is swapped for a stub returning
 * undici `Response` objects with controlled status/headers/body. No real
 * network, no proxies, no downloads.
 *
 * Knobs are set in env BEFORE the dynamic import so config.js + imageFetcher.js
 * pick them up at module load (the hermetic env-before-import pattern from
 * cache.test.js): MAX_IMAGE_BYTES=64 makes the size-limit case cheap to hit.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.MAX_IMAGE_BYTES = '64'
process.env.IMAGE_PROXY = ''

const { fetchImageBytes, MAX_IMAGE_BYTES } = await import('../src/services/imageFetcher.js')

const originalFetch = globalThis.fetch

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

function pngResponse(extra = {}) {
  return new Response(PNG, { headers: { 'Content-Type': 'image/png' }, ...extra })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('sends pixiv Referer + normal browser UA (no HeadlessChrome)', async () => {
  let captured = null
  globalThis.fetch = async (url, init) => {
    captured = { url, init }
    return pngResponse()
  }

  const buf = await fetchImageBytes('https://i.pximg.net/123/img.png')
  assert.deepEqual(buf, PNG)
  assert.equal(captured.url, 'https://i.pximg.net/123/img.png')
  assert.equal(captured.init.headers.Referer, 'https://www.pixiv.net/')
  assert.match(captured.init.headers['User-Agent'], /^Mozilla\/5\.0/)
  assert.ok(!captured.init.headers['User-Agent'].includes('HeadlessChrome'))
})

test('503 → retried then succeeds (bounded backoff, 2 total attempts)', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return new Response('server error', { status: 503 })
    return pngResponse()
  }

  const buf = await fetchImageBytes('https://example.com/img.png')
  assert.deepEqual(buf, PNG)
  assert.equal(calls, 2, 'exactly one retry after the 503')
})

test('404 → immediate IMAGE_FETCH_FAILED, no retry', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('not found', { status: 404 })
  }

  await assert.rejects(
    fetchImageBytes('https://example.com/missing.png'),
    err =>
      err.error === 'IMAGE_FETCH_FAILED' &&
      err.status === 404 &&
      err.retryable === false &&
      /HTTP 404/.test(err.message)
  )
  assert.equal(calls, 1, '4xx must fail fast without burning the retry budget')
})

test('oversized body → IMAGE_TOO_LARGE (streaming size guard)', async () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES + 100)
  globalThis.fetch = async () => new Response(big, { headers: { 'Content-Type': 'image/png' } })

  await assert.rejects(
    fetchImageBytes('https://example.com/big.png'),
    err => err.error === 'IMAGE_TOO_LARGE' && err.retryable === false
  )
})

test('non-image Content-Type → IMAGE_FETCH_FAILED', async () => {
  globalThis.fetch = async () =>
    new Response('<html>error page</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })

  await assert.rejects(
    fetchImageBytes('https://example.com/error.html'),
    err =>
      err.error === 'IMAGE_FETCH_FAILED' &&
      err.retryable === false &&
      /不是图片/.test(err.message)
  )
})

test('empty imageUrl → IMAGE_FETCH_FAILED without touching fetch', async () => {
  let called = false
  globalThis.fetch = async () => {
    called = true
    return pngResponse()
  }

  await assert.rejects(
    fetchImageBytes('   '),
    err => err.error === 'IMAGE_FETCH_FAILED' && err.retryable === false
  )
  assert.equal(called, false, 'no network attempt for an empty URL')
})
