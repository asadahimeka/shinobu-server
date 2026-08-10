/**
 * Path helpers — single source of truth for the server root.
 *
 * The server is a fully self-contained deployable (copy `` alone to a
 * machine and it must work): every filesystem path resolves under `` or
 * via an explicit env override. `serverRoot` is computed from `import.meta.url`
 * (NOT process.cwd()), so behaviour is identical regardless of the working
 * directory the process is launched from.
 *
 * Resolution convention shared by every path consumer in this repo:
 *   - absolute paths pass through untouched (env overrides like `MODELS_DIR`,
 *     `CACHE_DIR`, `FONT_PATH`)
 *   - relative paths resolve against `serverRoot`
 *
 * GPL-3.0-only.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Absolute path to the  root (src/util → up 2 = ). */
export const serverRoot = path.resolve(__dirname, '..', '..')

/**
 * Resolve a configured path: absolute passes through; relative resolves
 * against the server root.
 * @param {string} p
 * @returns {string}
 */
export function resolveFromServerRoot(p) {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(serverRoot, p)
}
