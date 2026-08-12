/**
 * Server entry point (Task 5).
 *
 * Wires config + translate service (DI) + starts listening.
 * The real translateService (T10, `src/services/translateService.js`)
 * is imported lazily; until it lands the server boots with a stub that answers
 * the same DI contract (startup warns when the stub is active).
 */
import config from './config.js'
import { createApp } from './src/http/app.js'
import * as workerClient from './src/services/workerClient.js'
let translateService
try {
  const mod = await import('./src/services/translateService.js')
  translateService = mod.default || mod
  if (typeof translateService.translateByUrl !== 'function') {
    throw new Error('translateService module has no translateByUrl export')
  }
  console.log('[server] translate service loaded')
} catch (err) {
  console.warn(`[server] translateService unavailable (${err.message}) — using stub`)
  const { createStubTranslateService } = await import('./src/http/stubTranslateService.js')
  translateService = createStubTranslateService()
}

if (!config.TOKEN) {
  console.warn('[server] TOKEN is empty — auth DISABLED (open mode). Set TOKEN to protect endpoints.')
}

const app = createApp({ translateService })

const server = app.listen(config.PORT, () => {
  console.log(`[server] listening on http://localhost:${config.PORT}`)
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[server] shutting down...')
  // 强制退出兜底：先注册，即使 worker terminate 挂起也能退出
  setTimeout(() => process.exit(0), 5000).unref?.()
  try {
    await workerClient.shutdown()
  } catch (err) {
    console.warn('[server] worker shutdown error:', err.message)
  }
  server.close(() => {
    console.log('[server] stopped')
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
