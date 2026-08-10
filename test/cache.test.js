import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

// Isolate the cache into a temp dir and shrink LRU knobs BEFORE importing the
// module (config.js + cache.js read env at import time).
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pxv-cache-test-'))
process.env.CACHE_DIR = tmpDir
process.env.CACHE_MAX_FILES = '5'
process.env.CACHE_PURGE_INTERVAL = '1'

const { sha256, configSignature, get, set, cacheDir } = await import('../src/services/cache.js')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
const cfgA = { targetLang: 'en', translator: 'silicon', llmModel: 'model-a', processMode: 'vertical' }
const cfgB = { targetLang: 'ja', translator: 'silicon', llmModel: 'model-a', processMode: 'vertical' }

test('sha256 is deterministic, 64-char hex', () => {
  const h1 = sha256(PNG)
  const h2 = sha256(Buffer.from(PNG)) // same bytes, new buffer
  assert.equal(h1, h2)
  assert.match(h1, /^[0-9a-f]{64}$/)
})

test('configSignature is stable across key order, sensitive to targetLang', () => {
  const shuffled = { processMode: 'vertical', llmModel: 'model-a', translator: 'silicon', targetLang: 'en' }
  assert.equal(configSignature(cfgA), configSignature(shuffled))
  assert.notEqual(configSignature(cfgA), configSignature(cfgB))
  assert.match(configSignature(cfgA), /^[0-9a-f]{12}$/)
})

test('set then get round-trips; different targetLang misses', async () => {
  const sha = sha256(PNG)
  const res = await set(sha, cfgA, PNG, { regionCount: 5, durationMs: 1234 })
  assert.equal(res.configSig, configSignature(cfgA))
  assert.equal(res.pngPath, path.join(tmpDir, `${sha}.${res.configSig}.png`))

  const hit = await get(sha, cfgA)
  assert.ok(Buffer.isBuffer(hit), 'hit must be a Buffer')
  assert.deepEqual(hit, PNG)

  const miss = await get(sha, cfgB)
  assert.equal(miss, null, 'different targetLang must miss')
})

test('meta.json lands on disk with expected shape', async () => {
  const sha = sha256(PNG)
  const sig = configSignature(cfgA)
  const metaRaw = await fsp.readFile(path.join(tmpDir, `${sha}.${sig}.meta.json`), 'utf8')
  const meta = JSON.parse(metaRaw)
  assert.equal(meta.sha256, sha)
  assert.equal(meta.configSig, sig)
  assert.deepEqual(meta.config, cfgA)
  assert.equal(meta.regionCount, 5)
  assert.equal(meta.durationMs, 1234)
  assert.ok(!Number.isNaN(Date.parse(meta.createdAt)))
})

test('accepts a precomputed configSig string too', async () => {
  const sha = sha256(PNG)
  const sig = configSignature(cfgA)
  const png2 = Buffer.concat([PNG, Buffer.from([0xff])])
  await set(sha, sig, png2)
  assert.deepEqual(await get(sha, sig), png2)
})

test('empty result file and missing meta both read as null', async () => {
  const sha = sha256(PNG)
  const sig = configSignature(cfgA)
  // empty png with valid meta → null (file exists but is empty)
  await fsp.writeFile(path.join(tmpDir, `${sha}.${sig}.png`), Buffer.alloc(0))
  assert.equal(await get(sha, sig), null)
  // png with missing meta → null
  const sha2 = sha256(Buffer.from('other-bytes'))
  await fsp.writeFile(path.join(tmpDir, `${sha2}.${sig}.png`), PNG)
  assert.equal(await get(sha2, sig), null)
})

test('LRU by mtime: oldest entries evicted when over CACHE_MAX_FILES', async () => {
  const shas = []
  for (let i = 0; i < 8; i++) shas.push(sha256(Buffer.from(`image-${i}`)))
  // 8 sets, MAX_FILES=5, PURGE_INTERVAL=1 → oldest 3 must be gone after the 8th
  for (const sha of shas) await set(sha, cfgA, PNG)

  const entries = await fsp.readdir(tmpDir)
  const pngs = entries.filter(n => n.endsWith('.png'))
  const metas = entries.filter(n => n.endsWith('.meta.json'))
  assert.equal(pngs.length, 5, 'only 5 png entries kept')
  assert.equal(metas.length, 5, 'meta pairs purged together')
  for (const sha of shas.slice(0, 3)) {
    assert.ok(!pngs.some(n => n.startsWith(`${sha}.`)), `oldest ${sha} must be purged`)
  }
  for (const sha of shas.slice(5)) {
    assert.ok(pngs.some(n => n.startsWith(`${sha}.`)), `newest ${sha} must survive`)
  }
  // survivors still readable
  assert.ok(await get(shas[7], cfgA))
  assert.equal(await get(shas[0], cfgA), null)
})

test('no stale .tmp-* files left behind', async () => {
  const entries = await fsp.readdir(tmpDir)
  assert.ok(!entries.some(n => n.includes('.tmp-')), 'no temp files linger')
})

test('cacheDir resolves to the configured temp dir', () => {
  assert.equal(cacheDir, tmpDir)
})
