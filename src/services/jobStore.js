/**
 * Job store — in-memory metadata + on-disk result PNGs.
 *
 * 异步 job 模型的数据层（2C2G 内存适配）：
 *   - 元数据（status/stage/percent/error）存内存 Map，几十字节/条
 *   - 结果 PNG 落盘 `.cache/jobs/<jobId>.png`，绝不驻留内存
 *   - TTL 30 分钟，每 5 分钟 sweep 一次；容量上限 MAX_JOBS（FIFO 逐出）
 *
 * 并发安全：Node 单线程 + 同步 Map 操作；sweep 与 saveJobResult 的
 * 文件操作是异步的，靠"先删元数据再删文件"的顺序保证幂等。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { cacheDir } from './cache.js'

export const JOB_TTL_MS = 30 * 60_000
export const MAX_JOBS = 100
const SWEEP_INTERVAL_MS = 5 * 60_000

const jobsDir = path.join(cacheDir, 'jobs')
fs.mkdirSync(jobsDir, { recursive: true })

// 启动时清理上次崩溃遗留的 tmp 写文件（原子写中断产物）
for (const f of fs.readdirSync(jobsDir)) {
  if (f.includes('.tmp-')) {
    fs.unlinkSync(path.join(jobsDir, f))
  }
}

/** @type {Map<string, Job>} */
const jobs = new Map()

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {'queued'|'running'|'done'|'failed'} status
 * @property {string} [stage]
 * @property {number} [percent]
 * @property {string} [error]
 * @property {string} [message]
 * @property {Object} [resultMeta] - {regions, durationMs, noText, cacheHit}
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** @param {string} id @returns {string} */
function resultPath(id) {
  return path.join(jobsDir, `${id}.png`)
}

/** @param {Job} job @returns {Job} a plain copy */
function clone(job) {
  return { ...job, resultMeta: job.resultMeta ? { ...job.resultMeta } : undefined }
}

/**
 * Create a queued job.
 * @param {string} imageUrl
 * @param {Object} options
 * @returns {Job}
 */
export function createJob(imageUrl, options = {}) {
  const now = Date.now()
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    imageUrl,
    options,
    createdAt: now,
    updatedAt: now,
  }
  // 容量上限：逐出最老的 job（连同落盘文件）
  if (jobs.size >= MAX_JOBS) {
    const oldestId = jobs.keys().next().value
    const oldest = jobs.get(oldestId)
    jobs.delete(oldestId)
    if (oldest?.status === 'done') {
      fsp.unlink(resultPath(oldestId)).catch(() => {})
    }
  }
  jobs.set(job.id, job)
  return clone(job)
}

/**
 * @param {string} id
 * @returns {Job|null}
 */
export function getJob(id) {
  const job = jobs.get(id)
  return job ? clone(job) : null
}

/**
 * Merge a partial patch into a job, bumping updatedAt.
 * @param {string} id
 * @param {Partial<Job>} patch
 */
export function updateJob(id, patch) {
  const job = jobs.get(id)
  if (!job) return null
  Object.assign(job, patch, { updatedAt: Date.now() })
  return clone(job)
}

/**
 * Persist the result PNG atomically and mark the job done.
 * @param {string} id
 * @param {Buffer} pngBuffer
 * @param {Object} meta - {regions, durationMs, noText, cacheHit}
 */
export async function saveJobResult(id, pngBuffer, meta = {}) {
  const job = jobs.get(id)
  if (!job) return false
  const finalPath = resultPath(id)
  const tmp = `${finalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await fsp.writeFile(tmp, pngBuffer)
  await fsp.rename(tmp, finalPath)
  updateJob(id, { status: 'done', resultMeta: meta })
  return true
}

/**
 * Read the persisted result PNG for a done job.
 * @param {string} id
 * @returns {Promise<Buffer|null>}
 */
export async function loadJobResult(id) {
  const job = jobs.get(id)
  if (!job || job.status !== 'done') return null
  try {
    return await fsp.readFile(resultPath(id))
  } catch {
    return null
  }
}

/**
 * Remove expired jobs (metadata + file). Safe to call concurrently.
 */
export function sweepExpired() {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) {
      jobs.delete(id)
      if (job.status === 'done') {
        fsp.unlink(resultPath(id)).catch(() => {})
      }
    }
  }
}

/** Stop the background sweeper (test teardown). */
export function shutdown() {
  if (sweeper) clearInterval(sweeper)
}

const sweeper = setInterval(sweepExpired, SWEEP_INTERVAL_MS)
sweeper.unref?.()
