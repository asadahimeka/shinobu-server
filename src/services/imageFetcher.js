/**
 * Server-side image downloader (Task 6).
 *
 * Downloads source images from the pixiv CDN (or a configured proxy) for the
 * translation pipeline. Hardened against the two failure modes pixiv
 * deployments actually hit:
 *
 *   - hotlink protection → pixiv CDN returns 403 unless the request carries a
 *     pixiv Referer and a normal (non-headless) browser UA
 *   - flaky network → bounded retries with exponential backoff, applied ONLY
 *     to transient failures (network / timeout / 5xx). A 4xx is deterministic
 *     (403 hotlink, 404 deleted work) — retrying cannot help, so it fails fast
 *     without burning the backoff budget.
 *
 * Size guarding happens DURING the download: body chunks are accumulated and
 * the running total is checked against MAX_IMAGE_BYTES after every chunk, so
 * an oversized response is aborted early instead of being buffered fully
 * first. Timeouts are split the httpx way — connect 10s (DNS + TCP + TLS +
 * headers) and a 30s read inactivity timeout (gap between chunks, not total).
 *
 * IMAGE_PROXY semantics (mirrors the frontend COMMON_PROXY pattern in
 * src/api/index.js — `COMMON_PROXY + src`, see also googleWeb.js:94 and
 * onnx-worker.js:219): when set, the requested URL is `IMAGE_PROXY + imageUrl`
 * verbatim — i.e. a prefix-style reverse proxy such as
 * `https://proxy.example.com/https://i.pximg.net/123/...`. The proxy prefix is
 * therefore expected to end with the separator (usually `/`). When IMAGE_PROXY
 * is '' (default) the image is fetched directly.
 *
 * Every failure rejects with a structured object, so T10's HTTP layer can
 * translate it straight into an error response without exception sniffing:
 *   { error, message, status?, retryable? }
 *   error     'IMAGE_FETCH_FAILED' | 'IMAGE_TOO_LARGE'
 *   message   human-readable description (Chinese, matches service messages)
 *   status    HTTP status when the failure came from an HTTP response (4xx/5xx)
 *   retryable internal flag consumed by the retry loop (true only for
 *             network / timeout / 5xx). Callers should ignore it.
 *
 * No persistence here — callers (T10) hand the Buffer to the cache module.
 *
 * Smoke test:
 *   node src/services/imageFetcher.js
 */
import { pathToFileURL } from 'node:url'
import config from '../../config.js'

export const MAX_IMAGE_BYTES = config.MAX_IMAGE_BYTES
export const CONNECT_TIMEOUT_MS = 10_000
export const READ_TIMEOUT_MS = 30_000
export const MAX_RETRIES = 3
// One delay per retry: initial → +500ms → +1s → +2s (total 4 attempts max).
export const RETRY_DELAYS = [500, 1000, 2000]

const REFERER = 'https://www.pixiv.net/'
// Normal Chrome UA — must NOT contain "HeadlessChrome" (hibiapi rejects it,
// see AGENTS.md Playwright QA notes).
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Human-readable detail from an unknown error (undici wraps network failures
 * as `TypeError: fetch failed` with the real cause one level down).
 */
function describeError(err) {
  if (!err) return '未知错误'
  return err.cause?.message || err.message || String(err)
}

/**
 * Structured download failure.
 * @param {string} message
 * @param {{error?: string, status?: number, retryable?: boolean}} [opts]
 */
function imageFetchFailed(message, opts = {}) {
  const err = {
    error: opts.error || 'IMAGE_FETCH_FAILED',
    message,
    retryable: opts.retryable === true,
  }
  if (opts.status !== undefined) err.status = opts.status
  return err
}

/**
 * Read one body chunk, aborting the whole request after READ_TIMEOUT_MS of
 * inactivity (httpx-style read timeout: the gap between chunks, not the total
 * transfer time).
 * @param {ReadableStreamDefaultReader} reader
 * @param {AbortController} controller
 * @returns {Promise<{done: boolean, value?: Uint8Array}>}
 */
