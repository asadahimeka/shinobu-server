/**
 * queue unit tests (Task 16).
 *
 * The queue is a module-level singleton, so every test drains it fully
 * (`onIdle()`) before finishing. The TIMEOUT test does NOT wait the real
 * WAIT_TIMEOUT_MS (60s): `setTimeout` is stubbed so only the queue's
 * wait-timer (delay === WAIT_TIMEOUT_MS) is captured and fired manually.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { enqueue, isBusy, onIdle, MAX_WAITING, WAIT_TIMEOUT_MS } = await import('../src/services/queue.js')

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('two tasks run serially in FIFO order (fast one waits)', async () => {
  const order = []
  const task = (name, ms) => () =>
    new Promise(resolve => setTimeout(() => {
      order.push(name)
      resolve(name)
    }, ms))

  const results = await Promise.all([
    enqueue(task('A', 30)),
    enqueue(task('B', 5)),
  ])
  assert.deepEqual(results, ['A', 'B'])
  assert.deepEqual(order, ['A', 'B'])
  await onIdle()
})

test('4th concurrent request → BUSY (MAX_WAITING=3)', async () => {
  const gate = deferred()
  const p0 = enqueue(() => gate.promise)
  const p1 = enqueue(() => 'one')
  const p2 = enqueue(() => 'two')
  const p3 = enqueue(() => 'three')
  assert.equal(isBusy(), true)

  await assert.rejects(enqueue(() => 'four'), err => err.error === 'BUSY')

  gate.resolve('done')
  const results = await Promise.all([p0, p1, p2, p3])
  assert.deepEqual(results, ['done', 'one', 'two', 'three'])
  await onIdle()
})

test('queued request rejected TIMEOUT after WAIT_TIMEOUT_MS of waiting', async () => {
  const realSetTimeout = globalThis.setTimeout
  const captured = []
  globalThis.setTimeout = (cb, ms, ...args) => {
    if (ms === WAIT_TIMEOUT_MS) {
      const t = { cb, args, unref() {} }
      captured.push(t)
      return t
    }
    return realSetTimeout(cb, ms, ...args)
  }

  const gate = deferred()
  const p0 = enqueue(() => gate.promise)
  const p1 = enqueue(() => 'first')
  const p2 = enqueue(() => 'second')

  try {
    assert.equal(captured.length, 2, 'both queued requests hold a wait timer')
    captured[0].cb()
    await assert.rejects(p1, err => err.error === 'TIMEOUT')
  } finally {
    gate.resolve('done')
    globalThis.setTimeout = realSetTimeout
  }

  assert.equal(await p0, 'done')
  assert.equal(await p2, 'second', 'the surviving queued task still runs')
  await onIdle()
})

test('task rejection propagates; queue keeps accepting work', async () => {
  await assert.rejects(
    enqueue(async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  assert.equal(await enqueue(() => 'still-works'), 'still-works')
  await onIdle()
})

test('enqueue(non-function) → BAD_REQUEST', async () => {
  await assert.rejects(enqueue(null), err => err.error === 'BAD_REQUEST')
  await onIdle()
})

test('onIdle resolves only after the queue drains', async () => {
  let resolved = false
  const done = enqueue(() => new Promise(resolve => setTimeout(resolve, 20)))
  const idle = onIdle().then(() => {
    resolved = true
  })
  assert.equal(resolved, false, 'not idle while a task runs')
  await done
  await idle
  assert.equal(resolved, true)
  await onIdle()
})

test('isBusy transitions with running + waiting', async () => {
  assert.equal(isBusy(), false)
  const gate = deferred()
  const p0 = enqueue(() => gate.promise)
  assert.equal(isBusy(), true)
  gate.resolve('x')
  await p0
  await onIdle()
  assert.equal(isBusy(), false)
})
