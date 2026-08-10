/**
 * @file Node.js ONNX inference bridge — direct calls to onnxruntime-node.
 *
 * Implements the OnnxWorkerApi method set that the pipeline's onnxBridge.js
 * wrapper (`src/utils/translate/shinobu/runtime/onnxBridge.js`) calls, without
 * Comlink/Worker indirection — all sessions live in-process and are addressed
 * by a sessionId string, keeping the wrapper's call shape identical.
 *
 * Differences vs the browser onnx-worker bridge:
 *   - onnxruntime-node is a CPU-only Execution Provider — `executionProviders`
 *     is always `['cpu']`, regardless of `preferred`.
 *   - modelUrl is an ABSOLUTE filesystem path (from
 *     nodeModelRegistry.getModelUrlNode). Verified against
 *     onnxruntime-node@1.27.0: `InferenceSession.create` REJECTS `file://`
 *     URLs ("File doesn't exist") and only accepts plain absolute paths.
 *   - No TensorTransport serialization — feeds are passed straight to
 *     `session.run(feeds)` and the raw outputs object is returned.
 *   - GPU-only features (Paddle graph capture, GPU preprocess detect) are
 *     CPU stubs that reject with UNSUPPORTED_ON_CPU.
 *
 * Ported from ShinobuTranslator
 * `packages/model-runtime/src/runtime/onnxNodeBridge.ts` (TS → JS,
 * GPL-3.0 → AGPL-3.0 port). Session lifecycle mirrors the upstream: create →
 * run → dispose, all protected by the server serial queue (onnxruntime-node
 * sessions are not thread-safe).
 */

import * as ort from 'onnxruntime-node'

/** @type {Map<string, ort.InferenceSession>} */
const sessions = new Map()

/**
 * Build a rejection reason Error carrying an `error` code field — matches the
 * `{ error, message }` shape the pipeline's onnxBridge.js wrapper reads off
 * rejections while satisfying prefer-promise-reject-errors.
 * @param {string} error - Machine-readable error code
 * @param {string} message - Human-readable description
 * @returns {Error}
 */
function bridgeError(error, message) {
  const err = new Error(message)
  err.error = error
  return err
}

/**
 * Dispose an InferenceSession, tolerating both the legacy `release()` and the
 * newer `dispose()` surface (both are async in onnxruntime-node 1.27).
 * @param {ort.InferenceSession} session
 */
async function disposeSessionImpl(session) {
  if (typeof session.dispose === 'function') {
    await session.dispose()
  } else if (typeof session.release === 'function') {
    await session.release()
  }
}

/**
 * Initialize the bridge. onnxruntime-node needs no async setup — resolves
 * immediately (kept for OnnxWorkerApi parity).
 * @returns {Promise<void>}
 */
export async function init() {
}

/**
 * Create an ONNX InferenceSession from a model file.
 * @param {string} modelKey - Model name key (detector|inpaint|paddleocr_v6_medium_rec|bubble)
 * @param {string} modelUrl - ABSOLUTE path to the model file (getModelUrlNode)
 * @param {Array<string>} [preferred] - Preferred runtimes (ignored: CPU-only EP)
 * @param {object} [sessionOptions] - Extra options spread into create() options
 * @returns {Promise<string>} sessionId (= modelKey) — pass to runInference/disposeSession
 */
export async function createSession(modelKey, modelUrl, preferred, sessionOptions) {
  const sessionId = modelKey
  // Re-creating the same key must not leak the previous session.
  const existing = sessions.get(sessionId)
  if (existing) {
    await disposeSessionImpl(existing)
  }
  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['cpu'],
    ...sessionOptions,
  })
  sessions.set(sessionId, session)
  return sessionId
}

/**
 * Run inference against a previously created session.
 * Feeds are raw ort.Tensor-keyed objects; the raw outputs object from
 * `session.run` is returned (no TensorTransport conversion).
 * @param {string} sessionId
 * @param {Record<string, unknown>} feeds
 * @returns {Promise<Record<string, unknown>>} raw model outputs
 */
export async function runInference(sessionId, feeds) {
  const session = sessions.get(sessionId)
  if (!session) {
    return Promise.reject(bridgeError('SESSION_NOT_FOUND', `Session 不存在: ${sessionId}`))
  }
  return session.run(feeds)
}

/**
 * Probe the runtime capability without loading a model.
 * onnxruntime-node is a CPU Execution Provider; the pipeline maps 'wasm' as
 * the CPU fallback runtime string (same value the browser onnx-worker probe
 * returns for the WASM CPU backend), so this stays consistent.
 * @param {string} modelUrl - Ignored (no model load required on CPU)
 * @returns {Promise<{runtime: string, deviceType: string, backend: string}>}
 */
export async function probeRuntime(modelUrl) {
  return { runtime: 'wasm', deviceType: 'cpu', backend: 'onnxruntime-node' }
}

/**
 * GPU-only stub — Paddle graph capture requires WebGPU, unavailable on the
 * Node CPU-only runtime.
 * @param {object} options
 * @returns {Promise<never>}
 */
export async function probePaddleGraphCapture(options) {
  return Promise.reject(bridgeError('UNSUPPORTED_ON_CPU', 'Paddle graph capture requires WebGPU'))
}

/**
 * GPU-only stub — detect with GPU preprocess requires WebGPU, unavailable on
 * the Node CPU-only runtime.
 * @param {string} sessionId
 * @param {unknown} imageSource
 * @returns {Promise<never>}
 */
export async function runDetectWithGpuPreprocess(sessionId, imageSource) {
  return Promise.reject(bridgeError('UNSUPPORTED_ON_CPU', 'Paddle graph capture requires WebGPU'))
}

/**
 * Return a created session's model input/output tensor names.
 *
 * Additive accessor required by the pipeline wiring (task 1b): the pipeline's
 * `onnxBridge.js` wrapper builds `WorkerSessionHandle`s that MUST expose
 * `inputNames` / `outputNames` (bubbleDetect reads `outputNames[0..1]`,
 * paddleocrProvider reads `outputNames[0]`, inpaint reads `inputNames[1]`).
 * onnxruntime-node exposes these as `session.inputNames` / `session.outputNames`.
 *
 * @param {string} sessionId
 * @returns {{ inputNames: string[], outputNames: string[] }}
 */
export function getSessionInfo(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    throw bridgeError('SESSION_NOT_FOUND', `Session 不存在: ${sessionId}`)
  }
  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
  }
}

/**
 * Dispose a single session and remove it from the cache.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function disposeSession(sessionId) {
  const session = sessions.get(sessionId)
  if (session) {
    await disposeSessionImpl(session)
    sessions.delete(sessionId)
  }
}

/**
 * Dispose every cached session and clear the Map.
 * @returns {Promise<void>}
 */
export async function disposeAll() {
  const ids = [...sessions.keys()]
  await Promise.all(ids.map(id => disposeSession(id)))
  sessions.clear()
}
