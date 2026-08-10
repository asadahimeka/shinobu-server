/**
 * @file Model registry — Node replacement (server/src/translate/shinobu copy).
 *
 * Server wiring (task 1b): replaces the browser CDN triple-mode registry with a
 * wrapper around `server/src/pipeline/nodeModelRegistry.js`:
 *   - manifest is loaded from LOCAL disk (`fs.readFileSync`, self-contained —
 *     resolved against the server root via server/src/util/paths.js)
 *   - model URLs resolve to ABSOLUTE filesystem paths (getModelUrlNode —
 *     onnxruntime-node rejects file:// URLs, see nodeOnnxBridge contract)
 *   - `runtime` normalizes to `['cpu']` (normalizeRuntimeNode)
 *   - the input-shape normalization the browser `getModel` performs is
 *     replicated here (pipeline consumers read model.input[0]/[1])
 *
 * `getModelSession` keeps the browser's session-cache dedup (sessionCache +
 * sessionPromiseCache keyed by `name:runtime:serializedSessionOptions`) and
 * delegates session creation to the copy's node `onnxBridge.createSession`.
 *
 * Keeps the browser source file's public API shape — callers in the copy
 * (index.js probeRuntime, onnxDetect.js, bubbleDetect.js, inpaint.js,
 * paddleocrProvider.js) import the same named exports.
 */

import { serializeOnnxSessionOptions } from './onnxSessionOptions.js'
import * as nodeModelRegistry from '../../../pipeline/nodeModelRegistry.js'
import { createSession, disposeSession, disposeAll } from './onnxBridge.js'

// ---------------------------------------------------------------------------
// Doc-only type imports — referenced in JSDoc, zero runtime impact
// ---------------------------------------------------------------------------

/** @typedef {import('./onnxTypes.js').RuntimeProvider} RuntimeProvider */
/** @typedef {import('./onnxSessionOptions.js').OnnxSessionOptions} OnnxSessionOptions */
/** @typedef {import('./onnxWorkerTypes.js').WorkerSessionHandle} WorkerSessionHandle */

/**
 * @typedef {Object} ManifestModel
 * @property {string} name - Model name key
 * @property {string} task - Model task: 'detection' | 'inpainting' | 'ocr'
 * @property {string} url - Resolved model URL (absolute path in Node)
 * @property {string|Array<number>} input - Input shape or descriptor
 * @property {Array<RuntimeProvider>} [runtime] - Supported runtime providers
 * @property {string} [dictUrl] - Dictionary path (OCR models)
 * @property {string} [maskInputName]
 */
export const ManifestModel = {}

/**
 * @typedef {Object} ManifestData
 * @property {string} [source] - Manifest source identifier
 * @property {string} [note] - Human-readable note
 * @property {Object.<string, ManifestModel>} models - Models keyed by name
 * @property {Array<string>} [modelOrder] - Preferred iteration order
 */
export const ManifestData = {}

/** @typedef {'detector'|'inpaint'|'bubble'|'paddleocr_v6_medium_rec'} ModelName */
export const ModelName = {}

// ---------------------------------------------------------------------------
// Manifest cache & model access (nodeModelRegistry-backed)
// ---------------------------------------------------------------------------

/** @type {ManifestData|null} */
let manifestCache = null

/**
 * Load and cache the model manifest JSON (local disk via nodeModelRegistry).
 * @param {string} [manifestUrl] - Ignored: Node reads the local manifest file.
 * @returns {Promise<ManifestData>}
 */
export async function loadManifest(manifestUrl) {
  if (manifestCache) return manifestCache
  manifestCache = nodeModelRegistry.loadManifestNode()
  return manifestCache
}

/**
 * Get resolved model configuration by name.
 *
 * Replicates the browser getModel() semantics (input-shape normalization)
 * but resolves `url`/`dictUrl` to absolute filesystem paths and normalizes
 * runtime to `['cpu']` for onnxruntime-node.
 *
 * @param {ModelName} name - Model name (detector|inpaint|bubble|paddleocr_v6_medium_rec)
 * @returns {Promise<ManifestModel>} Resolved model config with absolute paths
 */
