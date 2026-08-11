/**
 * Server-side manga translation service (Task 10).
 *
 * Orchestrates the full translate request:
 *
 *   download image → content-addressed cache check → shinobu pipeline →
 *   cache write → PNG buffer
 *
 * Contract with the Task 5 HTTP layer:
 *   translateByUrl(imageUrl, userOptions) resolves with
 *     { pngBuffer: Buffer, noText: boolean, regions: number, durationMs: number, cacheHit: boolean }
 *   and REJECTS with a structured error object (never a bare exception):
 *     { error: string, message: string, status?, stage?, retryAfter? }
 *
 * Error taxonomy (all structured, Chinese messages — see normalizeError):
 *   IMAGE_FETCH_FAILED / IMAGE_TOO_LARGE   from imageFetcher (passthrough)
 *   LLM_CONFIG_MISSING                     LLM key/baseUrl absent (thrown early,
 *                                          BEFORE the pipeline runs)
 *   LLM_RATE_LIMITED                       429 from the LLM provider
 *   PIPELINE_FAILED                        PipelineStageError with `.stage`
 *   BUSY / TIMEOUT                         serial queue pressure (passthrough)
 *   INTERNAL                               anything else (sanitized, no raw
 *                                          LLM detail leak)
 *
 * Concurrency: ONNX Runtime sessions are not thread-safe, so the pipeline run
 * is serialized through the single-slot queue (Task 9) — the ONLY queue usage
 * in the translate path (the HTTP layer does not wrap translateByUrl; an outer
 * enqueue on the same queue singleton would self-deadlock on cache miss).
 * Download + cache I/O happen outside the queue — they are I/O-bound and safe
 * in parallel, so concurrent HTTP requests may all download/cache-check in
 * parallel while only the pipeline runs serialize.
 *
 * GPL-3.0-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import config from '../../config.js'
import { serverRoot, resolveFromServerRoot } from '../util/paths.js'
import { fetchImageBytes } from './imageFetcher.js'
import { sha256, configSignature, get, set, cacheDir } from './cache.js'
import { buildTranslateConfig } from './llmConfig.js'
import { enqueue } from './queue.js'
import * as jobStore from './jobStore.js'
import { nodePlatform } from '../pipeline/nodePlatform.js'
import { runPipeline, PipelineStageError } from '../translate/shinobu/index.js'

/**
 * Font path used by the typeset stage (`MTX-SourceHanSans-CN`). Falls back to
 * the bundled font when FONT_PATH is not configured.
 */
const DEFAULT_FONT_PATH = path.join(serverRoot, 'fonts', 'SourceHanSansSC-Regular.otf')
const FONT_PATH = config.FONT_PATH ? resolveFromServerRoot(config.FONT_PATH) : DEFAULT_FONT_PATH

try {
  if (fs.existsSync(FONT_PATH)) {
    nodePlatform.registerFont(FONT_PATH, 'MTX-SourceHanSans-CN')
  } else {
    console.warn(`[translateService] 字体不存在: ${FONT_PATH} — 排版可能使用默认字体`)
  }
} catch (err) {
  console.warn(`[translateService] 字体注册失败: ${err.message}`)
}

/**
 * Structured service error factory. `no-throw-literal` (eslint) forbids
 * `throw { ... }`, so the object is built by a call expression — same idiom as
 * imageFetcher's `imageFetchFailed`.
 * @param {string} error - stable error code (T5 maps it to HTTP)
 * @param {string} message - human-readable Chinese message
 * @param {{status?: number, stage?: string, retryAfter?: number}} [extra]
 * @returns {{error: string, message: string, status?: number, stage?: string, retryAfter?: number}}
 */
function translateError(error, message, extra = {}) {
  const out = { error, message }
  if (extra.status !== undefined) out.status = extra.status
  if (extra.stage !== undefined) out.stage = extra.stage
  if (extra.retryAfter !== undefined) out.retryAfter = extra.retryAfter
  return out
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error && typeof error.message === 'string') return error.message
  return String(error ?? '未知错误')
}

/**
 * Best-effort retry-after extraction from the LLM error chain (status field,
 * `retryAfter` field, or a `retry-after: N` fragment in the message).
 * @param {unknown} error @returns {number|undefined}
 */
