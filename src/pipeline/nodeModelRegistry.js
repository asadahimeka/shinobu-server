/**
 * Node model registry — loads the model manifest and resolves model files
 * from LOCAL disk for onnxruntime-node.
 *
 * Adapted from the browser registry
 * `src/utils/translate/shinobu/runtime/modelRegistry.js` (itself mechanically
 * converted from ShinobuTranslator `src/runtime/modelRegistry.ts`, GPL-3.0).
 *
 * Differences vs the browser registry:
 *   - No CDN triple-mode (VUE_APP_MODEL_URL_TEMPLATE / MODEL_RELEASE_TAG /
 *     `/models/` web path). Node reads `<server-root>/models/` straight off
 *     disk (MODELS_DIR env override; deploy.sh places the models + manifest).
 *   - Manifest is loaded synchronously with `fs.readFileSync` (local file, no
 *     fetch/network). Callers may still `await` it — awaiting a non-Promise
 *     value is a no-op.
 *   - `normalizeRuntimeNode` always returns `['cpu']`: onnxruntime-node is a
 *     CPU Execution Provider (no webgpu/webnn/wasm EP distinction).
 *
 * Server-root anchoring (self-contained — nothing outside  is read):
 *   MODELS_DIR is resolved by src/util/paths.js from `import.meta.url`
 *   (never cwd); the `MODELS_DIR` env var overrides it (absolute passes
 *   through, relative resolves against the server root).
 *
 * Contract with nodeOnnxBridge.js (src/pipeline/):
 *   `getModelUrlNode(name)` returns the ABSOLUTE filesystem path of the model
 *   file. Verified empirically against onnxruntime-node@1.27.0: its
 *   `InferenceSession.create` REJECTS `file://` URLs ("File doesn't exist" —
 *   it treats the string as a literal path) but accepts plain absolute paths.
 *   Do NOT pass pathToFileURL().href to create().
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { serverRoot, resolveFromServerRoot } from '../util/paths.js'

/** Absolute path to the models/ directory (server's own, deploy.sh-populated). */
export const MODELS_DIR = process.env.MODELS_DIR
  ? resolveFromServerRoot(process.env.MODELS_DIR)
  : path.resolve(serverRoot, 'models')

/** Absolute path to the model manifest. */
export const MANIFEST_PATH = path.resolve(MODELS_DIR, 'models.json')

// ---------------------------------------------------------------------------
// Types — JSDoc mirrors of the browser registry's typedefs
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ManifestModel
 * @property {string} name - Model name key
 * @property {string} task - Model task: 'detection' | 'inpainting' | 'ocr'
 * @property {string} url - Model file name relative to models/
 * @property {string|Array<number>} input - Input shape or descriptor
 * @property {Array<string>} [runtime] - Supported runtime providers (browser)
 * @property {string} [dictUrl] - Dictionary file name (OCR models)
 * @property {string} [sha256] - Model file sha256
 */

/**
 * @typedef {Object} ManifestData
 * @property {string} [source] - Manifest source identifier
 * @property {string} [note] - Human-readable note
 * @property {string} [baseUrl] - Web base path (unused in Node)
 * @property {Object.<string, ManifestModel>} models - Models keyed by name
 * @property {Array<string>} [modelOrder] - Preferred iteration order
 */

/** @type {ManifestData|null} */
let manifestCache = null

/**
 * Validate manifest structure (mirror of browser validateManifest).
 * @param {object} manifest
 * @throws {Error} if manifest is structurally invalid
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid model manifest: must be a JSON object')
  }
  if (!manifest.models || typeof manifest.models !== 'object') {
    throw new Error('Invalid model manifest: missing "models" object')
  }
  const names = manifest.modelOrder || Object.keys(manifest.models)
  for (const name of names) {
    const model = manifest.models[name]
    if (!model) {
      throw new Error(`Model "${name}" not found in manifest.models`)
    }
    if (!model.name) model.name = name
    if (!model.url) {
      throw new Error(`Model "${name}" missing "url" field`)
    }
    if (!model.task) {
      throw new Error(`Model "${name}" missing "task" field`)
    }
  }
}

/**
 * Load (and cache) the model manifest from disk.
 * Synchronous local read — safe to `await`, safe to call repeatedly.
 * @returns {ManifestData}
 */
export function loadManifestNode() {
  if (manifestCache) return manifestCache
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8')
  const data = JSON.parse(raw)
  validateManifest(data)
  manifestCache = data
  return data
}

/**
 * Get a model entry from the manifest by name.
 * @param {string} name - Model name (detector|inpaint|paddleocr_v6_medium_rec|bubble)
 * @returns {ManifestModel}
 */
export function getModelConfigNode(name) {
  const manifest = loadManifestNode()
  const model = manifest.models[name]
  if (!model) {
    throw new Error(`Model "${name}" not found in manifest`)
  }
  return model
}

/**
 * Resolve the absolute filesystem path of a model file.
 * The manifest `url` is a bare filename; resolve against MODELS_DIR
 * (models, self-contained — see header note).
 * @param {string} name - Model name key
 * @returns {string} Absolute path to the model file
 */
export function resolveModelPath(name) {
  const model = getModelConfigNode(name)
  const rel = String(model.url || name).replace(/^\//, '')
  return path.resolve(MODELS_DIR, rel)
}

/**
 * Resolve the absolute filesystem path of an OCR model's dictionary file.
 * @param {string} name - OCR model name key (e.g. paddleocr_v6_medium_rec)
 * @returns {string|null} Absolute dict path, or null if the model has no dictUrl
 */
export function resolveDictPath(name) {
  const model = getModelConfigNode(name)
  if (!model.dictUrl) return null
  return path.resolve(MODELS_DIR, String(model.dictUrl).replace(/^\//, ''))
}

/**
 * Normalize runtime providers for the Node environment.
 * onnxruntime-node is a CPU Execution Provider only — always `['cpu']`,
 * regardless of input. Kept as a function so pipeline consumers that call
 * `normalizeRuntime(model.runtime)` keep working.
 * @param {unknown} value - Runtime providers from manifest (ignored)
 * @returns {Array<'cpu'>}
 */
export function normalizeRuntimeNode(value) {
  return ['cpu']
}

/**
 * Resolve the model source reference for onnxruntime-node.
 * Returns the ABSOLUTE filesystem path (NOT a file:// URL — onnxruntime-node
 * 1.27 rejects file URLs, verified in task 1a-3 QA). Pass this directly to
 * `InferenceSession.create`.
 * @param {string} name - Model name key
 * @returns {string} Absolute path to the model file
 */
export function getModelUrlNode(name) {
  return resolveModelPath(name)
}

// Allow `node src/pipeline/nodeModelRegistry.js` self-smoke:
// prints resolved paths for every manifest model and checks existence.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = loadManifestNode()
  for (const name of manifest.modelOrder || Object.keys(manifest.models)) {
    const p = resolveModelPath(name)
    console.log(`${name}: ${fs.existsSync(p) ? 'OK' : 'MISSING'} ${p}`)
    const dict = resolveDictPath(name)
    if (dict) console.log(`  dict: ${fs.existsSync(dict) ? 'OK' : 'MISSING'} ${dict}`)
  }
  console.log(`runtime: ${normalizeRuntimeNode('wasm')}  url(detector): ${getModelUrlNode('detector')}`)
}