function readChunk(reader, controller) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error('读取超时'))
    }, READ_TIMEOUT_MS)
    reader.read().then(
      chunk => {
        clearTimeout(timer)
        resolve(chunk)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * One download attempt (no retry logic). Throws structured errors — see the
 * module doc for the shape. `retryable: true` errors are candidates for the
 * retry loop; `retryable: false` (4xx, non-image content-type, too large,
 * empty body) never help from a retry.
 * @param {string} url - effective URL (already proxy-prefixed when configured)
 * @returns {Promise<Buffer>}
 */
async function downloadOnce(url) {
  const controller = new AbortController()

  // Phase 1 — connect: DNS + TCP + TLS + response headers within 10s.
  const connectTimer = setTimeout(() => {
    controller.abort(new Error('连接超时'))
  }, CONNECT_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
      headers: { 'Referer': REFERER, 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: controller.signal,
    })
  } catch (err) {
    throw imageFetchFailed(`请求图片失败: ${describeError(err)}`, { retryable: true })
  } finally {
    clearTimeout(connectTimer)
  }

  // 4xx fails fast (deterministic — retrying a 403/404 cannot succeed);
  // 5xx is transient and gets retried.
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    const retryable = res.status >= 500
    throw imageFetchFailed(
      retryable
        ? `图片下载失败 (HTTP ${res.status} 服务器错误)`
        : `图片下载失败 (HTTP ${res.status})`,
      { status: res.status, retryable }
    )
  }

  // The body must be an image, not an HTML error page or a JSON payload.
  const contentType = (res.headers.get('content-type') || '').toLowerCase()
  if (!contentType.startsWith('image/')) {
    await res.body?.cancel().catch(() => {})
    throw imageFetchFailed(
      `响应不是图片 (Content-Type: ${contentType || '缺失'})`,
      { status: res.status, retryable: false }
    )
  }

  const reader = res.body?.getReader()
  if (!reader) {
    throw imageFetchFailed('响应没有可读的 body', { status: res.status, retryable: false })
  }

  // Phase 2 — read: per-chunk inactivity timeout + streaming size check.
  const chunks = []
  let total = 0
  for (;;) {
    let chunk
    try {
      chunk = await readChunk(reader, controller)
    } catch (err) {
      await reader.cancel().catch(() => {})
      throw imageFetchFailed(`读取图片数据失败: ${describeError(err)}`, { retryable: true })
    }
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {})
      throw imageFetchFailed(
        `图片超过大小限制 (${total} > ${MAX_IMAGE_BYTES} bytes)`,
        { error: 'IMAGE_TOO_LARGE', retryable: false }
      )
    }
    chunks.push(Buffer.from(chunk.value))
  }
  return Buffer.concat(chunks)
}

/**
 * Download a source image as bytes.
 *
 * Retry policy: up to MAX_RETRIES (3) retries with exponential backoff
 * (500ms / 1s / 2s) for transient failures only (network / timeout / 5xx).
 * 4xx, non-image content-type and oversized bodies fail immediately.
 *
 * @param {string} imageUrl - pixiv CDN (or proxy) image URL
 * @returns {Promise<Buffer>} image bytes
 * @throws {{error: string, message: string, status?: number, retryable?: boolean}}
 */
export async function fetchImageBytes(imageUrl) {
  if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
    throw imageFetchFailed('imageUrl 不能为空', { retryable: false })
  }
  // Prefix-style proxy (frontend COMMON_PROXY pattern) — verbatim concatenation.
  const url = config.IMAGE_PROXY ? config.IMAGE_PROXY + imageUrl : imageUrl

  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1])
    try {
      return await downloadOnce(url)
    } catch (err) {
      if (!err || err.retryable !== true) throw err
      lastError = err
    }
  }
  throw lastError
}

// Smoke test when executed directly: `node src/services/imageFetcher.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    `[imageFetcher] IMAGE_PROXY=${config.IMAGE_PROXY || '(none)'} MAX_IMAGE_BYTES=${MAX_IMAGE_BYTES} ` +
      `timeouts=connect:${CONNECT_TIMEOUT_MS}ms/read:${READ_TIMEOUT_MS}ms retries=${MAX_RETRIES} ` +
      `backoff=${RETRY_DELAYS.join('/')}ms`
  )
}
