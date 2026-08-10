/**
 * Stub translateService used before T10's real service lands (Task 5).
 *
 * Implements the same DI contract as the real translateService:
 *   translateByUrl(imageUrl, userOptions) → Promise<TranslateResult>
 *   resolves { pngBuffer, noText, regions, durationMs, cacheHit }
 *   rejects  { error, message, retryAfter?, detail? }  (Error with .error)
 *
 * QA knobs (read from `imageUrl` — the stub never fetches the URL):
 *   - 'notext'         → noText:true (returns the "original" image)
 *   - 'slow'           → ~800ms delay (exercises the serial queue / BUSY)
 *   - 'cache-hit'      → cacheHit:true (X-Translate-Cache: hit)
 *   - 'too-large'      → rejects IMAGE_TOO_LARGE (413)
 *   - 'fetch-fail'     → rejects IMAGE_FETCH_FAILED (502)
 *   - 'rate-limited'   → rejects LLM_RATE_LIMITED (429 + Retry-After)
 *   - 'pipeline-fail'  → rejects PIPELINE_FAILED (500)
 *   - 'boom'           → throws a plain Error (500 INTERNAL fallback)
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * Reject with an Error that carries the structured code the HTTP layer maps.
 * (no-throw-literal: never throw a bare object in this repo.)
 * @param {string} error - structured error code (ERROR_STATUS key)
 * @param {string} message
 * @param {Object} [extra] - e.g. { retryAfter }
 * @returns {Error}
 */
function stubError(error, message, extra) {
  const err = new Error(message)
  err.error = error
  if (extra) Object.assign(err, extra)
  return err
}

/**
 * Build the stub translate service.
 * @returns {{translateByUrl: (imageUrl: string, userOptions: Object) => Promise<Object>}}
 */
export function createStubTranslateService() {
  return {
    async translateByUrl(imageUrl) {
      const url = imageUrl || ''
      if (url.includes('slow')) {
        await new Promise(resolve => setTimeout(resolve, 800))
      }
      if (url.includes('too-large')) {
        throw stubError('IMAGE_TOO_LARGE', '图片超过大小限制（stub）')
      }
      if (url.includes('fetch-fail')) {
        throw stubError('IMAGE_FETCH_FAILED', '图片下载失败（stub）')
      }
      if (url.includes('rate-limited')) {
        throw stubError('LLM_RATE_LIMITED', 'LLM 请求被限流（stub）', { retryAfter: 30 })
      }
      if (url.includes('pipeline-fail')) {
        throw stubError('PIPELINE_FAILED', '管线运行失败（stub）')
      }
      if (url.includes('boom')) {
        throw new Error('unexpected stub failure')
      }
      const noText = url.includes('notext')
      return {
        pngBuffer: TINY_PNG,
        noText,
        regions: noText ? 0 : 3,
        durationMs: 42,
        cacheHit: url.includes('cache-hit'),
      }
    },
  }
}
