/**
 * Server-side translation result cache.
 *
 * Key design:
 *   - sha256 of the source image bytes (64 hex chars). Content-addressed:
 *     NEVER key on the pixiv URL — image URLs expire.
 *   - config signature (12 hex chars): stable hash of exactly
 *     {targetLang, translator, llmModel, processMode} (sorted keys, missing
 *     values normalized to ''). Same config → same signature; changing any
 *     field (e.g. targetLang) → different signature → cache miss → re-translate.
 *
 * Storage layout (CACHE_DIR, default `.cache/` resolved against the server
 * root via server/src/util/paths.js so behaviour is identical regardless of
 * process cwd; absolute env values pass through):
 *   <sha256>.<configSig>.png          — translated result bytes
 *   <sha256>.<configSig>.meta.json    — {sha256, configSig, config, createdAt, regionCount, durationMs}
 *
 * Retention: simple LRU by file mtime (count-based — the brief's default).
 *   Keep the most recent `CACHE_MAX_FILES` (default 500) result .png files;
 *   on purge, remove oldest-mtime entries, each .png together with its
 *   .meta.json pair. Orphaned `.tmp-*` files older than TMP_MAX_AGE_MS are
 *   swept opportunistically during the same pass.
 *
 * Tuning env overrides (read directly here, independent of config.js so no
 * other module needs touching):
 *   CACHE_MAX_FILES       max .png entries kept, default 500
 *   CACHE_PURGE_INTERVAL  run the purge pass at most once every N set(), default 20
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import config from '../../config.js'
import { resolveFromServerRoot } from '../util/paths.js'

// Self-contained: CACHE_DIR resolves against the server root (absolute env
// values pass through) — nothing outside server/ is ever read or written.
export const cacheDir = resolveFromServerRoot(config.CACHE_DIR)

const PNG_SUFFIX = '.png'
const META_SUFFIX = '.meta.json'
const TMP_MARK = '.tmp-'
const MAX_FILES = parseInt(process.env.CACHE_MAX_FILES, 10) || 500
const PURGE_INTERVAL = parseInt(process.env.CACHE_PURGE_INTERVAL, 10) || 20
const TMP_MAX_AGE_MS = 10 * 60 * 1000

// Exactly these four config fields participate in the cache key.
const CONFIG_KEYS = ['targetLang', 'translator', 'llmModel', 'processMode'].sort()
const CONFIG_SIG_LEN = 12

let setCount = 0

/**
 * sha256 of bytes → lowercase hex string.
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {string}
 */
export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Pick exactly the cache-relevant config fields, normalizing missing → ''.
 * @param {object} [cfg]
 * @returns {{targetLang: string, translator: string, llmModel: string, processMode: string}}
 */
function pickConfig(cfg = {}) {
  const out = {}
  for (const key of CONFIG_KEYS) out[key] = cfg[key] ?? ''
  return out
}

/**
 * Stable config signature — short hash of the normalized config JSON.
 * Same config (any key order) → same signature; different field → different signature.
 * @param {{targetLang?: string, translator?: string, llmModel?: string, processMode?: string}} [cfg]
 * @returns {string} 12-char hex
 */
export function configSignature(cfg = {}) {
  return sha256(JSON.stringify(pickConfig(cfg))).slice(0, CONFIG_SIG_LEN)
}

/**
 * Accept either a precomputed configSig string or a raw config object
 * (hashed via configSignature). The latter is the convenient form for callers
 * holding the config object (QA scenario `set(sha, cfg, png)`).
 * @param {string|object} configOrSig
 * @returns {string}
 */
function resolveSig(configOrSig) {
  if (typeof configOrSig === 'string') {
    if (!configOrSig) throw new TypeError('cache: configSig must be a non-empty string')
    return configOrSig
  }
  if (configOrSig && typeof configOrSig === 'object') return configSignature(configOrSig)
  throw new TypeError('cache: expected a configSig string or a config object')
}

function resultPath(sha, configSig) {
  return path.join(cacheDir, `${sha}.${configSig}${PNG_SUFFIX}`)
}

function metaPath(sha, configSig) {
  return path.join(cacheDir, `${sha}.${configSig}${META_SUFFIX}`)
}

/**
 * Read a cached translation result.
 * @param {string} sha sha256 hex of the source image bytes
 * @param {string|object} configOrSig configSig string or config object
 * @returns {Promise<Buffer|null>} png buffer, or null on miss/corruption/meta-mismatch
 */
