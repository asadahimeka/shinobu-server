/**
 * Single-slot serial task queue (Task 9).
 *
 * ONNX Runtime sessions are NOT thread-safe (Metis review, PoC §4.8), so the
 * translation pipeline may run at most one job at a time inside this process.
 *
 * Policy (aligned with the Task 5 HTTP hook):
 *   - First request: starts immediately when the slot is free.
 *   - While one task runs, further requests wait in FIFO order (max MAX_WAITING).
 *   - Waiting queue full (>= MAX_WAITING) → immediate reject {error: 'BUSY'}.
 *   - A queued request that waits longer than WAIT_TIMEOUT_MS → reject
 *     {error: 'TIMEOUT'}. Timeout only applies while *waiting*, never to the
 *     running task itself (ONNX jobs can't be preempted mid-inference).
 *
 * No silent loss: every accepted task either runs to completion or rejects —
 * the caller's promise is always settled (result, fn error, or queue error).
 *
 * API:
 *   enqueue(fn) → Promise<result>  fn is async; its result / thrown error is
 *                                  propagated to the returned promise.
 *   isBusy()    → boolean          true while running or anything is waiting.
 *   onIdle()    → Promise<void>    resolves once nothing is running/waiting.
 *
 * Smoke test:
 *   node server/src/services/queue.js
 */
import { pathToFileURL } from 'node:url'

export const MAX_WAITING = 3
export const WAIT_TIMEOUT_MS = 60_000

/** @typedef {{fn: Function, resolve: Function, reject: Function, timer: (ReturnType<typeof setTimeout>|null)}} QueueEntry */

/** @type {QueueEntry[]} */
const waiting = []
/** @type {Function[]} */
const idleWaiters = []
let running = false

function notifyIdle() {
  while (idleWaiters.length) {
    idleWaiters.shift()()
  }
}

function pump() {
  if (running) return
  const entry = waiting.shift()
  if (!entry) {
    notifyIdle()
    return
  }
  running = true
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  Promise.resolve()
    .then(() => entry.fn())
    .then(
      // Release the slot and start the next queued task BEFORE settling the
      // caller's promise, so a caller resuming from `await enqueue()` never
      // observes stale state (running=true from the task that just finished).
      (result) => {
        running = false
        pump()
        entry.resolve(result)
      },
      (err) => {
        running = false
        pump()
        entry.reject(err)
      }
    )
}

/**
 * Enqueue an async task to run in the serial queue.
 *
 * @param {Function} fn async function to run when its turn comes
 * @returns {Promise<*>} resolves with fn's result, rejects with fn's error,
 *   or with a `{error, message}` BUSY / TIMEOUT error (503 contract).
 */
export function enqueue(fn) {
  if (typeof fn !== 'function') {
    return Promise.reject({ error: 'BAD_REQUEST', message: 'task must be a function' })
  }
  // Slot free and nothing waiting → start immediately (no wait-timeout applies).
  if (!running && waiting.length === 0) {
    return new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject, timer: null })
      pump()
    })
  }
  // Otherwise this request must wait — enforce the depth limit first.
  if (waiting.length >= MAX_WAITING) {
    return Promise.reject({ error: 'BUSY', message: '另一个翻译进行中' })
  }
  return new Promise((resolve, reject) => {
    const entry = { fn, resolve, reject, timer: null }
    entry.timer = setTimeout(() => {
      const idx = waiting.indexOf(entry)
      if (idx !== -1) waiting.splice(idx, 1)
      reject({ error: 'TIMEOUT', message: '排队等待超时，请稍后重试' })
    }, WAIT_TIMEOUT_MS)
    // Don't let a lone queued request keep the process alive on shutdown.
    entry.timer.unref?.()
    waiting.push(entry)
  })
}

/** @returns {boolean} true while a task runs or anything is queued. */
export function isBusy() {
  return running || waiting.length > 0
}

/**
 * Resolve when the queue is fully drained (nothing running, nothing waiting).
 *
 * @returns {Promise<void>}
 */
export function onIdle() {
  if (!running && waiting.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    idleWaiters.push(resolve)
  })
}

// Smoke test when executed directly: `node server/src/services/queue.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`[queue] MAX_WAITING=${MAX_WAITING} WAIT_TIMEOUT_MS=${WAIT_TIMEOUT_MS} idle=${!isBusy()}`)
}
