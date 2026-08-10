/**
 * Server configuration.
 *
 * Precedence (low → high):
 *   1. Built-in defaults below
 *   2. process.env (PORT, TOKEN, LLM_*, IMAGE_PROXY, CACHE_DIR, MAX_IMAGE_BYTES, FONT_PATH)
 *   3. config.json override (gitignored) — merged over the env-derived object
 *
 * Usage:
 *   import config from './config.js'
 *
 * Smoke test (prints the resolved config object):
 *   node config.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Parse a byte-size value: plain number (bytes), or "20mb"/"20MB"/"2048kb" style.
 * Falls back to `fallback` when unparseable.
 *
 * @param {string|number|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function parseBytes(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(String(value).trim())
  if (!m) return fallback
  const table = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3 }
  return Math.floor(parseFloat(m[1]) * table[(m[2] || 'b').toLowerCase()])
}

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 20MB

const config = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  TOKEN: process.env.TOKEN || '',
  LLM_BASE_URL: process.env.LLM_BASE_URL || '',
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  LLM_MODEL: process.env.LLM_MODEL || 'THUDM/GLM-4-9B-0414',
  LLM_TIMEOUT: parseInt(process.env.LLM_TIMEOUT, 10) || 60000,
  IMAGE_PROXY: process.env.IMAGE_PROXY || '',
  CACHE_DIR: process.env.CACHE_DIR || '.cache/',
  MAX_IMAGE_BYTES: parseBytes(process.env.MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES),
  FONT_PATH: process.env.FONT_PATH || ''
}

// Optional config.json override (gitignored — local deployments only)
const configPath = path.join(__dirname, 'config.json')
if (fs.existsSync(configPath)) {
  try {
    const override = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    Object.assign(config, override)
  } catch (err) {
    console.warn(`[config] failed to read ${configPath}: ${err.message}`)
  }
}

export default config

// Print config when executed directly: `node config.js`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(config, null, 2))
}