export async function get(sha, configOrSig) {
  if (!sha) throw new TypeError('cache.get: sha is required')
  const configSig = resolveSig(configOrSig)
  try {
    const [png, metaRaw] = await Promise.all([
      fsp.readFile(resultPath(sha, configSig)),
      fsp.readFile(metaPath(sha, configSig), 'utf8'),
    ])
    if (!png || png.length === 0) return null
    const meta = JSON.parse(metaRaw)
    // Belt-and-suspenders: the filename already encodes the key, but verify
    // the meta agrees so a tampered/misplaced file can never be served.
    if (meta.sha256 !== sha || meta.configSig !== configSig) return null
    return png
  } catch {
    return null // missing, corrupt, or unreadable → treat as a miss
  }
}

/**
 * Store a translation result. Writes are atomic: `<final>.<tmp-*>` then rename,
 * so a crash mid-write never leaves a partial file readable at the final path.
 * @param {string} sha sha256 hex of the source image bytes
 * @param {string|object} configOrSig configSig string or config object (object form records full config in meta)
 * @param {Buffer|Uint8Array} pngBuffer translated result bytes
 * @param {{regionCount?: number, durationMs?: number, config?: object}} [meta] extra metadata
 * @returns {Promise<{sha: string, configSig: string, pngPath: string, metaPath: string}>}
 */
export async function set(sha, configOrSig, pngBuffer, meta = {}) {
  if (!sha) throw new TypeError('cache.set: sha is required')
  const configSig = resolveSig(configOrSig)
  const configRec = typeof configOrSig === 'object' ? pickConfig(configOrSig) : pickConfig(meta.config)
  const buf = Buffer.isBuffer(pngBuffer) ? pngBuffer : Buffer.from(pngBuffer)
  if (buf.length === 0) throw new TypeError('cache.set: pngBuffer must not be empty')

  await fsp.mkdir(cacheDir, { recursive: true })

  const pngPath = resultPath(sha, configSig)
  const metaFile = metaPath(sha, configSig)
  const tmp = `${TMP_MARK}${process.pid}-${crypto.randomBytes(6).toString('hex')}`

  await fsp.writeFile(pngPath + tmp, buf)
  await fsp.rename(pngPath + tmp, pngPath)

  const metaJson = {
    sha256: sha,
    configSig,
    config: configRec,
    createdAt: new Date().toISOString(),
    regionCount: typeof meta.regionCount === 'number' && Number.isFinite(meta.regionCount) ? meta.regionCount : 0,
    durationMs: typeof meta.durationMs === 'number' && Number.isFinite(meta.durationMs) ? meta.durationMs : 0,
  }
  await fsp.writeFile(metaFile + tmp, JSON.stringify(metaJson, null, 2))
  await fsp.rename(metaFile + tmp, metaFile)

  await maybePurge()

  return { sha, configSig, pngPath, metaPath: metaFile }
}

/**
 * Throttled LRU purge. `set()` itself touches the mtime of the just-written
 * file (newest), so it can never be an eviction victim.
 */
async function maybePurge() {
  setCount++
  if (setCount % PURGE_INTERVAL !== 0) return
  await purge()
}

async function purge() {
  let names
  try {
    names = await fsp.readdir(cacheDir)
  } catch {
    return // dir missing / raced — nothing to purge
  }
  const pngNames = names.filter(n => n.endsWith(PNG_SUFFIX) && !n.includes(TMP_MARK))
  if (pngNames.length > MAX_FILES) {
    const stats = await Promise.all(
      pngNames.map(async name => {
        try {
          const st = await fsp.stat(path.join(cacheDir, name))
          return { name, mtime: st.mtimeMs }
        } catch {
          return null // vanished mid-pass
        }
      })
    )
    const valid = stats.filter(Boolean).sort((a, b) => a.mtime - b.mtime)
    const excess = valid.length - MAX_FILES
    if (excess > 0) {
      await Promise.all(valid.slice(0, excess).map(v => removePair(v.name)))
    }
  }
  await sweepTmp(names)
}

async function removePair(pngName) {
  const base = pngName.slice(0, -PNG_SUFFIX.length)
  await Promise.all([
    fsp.unlink(path.join(cacheDir, pngName)).catch(() => {}),
    fsp.unlink(path.join(cacheDir, base + META_SUFFIX)).catch(() => {}),
  ])
}

async function sweepTmp(names) {
  const now = Date.now()
  await Promise.all(
    names
      .filter(n => n.includes(TMP_MARK))
      .map(async name => {
        try {
          const st = await fsp.stat(path.join(cacheDir, name))
          if (now - st.mtimeMs > TMP_MAX_AGE_MS) {
            await fsp.unlink(path.join(cacheDir, name)).catch(() => {})
          }
        } catch {
          /* already gone */
        }
      })
  )
}
