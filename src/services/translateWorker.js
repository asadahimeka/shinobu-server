/**
 * Worker thread entry — runs the full translateByUrl in isolation.
 *
 * 主线程事件循环被 onnxruntime-node 的同步推理阻塞（setImmediate 伪异步），
 * 2C2G 上推理期间轮询/健康检查无法响应。把翻译管线移入 worker_threads 后，
 * 主线程专职 HTTP + jobStore，推理期间保持响应（原型已验证：tick 1→33）。
 *
 * 消息协议（postMessage）：
 *   接收 {type:'translate', jobId, imageUrl, options}
 *   发送 {type:'ready'} / {type:'progress', jobId, stage, percent}
 *        / {type:'done', jobId, pngBuffer: Uint8Array, meta}（pngBuffer transfer）
 *        / {type:'failed', jobId, error, message}
 */
import { parentPort } from 'node:worker_threads'

// WORKER_TRANSLATE_STUB=1 时走 stub（集成测试用，避免真实 ONNX/LLM）
let translateByUrl
if (process.env.WORKER_TRANSLATE_STUB === '1') {
  const { createStubTranslateService } = await import('../http/stubTranslateService.js')
  const stub = createStubTranslateService()
  translateByUrl = stub.translateByUrl
} else {
  const mod = await import('./translateService.js')
  translateByUrl = mod.translateByUrl
}

parentPort.postMessage({ type: 'ready' })

parentPort.on('message', async msg => {
  if (!msg || msg.type !== 'translate') return
  const { jobId, imageUrl, options } = msg
  try {
    const result = await translateByUrl(imageUrl, options || {}, progress => {
      parentPort.postMessage({
        type: 'progress',
        jobId,
        stage: progress.stage,
        percent: progress.percent,
      })
    })
    const meta = {
      regions: result.regions,
      durationMs: result.durationMs,
      noText: result.noText,
      cacheHit: result.cacheHit,
    }
    const buf = Buffer.isBuffer(result.pngBuffer) ? result.pngBuffer : Buffer.from(result.pngBuffer)
    // Momus review 修正：new Uint8Array(buf) 是拷贝构造（新 ArrayBuffer），transfer 列表
    // 卸下的是原 buffer，消息里的 pngBuffer 实际被 structured-clone 拷贝而非转移。
    // 用 view 构造（共享底层 buffer）+ 转移该 buffer → 真正的零拷贝。
    // 但 pooled Buffer（如 stub 的 TINY_PNG，位于 Node 内部 8KB 池）的 .buffer 是整个
    // 共享池，不可 transfer（"Cannot transfer object of unsupported type"）。仅当 Buffer
    // 独占其 ArrayBuffer 时才走零拷贝 view；否则退化为独立拷贝（自带可转移 buffer）。
    const ownsBuffer =
      buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    const u8 = ownsBuffer
      ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      : new Uint8Array(buf)
    parentPort.postMessage({ type: 'done', jobId, pngBuffer: u8, meta }, [u8.buffer])
  } catch (err) {
    const code = err && err.error ? err.error : 'INTERNAL'
    const message = (err && err.message) || '翻译失败'
    parentPort.postMessage({ type: 'failed', jobId, error: code, message })
  }
})
