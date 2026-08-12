/**
 * Worker client — manages the singleton translate worker on the main thread.
 *
 * 职责：
 *   - 懒创建单例 worker（进程首个 job 时启动）
 *   - submit(jobId, imageUrl, options)：向 worker 发翻译消息
 *   - 监听 worker 消息：progress → jobStore.updateJob；done → saveJobResult；
 *     failed → jobStore.updateJob 标记 failed
 *   - worker error/exit：运行中 job 标 WORKER_CRASHED，自动重启（幂等，
 *     下个 job 复用新 worker）
 *   - shutdown()：优雅 terminate（服务关闭时）
 *
 * 主线程是唯一写盘者（saveJobResult 只在主线程调用）；worker 只回传 buffer。
 */
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { updateJob, saveJobResult } from './jobStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, 'translateWorker.js')

/** @type {Worker | null} */
let worker = null

/** @type {Promise<Worker> | null} — 创建中的 worker（并发去重） */
let workerPromise = null

/** @type {Set<string>} — 已派发、尚未 done/failed 的 job id（崩溃时标记用） */
const pendingJobs = new Set()

/**
 * 标记一个 job 为失败（helper）。
 * @param {string} id
 * @param {string} error
 * @param {string} message
 */
function failJob(id, error, message) {
  updateJob(id, { status: 'failed', error, message })
}

/**
 * 创建 worker 并挂接消息/错误监听。返回 worker。
 * @returns {Promise<Worker>}
 */
function createWorker() {
  const w = new Worker(WORKER_PATH)
  w.on('message', msg => {
    if (!msg || typeof msg.type !== 'string') return
    if (msg.type === 'progress') {
      updateJob(msg.jobId, { stage: msg.stage, percent: msg.percent })
    } else if (msg.type === 'done') {
      pendingJobs.delete(msg.jobId)
      saveJobResult(msg.jobId, Buffer.from(msg.pngBuffer), msg.meta)
    } else if (msg.type === 'failed') {
      pendingJobs.delete(msg.jobId)
      failJob(msg.jobId, msg.error, msg.message)
    }
  })
  w.on('error', err => {
    // worker 内部未捕获异常——标记所有 pending job 为 crashed，随后 exit 会重启
    console.error('[workerClient] worker error:', err)
    for (const id of pendingJobs) {
      failJob(id, 'WORKER_CRASHED', `翻译 worker 异常: ${err.message}`)
    }
    pendingJobs.clear()
  })
  w.on('exit', code => {
    if (code !== 0) {
      for (const id of pendingJobs) {
        failJob(id, 'WORKER_CRASHED', '翻译 worker 意外退出')
      }
      pendingJobs.clear()
    }
    worker = null
    workerPromise = null
    // 不自动重启——下一个 submit() 会懒创建新 worker（幂等恢复）
  })
  return w
}

/**
 * 懒获取单例 worker（并发调用共享同一创建 Promise）。
 * @returns {Promise<Worker>}
 */
export async function initWorker() {
  if (worker) return worker
  if (workerPromise) return workerPromise
  workerPromise = new Promise((resolve, reject) => {
    const w = createWorker()
    // 等 worker 发 ready 再 resolve（确保监听器已就绪）
    const onReady = msg => {
      if (msg && msg.type === 'ready') {
        w.off('message', onReady)
        worker = w
        resolve(w)
      }
    }
    w.on('message', onReady)
    w.once('error', reject)
  }).finally(() => {
    workerPromise = null
  })
  return workerPromise
}

/**
 * 向 worker 提交一个翻译任务（不 resolve 结果——结果经消息回调写入 jobStore）。
 * @param {string} jobId
 * @param {string} imageUrl
 * @param {Object} [options]
 * @returns {Promise<void>}
 */
export async function submit(jobId, imageUrl, options = {}) {
  const w = await initWorker()
  pendingJobs.add(jobId)
  w.postMessage({ type: 'translate', jobId, imageUrl, options })
}

/** 测试 hook：返回当前 worker（无则 null）。 */
export function getWorkerForTest() {
  return worker
}

/**
 * 优雅关闭 worker。幂等。
 * @returns {Promise<void>}
 */
export async function shutdown() {
  pendingJobs.clear()
  if (worker) {
    const w = worker
    worker = null
    workerPromise = null
    await w.terminate()
  }
}