function extractRetryAfter(error) {
  let cursor = error
  for (let depth = 0; cursor && depth < 4; depth += 1) {
    if (typeof cursor.retryAfter === 'number') return cursor.retryAfter
    cursor = cursor.cause
  }
  const text = messageOf(error)
  const m = text.match(/retry[-_\s]?after[:\s=]+(\d+)/i)
  return m ? parseInt(m[1], 10) : undefined
}

/**
 * Normalize any thrown value into the structured error contract.
 *
 * Order matters:
 *   1. already structured ({ error }) → passthrough (imageFetcher, queue, guard)
 *   2. LLM 429 → LLM_RATE_LIMITED (checked before the stage branch so a
 *      PipelineStageError wrapping a 429 message also maps here)
 *   3. PipelineStageError → PIPELINE_FAILED with `.stage`
 *   4. unknown → INTERNAL (sanitized — raw LLM/API detail is never leaked)
 * @param {unknown} err
 * @returns {{error: string, message: string, status?: number, stage?: string, retryAfter?: number}}
 */
function normalizeError(err) {
  console.log('normalizeError: ', err)
  if (err && typeof err.error === 'string') return err
  const message = messageOf(err)
  const causeStatus = err && typeof err.cause?.status === 'number' ? err.cause.status : undefined
  if (err?.status === 429 || causeStatus === 429 || /\b429\b/.test(message)) {
    const retryAfter = extractRetryAfter(err)
    const out = translateError('LLM_RATE_LIMITED', 'LLM 限流，请稍后重试')
    if (retryAfter !== undefined) out.retryAfter = retryAfter
    return out
  }
  if (err instanceof PipelineStageError || (err && typeof err.stage === 'string')) {
    return translateError('PIPELINE_FAILED', message, { stage: err.stage })
  }
  return translateError('INTERNAL', '翻译服务内部错误')
}

/**
 * Region count for the response / cache meta. detectedRegions is the primary
 * signal (the pipeline's own early-exit paths key off it); falls back to the
 * post-order count for processMode='erase' style runs.
 * @param {import('../translate/shinobu/index.js').PipelineArtifacts} artifacts
 * @returns {number}
 */
function countRegions(artifacts) {
  if (!artifacts) return 0
  return artifacts.detectedRegions?.length || artifacts.stageRegions?.ordered?.length || 0
}

/**
 * Read the cache meta entry for a cache hit (regionCount / durationMs recorded
 * at set() time). Any failure → null (the buffer itself is the source of
 * truth; meta is best-effort enrichment).
 * @param {string} sha
 * @param {string} configSig
 * @returns {Promise<{regionCount?: number, durationMs?: number}|null>}
 */
