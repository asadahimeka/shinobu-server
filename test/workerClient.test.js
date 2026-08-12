import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import fsp from 'node:fs/promises'

// 隔离 cache 目录（worker 内 translateByUrl 走 stub，不落盘，但 jobStore 需要 dir）
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pxv-workerclient-test-'))
process.env.CACHE_DIR = tmpDir
process.env.WORKER_TRANSLATE_STUB = '1'

const { createJob, getJob } = await import('../src/services/jobStore.js')
const workerClient = await import('../src/services/workerClient.js')

after(async () => {
  await workerClient.shutdown()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('submit 后 job 状态经 worker 回传流转 running → done，结果落盘', async () => {
  const { id } = createJob('https://example.com/b.png', {})
  await workerClient.submit(id, 'https://example.com/b.png', {})
  // 轮询等待 job 变为 done（worker stub 是异步的）
  let job = null
  for (let i = 0; i < 100; i++) {
    job = getJob(id)
    if (job && job.status === 'done') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(job.status, 'done')
  assert.equal(job.resultMeta.regions, 3)
  const file = path.join(tmpDir, 'jobs', `${id}.png`)
  assert.ok(fs.existsSync(file))
})

test('worker 回传失败 → job 标记 failed 带错误码', async () => {
  const { id } = createJob('https://example.com/fetch-fail.png', {})
  await workerClient.submit(id, 'https://example.com/fetch-fail.png', {})
  let job = null
  for (let i = 0; i < 100; i++) {
    job = getJob(id)
    if (job && job.status === 'failed') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(job.status, 'failed')
  assert.equal(job.error, 'IMAGE_FETCH_FAILED')
})

test('worker 崩溃 → 运行中 job 标 WORKER_CRASHED 且 worker 自动重启', async () => {
  // Momus review 修正：用 slow.png（800ms stub）而非 crash.png——crash 不匹配任何 knob
  // 会立即 resolve，50ms 后 terminate 时 job 已 done，崩溃路径测不到。slow 保证
  // terminate 时 job 仍在 in-flight，exit 处理器才会标记 WORKER_CRASHED。
  const { id } = createJob('https://example.com/slow.png', {})
  await workerClient.submit(id, 'https://example.com/slow.png', {})
  // 等 worker 开始处理（slow stub 800ms，此时应 in-flight）
  await new Promise(r => setTimeout(r, 200))
  const w = workerClient.getWorkerForTest?.()
  if (w) await w.terminate()
  // 轮询等待 failed/WORKER_CRASHED（exit 事件异步触发，不能单次读取）
  let job = null
  for (let i = 0; i < 100; i++) {
    job = getJob(id)
    if (job && job.status === 'failed') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(job.status, 'failed')
  assert.equal(job.error, 'WORKER_CRASHED')
  // worker 应已重启（能再次提交）
  const { id: id2 } = createJob('https://example.com/d.png', {})
  await workerClient.submit(id2, 'https://example.com/d.png', {})
  for (let i = 0; i < 100; i++) {
    job = getJob(id2)
    if (job && job.status === 'done') break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(job.status, 'done')
})
