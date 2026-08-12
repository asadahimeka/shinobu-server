import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, '..', 'src', 'services', 'translateWorker.js')

/**
 * 集成测试：真实 worker + stub 翻译逻辑。
 * 通过环境变量 WORKER_TRANSLATE_STUB=1 让 worker 内的 translateByUrl 走 stub
 * （见 Task 1 Step 3 的 worker 内分支），避免真实 ONNX/LLM。
 */
function spawnWorker() {
  const worker = new Worker(WORKER_PATH, {
    env: { ...process.env, WORKER_TRANSLATE_STUB: '1' },
  })
  return worker
}

/** 等 worker 发来指定 type 的消息 */
function waitForMessage(worker, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
    const onMsg = msg => {
      if (msg && msg.type === type) {
        clearTimeout(timer)
        worker.off('message', onMsg)
        resolve(msg)
      }
    }
    worker.on('message', onMsg)
  })
}

test('worker 启动后发 ready，能接收 translate 任务并回传 progress + done', async () => {
  const worker = spawnWorker()
  try {
    await waitForMessage(worker, 'ready')
    const doneP = waitForMessage(worker, 'done')
    worker.postMessage({ type: 'translate', jobId: 'job-1', imageUrl: 'https://example.com/a.png', options: {} })
    const done = await doneP
    assert.equal(done.jobId, 'job-1')
    assert.ok(done.pngBuffer instanceof Uint8Array)
    assert.ok(done.pngBuffer.length > 0)
    assert.equal(typeof done.meta.regions, 'number')
  } finally {
    await worker.terminate()
  }
})

test('worker 回传进度事件（stage/percent）', async () => {
  const worker = spawnWorker()
  try {
    await waitForMessage(worker, 'ready')
    const progressP = waitForMessage(worker, 'progress')
    worker.postMessage({ type: 'translate', jobId: 'job-2', imageUrl: 'https://example.com/slow.png', options: {} })
    const prog = await progressP
    assert.equal(prog.jobId, 'job-2')
    assert.equal(typeof prog.stage, 'string')
    assert.equal(typeof prog.percent, 'number')
    // 等 done 避免 worker 悬挂
    await waitForMessage(worker, 'done')
  } finally {
    await worker.terminate()
  }
})

test('worker 翻译失败回传 failed（含结构化错误码）', async () => {
  const worker = spawnWorker()
  try {
    await waitForMessage(worker, 'ready')
    const failedP = waitForMessage(worker, 'failed')
    worker.postMessage({ type: 'translate', jobId: 'job-3', imageUrl: 'https://example.com/fetch-fail.png', options: {} })
    const failed = await failedP
    assert.equal(failed.jobId, 'job-3')
    assert.equal(failed.error, 'IMAGE_FETCH_FAILED')
  } finally {
    await worker.terminate()
  }
})