async function readMeta(sha, configSig) {
  try {
    const raw = await fsp.readFile(path.join(cacheDir, `${sha}.${configSig}.meta.json`), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Translate a source image fetched from a URL, returning the translated PNG.
 *
 * @param {string} imageUrl - pixiv CDN (or proxy) image URL
 * @param {Object} [userOptions] - per-request overrides merged over server
 *   config (targetLang, translator, llmModel, processMode, ... — see
 *   buildTranslateConfig)
 * @returns {Promise<{pngBuffer: Buffer, noText: boolean, regions: number, durationMs: number, cacheHit: boolean}>}
 * @throws {{error: string, message: string, status?: number, stage?: string, retryAfter?: number}}
 */
export async function translateByUrl(imageUrl, userOptions = {}, onProgress) {
  const startedAt = Date.now()
  console.log(new Date(startedAt).toLocaleString('zh'), 'translateByUrl:', imageUrl)

  // ---- 1. download ----
  const imageBytes = await fetchImageBytes(imageUrl)

  // ---- 2. cache key (content-addressed sha + config signature) ----
  const sha = sha256(imageBytes)
  const config = buildTranslateConfig(userOptions)
  const configSig = configSignature(config)

  // ---- 3. cache check ----
  const cached = await get(sha, config)
  if (cached !== null) {
    const meta = await readMeta(sha, configSig)
    const regions = typeof meta?.regionCount === 'number' ? meta.regionCount : 0
    const durationMs =
      typeof meta?.durationMs === 'number' ? meta.durationMs : Date.now() - startedAt
    console.log('translateByUrl cache hit:', durationMs + 'ms')
    return {
      pngBuffer: cached,
      // regionCount === 0 ⇔ the cached result was a no-text pass-through
      noText: regions === 0,
      regions,
      durationMs,
      cacheHit: true,
    }
  }

  // ---- 4. LLM guard (before the pipeline — the LLM_CONFIG_MISSING scenario) ----
  if (!config.llmApiKey || !config.llmBaseUrl) {
    throw translateError('LLM_CONFIG_MISSING', 'LLM 未配置')
  }

  // ---- 5. run pipeline (serialized through the ONNX-safe queue) ----
  const file = new File([Buffer.from(imageBytes)], 'page.png', { type: 'image/png' })
  const seenStages = new Set()
  const progressHandler = progress => {
    const key = `${progress.stage}:${progress.percent ?? 0}`
    if (seenStages.has(key)) return
    seenStages.add(key)
    const percent = progress.percent !== undefined ? ` ${progress.percent}%` : ''
    console.log(`  [translate:stage] ${progress.stage}${percent} — ${progress.detail}`)
    onProgress?.(progress)
  }

  const pipelineStart = Date.now()
  let artifacts
  try {
    artifacts = await enqueue(() => runPipeline(file, config, progressHandler, { platform: nodePlatform }))
  } catch (err) {
    throw normalizeError(err)
  }
  const durationMs = Date.now() - pipelineStart
  console.log('translateByUrl end: ', durationMs + 'ms')

  // ---- 6. no-text handling: original bytes + noText, still a 200 ----
  const regions = countRegions(artifacts)
  let png
  let noText = false
  if (regions === 0) {
    png = imageBytes
    noText = true
  } else {
    const canvas = artifacts?.resultCanvas
    if (canvas && typeof canvas.toBuffer === 'function') {
      png = canvas.toBuffer('image/png')
    } else {
      // typeset degraded / canvas unavailable — return the original bytes
      png = imageBytes
      noText = true
    }
  }

  // ---- 7. cache write ----
  await set(sha, config, png, { regionCount: regions, durationMs, config })

  return { pngBuffer: png, noText, regions, durationMs, cacheHit: false }
}

/**
 * Submit an async translation job. Returns immediately with a job id; the
 * pipeline runs in the background through the same serial queue.
 * @param {string} imageUrl
 * @param {Object} [userOptions]
 * @returns {Promise<{id: string}>}
 */
export async function submitTranslate(imageUrl, userOptions = {}) {
  const { id } = jobStore.createJob(imageUrl, userOptions)
  // 不 await — 后台执行；同步错误（参数缺失）由调用方先校验。
  // runJob 内部已全量 try/catch 把结构化错误写回 job；外层 catch 只是
  // 兜底防 unhandledRejection，且必须记日志（绝不静默吞掉）。
  runJob(id, imageUrl, userOptions).catch(err =>
    console.error('[job] runner crashed', err)
  )
  return { id }
}

/**
 * Background job runner — wraps translateByUrl, feeds progress into the job,
 * persists the PNG on success, records the structured error on failure.
 * @param {string} id
 * @param {string} imageUrl
 * @param {Object} userOptions
 */
async function runJob(id, imageUrl, userOptions) {
  jobStore.updateJob(id, { status: 'running' })
  try {
    const result = await translateByUrl(imageUrl, userOptions, progress =>
      jobStore.updateJob(id, {
        stage: progress.stage,
        percent: progress.percent,
      })
    )
    await jobStore.saveJobResult(id, result.pngBuffer, {
      regions: result.regions,
      durationMs: result.durationMs,
      noText: result.noText,
      cacheHit: result.cacheHit,
    })
  } catch (err) {
    const code = err && err.error ? err.error : 'INTERNAL'
    const message = (err && err.message) || '翻译失败'
    jobStore.updateJob(id, { status: 'failed', error: code, message })
  }
}

/**
 * @param {string} id
 * @returns {Promise<import('./jobStore.js').Job | null>}
 */
export function getTranslateJob(id) {
  return Promise.resolve(jobStore.getJob(id))
}

/**
 * @param {string} id
 * @returns {Promise<Buffer | null>}
 */
export function getTranslateJobResult(id) {
  return jobStore.loadJobResult(id)
}

// Smoke test when executed directly: `node src/services/translateService.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    `[translateService] loaded — LLM ${config.LLM_API_KEY ? 'configured' : 'MISSING'} ` +
      `baseUrl=${config.LLM_BASE_URL || '(none)'} model=${config.LLM_MODEL} ` +
      `font=${fs.existsSync(FONT_PATH) ? FONT_PATH : '(missing)'}`
  )
}
