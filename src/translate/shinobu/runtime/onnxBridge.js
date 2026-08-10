/**
 * @file ONNX Bridge — Node replacement (server/src/translate/shinobu copy).
 *
 * Server wiring (task 1b): this copy replaces the browser-only lazy Comlink
 * worker bridge with a direct wrapper around
 * `server/src/pipeline/nodeOnnxBridge.js` (onnxruntime-node, CPU EP).
 *
 * Adaptation layer:
 *   - Pipeline feeds are `TensorTransport` objects `{ data, dims, type }`
 *     (crossing the comlink boundary in the browser); onnxruntime-node's
 *     `session.run(feeds)` needs `{ name: ort.Tensor }` — converted here.
 *   - Raw `session.run` outputs `{ name: ort.Tensor }` are converted back to
 *     `TensorTransport` keyed by output name — the shape the pipeline's
 *     `result.outputs[name]` consumers expect (bubbleDetect, paddleocr,
 *     inpaint/detect pick-tensor helpers).
 *   - `createSession` returns a `WorkerSessionHandle`-shaped object
 *     `{ sessionId, provider, deviceType, inputNames, outputNames }`.
 *     provider is `'wasm'` (the pipeline's CPU-fallback runtime string, see
 *     nodeOnnxBridge.probeRuntime) so no WebGPU path is attempted; inputNames/
 *     outputNames come from nodeOnnxBridge.getSessionInfo (real tensor names).
 *   - GPU-only methods (probePaddleGraphCapture / runDetectWithGpuPreprocess)
 *     reject with UNSUPPORTED_ON_CPU via the node bridge.
 *
 * Keeps the browser source file's public API shape — callers in the copy
 * (modelRegistry.js, onnxDetect.js, bubbleDetect.js, inpaint.js,
 * paddleocrProvider.js) import the same named exports.
 */

import * as ort from 'onnxruntime-node'
import * as nodeBridge from '../../../pipeline/nodeOnnxBridge.js'

/**
 * @typedef {import('./onnxWorkerTypes.js').WorkerSessionHandle} WorkerSessionHandle
 */

/**
 * Convert a pipeline TensorTransport `{ data, dims, type }` to an ort.Tensor.
 * @param {{data: import('./onnxWorkerTypes.js').TensorTransport['data'], dims: number[], type: string}} transport
 * @returns {ort.Tensor}
 */
function toOrtTensor(transport) {
  return new ort.Tensor(transport.type, transport.data, transport.dims)
}

/**
 * Convert an ort.Tensor back to a pipeline TensorTransport.
 * @param {ort.Tensor} tensor
 * @returns {{data: import('./onnxWorkerTypes.js').TensorTransport['data'], dims: number[], type: string}}
 */
function fromOrtTensor(tensor) {
  return { data: tensor.data, dims: tensor.dims, type: tensor.type }
}

/**
 * @param {string} modelKey
 * @param {string} modelUrl - ABSOLUTE filesystem path (getModelUrlNode)
 * @param {Array<string>} [preferred] - Ignored: onnxruntime-node is CPU-only
 * @param {import('./onnxSessionOptions.js').OnnxSessionOptions} [sessionOptions]
 * @returns {Promise<WorkerSessionHandle>}
 */
export async function createSession(modelKey, modelUrl, preferred, sessionOptions) {
  const sessionId = await nodeBridge.createSession(modelKey, modelUrl, preferred, sessionOptions)
  const info = nodeBridge.getSessionInfo(sessionId)
  return {
    sessionId,
    provider: 'wasm',
    deviceType: 'cpu',
    inputNames: info.inputNames,
    outputNames: info.outputNames,
  }
}

/**
 * @param {string} sessionId
 * @param {Object.<string, import('./onnxWorkerTypes.js').TensorTransport>} feeds
 * @returns {Promise<import('./onnxWorkerTypes.js').InferenceResult>}
 */
export async function runInference(sessionId, feeds) {
  const ortFeeds = {}
  for (const [name, transport] of Object.entries(feeds)) {
    ortFeeds[name] = toOrtTensor(transport)
  }
  const raw = await nodeBridge.runInference(sessionId, ortFeeds)
  const outputs = {}
  for (const [name, tensor] of Object.entries(raw)) {
    outputs[name] = fromOrtTensor(tensor)
  }
  return { outputs }
}

/**
 * @param {string} modelUrl
 * @returns {Promise<import('./selfCheck.js').RuntimeSelfCheckReport>}
 */
export async function probeRuntime(modelUrl) {
  return nodeBridge.probeRuntime(modelUrl)
}

/**
 * @param {import('./onnxWorkerTypes.js').PaddleGraphCaptureProbeOptions} options
 * @returns {Promise<import('./onnxWorkerTypes.js').PaddleGraphCaptureProbeResult>}
 */
export async function probePaddleGraphCapture(options) {
  return nodeBridge.probePaddleGraphCapture(options)
}

/**
 * @param {string} sessionId
 * @param {ImageBitmap} imageSource
 * @returns {Promise<import('./onnxWorkerTypes.js').GpuDetectResult>}
 */
export async function runDetectWithGpuPreprocess(sessionId, imageSource) {
  return nodeBridge.runDetectWithGpuPreprocess(sessionId, imageSource)
}

/**
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function disposeSession(sessionId) {
  return nodeBridge.disposeSession(sessionId)
}

/**
 * @returns {Promise<void>}
 */
export async function disposeAll() {
  return nodeBridge.disposeAll()
}