export async function getModel(name) {
  const manifest = await loadManifest()
  const model = manifest.models[name]
  if (!model) {
    throw new Error(`Model "${name}" not found in manifest`)
  }
  const rawInput = model.input
  let resolved = model
  if (!Array.isArray(rawInput) || !rawInput.every(v => Number.isFinite(v))) {
    const defaults = {
      detection: [1024, 1024],
      inpainting: [512, 512],
      ocr: [48, 320],
    }
    resolved = { ...model, input: defaults[model.task] || [512, 512] }
  }
  return {
    ...resolved,
    url: nodeModelRegistry.getModelUrlNode(name),
    dictUrl: resolved.dictUrl ? nodeModelRegistry.resolveDictPath(name) : undefined,
    runtime: nodeModelRegistry.normalizeRuntimeNode(),
  }
}

/**
 * Get the resolved model file path for a model.
 * @param {ModelName} name
 * @returns {Promise<string>}
 */
export async function getModelUrl(name) {
  const model = await getModel(name)
  return model.url
}

// ---------------------------------------------------------------------------
// Session cache (dedup, reuse) — same shape as the browser registry
// ---------------------------------------------------------------------------

/** @type {Map<string, WorkerSessionHandle>} — Resolved session handles */
const sessionCache = new Map()

/** @type {Map<string, Promise<WorkerSessionHandle>>} — In-flight creation promises */
const sessionPromiseCache = new Map()

/**
 * Get or create an ONNX inference session for a model.
 *
 * Same contract as the browser registry: resolves model config + URL, computes
 * a cache key from (name, runtime, serializeOnnxSessionOptions(sessionOptions)),
 * returns a cached handle when available, deduplicates concurrent in-flight
 * creations, and otherwise delegates to onnxBridge.createSession (Node bridge).
 *
 * @param {ModelName} name - Model name key
 * @param {Array<RuntimeProvider>} [preferred] - Ignored by the Node bridge
 *   (onnxruntime-node is CPU-only) but kept for call-shape parity.
 * @param {OnnxSessionOptions} [sessionOptions] - ONNX session creation options
 * @returns {Promise<WorkerSessionHandle>}
 */
export async function getModelSession(name, preferred, sessionOptions) {
  const model = await getModel(name)
  const runtime = preferred && preferred.length > 0 ? preferred : model.runtime
  const sessionOptionsKey = serializeOnnxSessionOptions(sessionOptions)
  const dedupedRuntime = runtime.filter((item, idx) => runtime.indexOf(item) === idx)
  const cacheKey = `${name}:${dedupedRuntime.join(',')}:${sessionOptionsKey}`

  const cached = sessionCache.get(cacheKey)
  if (cached) return cached

  const pending = sessionPromiseCache.get(cacheKey)
  if (pending) return pending

  const creation = createSession(name, model.url, runtime, sessionOptions)
    .then(handle => {
      sessionCache.set(cacheKey, handle)
      return handle
    })
    .finally(() => {
      sessionPromiseCache.delete(cacheKey)
    })
  sessionPromiseCache.set(cacheKey, creation)
  return creation
}

/**
 * Dispose cached sessions for a model, then forward to the Node bridge.
 * @param {ModelName} name
 * @returns {Promise<void>}
 */
export async function disposeModelSession(name) {
  for (const key of [...sessionCache.keys()]) {
    if (key.startsWith(`${name}:`)) {
      sessionCache.delete(key)
    }
  }
  await disposeSession(name)
}

/**
 * Dispose all cached sessions, clear caches, and forward to the Node bridge.
 * @returns {Promise<void>}
 */
export async function disposeAllModelSessions() {
  sessionCache.clear()
  sessionPromiseCache.clear()
  manifestCache = null
  await disposeAll()
}
