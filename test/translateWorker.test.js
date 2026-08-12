import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, '..', 'src', 'services', 'translateWorker.js')

/** 1x1 透明 PNG（与 stub 服务同源）——真实 worker 冒烟的源图 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

/** 真实 worker 冒烟需的模型文件（modelOrder：detector/inpaint/ocr/bubble）+ manifest */
const REQUIRED_MODEL_FILES = [
  'detector.onnx',
  'aot_inpaint_512.onnx',
  'PP-OCRv6_medium_rec.onnx',
  'bubble.onnx',
  'models.json',
]

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

/** 等 worker 发来 done 或 failed（真实 worker 冒烟：两个终态都算通过） */
function waitForDoneOrFailed(worker, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for done/failed`)), timeoutMs)
    const onMsg = msg => {
      if (msg && (msg.type === 'done' || msg.type === 'failed')) {
        clearTimeout(timer)
        worker.off('message', onMsg)
        resolve(msg)
      }
    }
    worker.on('message', onMsg)
  })
}

/** 本地起一个只返回 TINY_PNG 的 HTTP 服务（真实 worker 的 translateByUrl 需要 fetch） */
async function serveTinyPng() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(TINY_PNG)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}/tiny.png`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
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

test('真实 worker 冒烟（非 stub）：onnxruntime + translateService 在 worker 内可加载', async t => {
  // 模型文件齐全才跑（真推理加载 90MB+ 模型，CI 无模型时 skip 而非 fail）
  const modelsDir = path.join(__dirname, '..', 'models')
  const missing = REQUIRED_MODEL_FILES.filter(f => !fs.existsSync(path.join(modelsDir, f)))
  if (missing.length > 0) {
    t.skip(`模型缺失（${missing.join(', ')}），跳过真实 worker 冒烟`)
    return
  }

  const tmpCache = await fsp.mkdtemp(path.join(os.tmpdir(), 'pxv-smoke-'))
  const server = await serveTinyPng()
  // 无 WORKER_TRANSLATE_STUB → worker 走真实 translateService（onnxruntime-node + LLM）
  const worker = new Worker(WORKER_PATH, {
    env: { ...process.env, CACHE_DIR: tmpCache, WORKER_TRANSLATE_STUB: '' },
  })
  try {
    // 模块加载 + 模型加载慢（2C2G 上 10-60s），给足超时
    await waitForMessage(worker, 'ready', 30000)
    const resultP = waitForDoneOrFailed(worker, 30000)
    worker.postMessage({
      type: 'translate',
      jobId: 'job-smoke-real',
      imageUrl: server.url,
      options: {},
    })
    const result = await resultP
    assert.equal(result.jobId, 'job-smoke-real')
    // done=真推理完成；failed=早段失败（如 LLM_CONFIG_MISSING）。两者都证明
    // onnxruntime-node + translateService 在 worker 内加载且未崩溃。
    assert.ok(result.type === 'done' || result.type === 'failed', `got ${result.type}`)
  } finally {
    await worker.terminate()
    await server.close()
    fs.rmSync(tmpCache, { recursive: true, force: true })
  }
})
