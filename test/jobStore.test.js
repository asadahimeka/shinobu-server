import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

// 用 mkdtemp 隔离 cache 目录（与 cache.test.js 同模式）。config.js + cache.js
// 在 import 时读 env 解析 cacheDir，mkdtemp 保证与其他测试文件不冲突。
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pxv-jobstore-test-'))
process.env.CACHE_DIR = tmpDir

const jobStore = await import('../src/services/jobStore.js')
const jobsDir = path.join(tmpDir, 'jobs')

after(async () => {
  await jobStore.shutdown?.()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

test('createJob → queued 初始状态，id 唯一', () => {
  const a = jobStore.createJob('https://example.com/a.png', { targetLang: 'zh-CN' })
  const b = jobStore.createJob('https://example.com/b.png', {})
  assert.equal(a.status, 'queued')
  assert.notEqual(a.id, b.id)
  assert.ok(jobStore.getJob(a.id))
})

test('updateJob 合并 patch 并刷新 updatedAt', async () => {
  const { id } = jobStore.createJob('https://example.com/c.png', {})
  const before = jobStore.getJob(id).updatedAt
  await new Promise(r => setTimeout(r, 5))
  jobStore.updateJob(id, { status: 'running', stage: 'detect', percent: 50 })
  const job = jobStore.getJob(id)
  assert.equal(job.status, 'running')
  assert.equal(job.stage, 'detect')
  assert.equal(job.percent, 50)
  assert.ok(job.updatedAt > before)
})

test('saveJobResult 落盘 + loadJobResult 读回，meta 同步', async () => {
  const { id } = jobStore.createJob('https://example.com/d.png', {})
  await jobStore.saveJobResult(id, TINY_PNG, { regions: 3, durationMs: 42 })
  const job = jobStore.getJob(id)
  assert.equal(job.status, 'done')
  assert.equal(job.resultMeta.regions, 3)
  const buf = await jobStore.loadJobResult(id)
  assert.ok(buf.equals(TINY_PNG))
  const file = path.join(jobsDir, `${id}.png`)
  assert.ok(fs.existsSync(file))
})

test('TTL sweep 清理过期 job 与落盘文件', async () => {
  // getJob 返回副本，直接改 updatedAt 不会影响内部状态；
  // 回拨时钟让 createdAt/updatedAt 天然超过 TTL，再恢复真实时钟触发 sweep。
  const realNow = Date.now
  Date.now = () => realNow() - jobStore.JOB_TTL_MS - 1000
  const { id } = jobStore.createJob('https://example.com/e.png', {})
  await jobStore.saveJobResult(id, TINY_PNG, {})
  Date.now = realNow
  jobStore.sweepExpired()
  assert.equal(jobStore.getJob(id), null)
  // 落盘文件由 sweep 异步 unlink（fire-and-forget），轮询等待其真正删除
  const file = path.join(jobsDir, `${id}.png`)
  for (let i = 0; i < 50 && fs.existsSync(file); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(!fs.existsSync(file))
})
