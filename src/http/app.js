/**
 * HTTP app factory (Task 5).
 *
 * `createApp({ translateService })` wires the whole HTTP layer:
 *   - GET /health      → model availability status
 *   - POST /translate  → binary PNG response (pipeline serialization lives in
 *                        translateService — see its Concurrency note)
 *   - bearer auth middleware (auth.js) + permissive CORS
 *   - structured error mapping (the T11 frontend contract)
 *
 * DI contract (translateService — the real one is T10, `translateService.js`):
 *   translateByUrl(imageUrl, userOptions) → Promise<TranslateResult>
 *     resolve: { pngBuffer: Buffer, noText: boolean, regions: number,
 *                durationMs: number, cacheHit: boolean }
 *     reject:  { error, message, status?, retryAfter?, detail? }
 *
 * Error codes → HTTP status (used verbatim by T11's toast mapping):
 *   UNAUTHORIZED 401 · BAD_REQUEST 400 · BUSY/TIMEOUT 503 ·
 *   IMAGE_FETCH_FAILED 502 · IMAGE_TOO_LARGE 413 · LLM_CONFIG_MISSING 500 ·
 *   LLM_RATE_LIMITED 429 (+Retry-After) · PIPELINE_FAILED 500 ·
 *   anything else → 500 INTERNAL
 */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { authMiddleware } from './auth.js'
// Single source of truth for the models dir (self-contained server-root
// resolution + MODELS_DIR env override lives in nodeModelRegistry).
import { MODELS_DIR } from '../pipeline/nodeModelRegistry.js'

/** Model files the health endpoint checks for (4 .onnx, copied by deploy.sh). */
const MODEL_FILES = {
  detector: 'detector.onnx',
  bubble: 'bubble.onnx',
  ocr: 'PP-OCRv6_medium_rec.onnx',
  inpaint: 'aot_inpaint_512.onnx',
}

/** Whitelisted request body fields passed through to translateByUrl. */
const OPTION_KEYS = ['sourceLang', 'targetLang', 'translator', 'llmModel', 'processMode']

/** Structured error code → HTTP status (T11 frontend contract). */
const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  BAD_REQUEST: 400,
  BUSY: 503,
  TIMEOUT: 503,
  IMAGE_FETCH_FAILED: 502,
  IMAGE_TOO_LARGE: 413,
  LLM_CONFIG_MISSING: 500,
  LLM_RATE_LIMITED: 429,
  PIPELINE_FAILED: 500,
}

/**
 * Current model availability. Checked per request — models are fetched at
 * deploy time (deploy.sh), so a fresh clone reports 'missing' until deploy.
 * @returns {{detector: 'loaded'|'missing', bubble: 'loaded'|'missing', ocr: 'loaded'|'missing', inpaint: 'loaded'|'missing'}}
 */
export function getModelStatus() {
  const models = {}
  for (const [key, file] of Object.entries(MODEL_FILES)) {
    models[key] = fs.existsSync(path.join(MODELS_DIR, file)) ? 'loaded' : 'missing'
  }
  return models
}

/**
 * Respond with the structured error shape `{error, message, detail?}`.
 * Unknown codes fall back to 500 {error:'INTERNAL'}.
 * @param {import('express').Response} res
 * @param {*} err - object/Error carrying `{error, message, retryAfter?, detail?}`
 */
function sendError(res, err) {
  const code = err && err.error
  const known = Object.prototype.hasOwnProperty.call(ERROR_STATUS, code)
  const status = known ? ERROR_STATUS[code] : 500
  const error = known ? code : 'INTERNAL'
  const message = (err && err.message) || '内部错误'
  if (code === 'LLM_RATE_LIMITED' && err && err.retryAfter != null) {
    res.set('Retry-After', String(err.retryAfter))
  }
  const body = { error, message }
  if (err && err.detail !== undefined) body.detail = err.detail
  res.status(status).json(body)
}

/**
 * Build the express app.
 * @param {{translateService: Object}} deps - must expose translateByUrl
 * @returns {import('express').Express}
 */
export function createApp({ translateService }) {
  if (!translateService || typeof translateService.translateByUrl !== 'function') {
    throw new TypeError('createApp: translateService.translateByUrl(imageUrl, userOptions) is required')
  }

  const app = express()
  app.disable('x-powered-by')

  // Permissive CORS: the translation server is called cross-origin from the
  // pixiv-viewer frontend (dev: localhost:8080 → server port). Token-protected
  // (authMiddleware), so wide-open CORS is safe; browsers still enforce Bearer.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.use(express.json({ limit: '1mb' }))
  app.use(authMiddleware)

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', models: getModelStatus() })
  })

  app.post('/translate', (req, res) => {
    const body = req.body || {}
    const imageUrl = body.imageUrl
    if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
      return sendError(res, { error: 'BAD_REQUEST', message: '缺少 imageUrl 字段' })
    }

    const options = {}
    for (const key of OPTION_KEYS) {
      const value = body[key]
      if (value !== undefined && value !== null) options[key] = value
    }
    if (options.targetLang === undefined) options.targetLang = 'zh-CN'

    // NO enqueue here: translateService serializes runPipeline internally.
    // Wrapping translateByUrl on the same queue singleton self-deadlocks on
    // cache miss (outer task holds the slot while its inner enqueue waits).
    translateService.translateByUrl(imageUrl.trim(), options)
      .then(result => {
        res.set('X-Translate-Duration', String(Math.round(result.durationMs || 0)))
        res.set('X-Translate-Cache', result.cacheHit ? 'hit' : 'miss')
        res.set('X-Translate-Regions', String(result.regions || 0))
        if (result.noText) res.set('X-Translate-NoText', '1')
        res.type('png')
        res.send(result.pngBuffer)
      })
      .catch(err => {
        sendError(res, err)
      })
  })

  // Safety net: body-parser / unexpected sync errors → structured errors.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: '请求体不是有效 JSON' })
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'BAD_REQUEST', message: '请求体过大' })
    }
    sendError(res, err)
  })

  return app
}
