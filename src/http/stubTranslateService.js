/**
 * Stub translateService used before T10's real service lands (Task 5).
 *
 * 异步化改造后（Task 6）暴露新契约：
 *   submitTranslate(imageUrl, options) → Promise<{id}>
 *   getTranslateJob(id)                → Promise<Job|null>
 *   getTranslateJobResult(id)          → Promise<Buffer|null>
 * 同时保留 translateByUrl（旧同步契约）供兼容。
 *
 * QA knobs（读 imageUrl）：notext / slow / cache-hit / too-large /
 * fetch-fail / rate-limited / pipeline-fail / boom — 语义同旧版。
 */
import crypto from 'node:crypto'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/** 内部同步执行体（原 translateByUrl 函数体） */
async function stubTranslateByUrl(imageUrl, _options = {}, onProgress) {
  const url = imageUrl || ''
  if (url.includes('slow')) {
    onProgress?.({ stage: 'load', percent: 5 })
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
}

function stubError(error, message, extra) {
  const err = new Error(message)
  err.error = error
  if (extra) Object.assign(err, extra)
  return err
}

/** @type {Map<string, {id: string, status: string, resultMeta?: Object, error?: string, message?: string}>} */
const stubJobs = new Map()

/** 已完成的 PNG 缓冲单独存放，避免经 getTranslateJob 泄漏（对齐真实服务落盘行为） */
const stubPngs = new Map()

async function runStubJob(id, imageUrl) {
  const job = stubJobs.get(id)
  job.status = 'running'
  try {
    const result = await stubTranslateByUrl(imageUrl)
    job.status = 'done'
    // 与真实服务（translateService.saveJobResult）一致的 job 形态：
    // resultMeta 挂在 job 上，pngBuffer 单独存放（真实服务落盘，stub 用 stubPngs）
    job.resultMeta = {
      regions: result.regions,
      durationMs: result.durationMs,
      noText: result.noText,
      cacheHit: result.cacheHit,
    }
    stubPngs.set(id, result.pngBuffer)
  } catch (err) {
    job.status = 'failed'
    job.error = err.error || 'INTERNAL'
    job.message = err.message
  }
}

export function createStubTranslateService() {
  return {
    translateByUrl: stubTranslateByUrl,
    async submitTranslate(imageUrl, userOptions = {}) {
      const id = crypto.randomUUID()
      stubJobs.set(id, { id, status: 'queued' })
      // 不 await：异步执行，slow knob 走真实 800ms 延时
      runStubJob(id, imageUrl)
      return { id }
    },
    async getTranslateJob(id) {
      const job = stubJobs.get(id)
      return job ? { ...job } : null
    },
    async getTranslateJobResult(id) {
      const job = stubJobs.get(id)
      if (!job || job.status !== 'done') return null
      return stubPngs.get(id)
    },
  }
}
