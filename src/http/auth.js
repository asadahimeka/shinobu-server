/**
 * Bearer token authentication middleware (Task 5).
 *
 * Token comes from `config.TOKEN` (server/config.js — env / config.json).
 *
 * Modes:
 *   - TOKEN set     → `Authorization: Bearer <token>` must match exactly.
 *                     Missing or wrong token → 401 {error:'UNAUTHORIZED'}.
 *   - TOKEN empty   → documented OPEN MODE: every request is allowed, so a
 *                     fresh deployment boots without configuration. Set a
 *                     token to protect the endpoints.
 *
 * Comparison is constant-time (crypto.timingSafeEqual) so token length/prefix
 * can't be probed via timing side channels.
 */
import crypto from 'node:crypto'
import config from '../../config.js'

/**
 * Constant-time string equality (length-short-circuit, then timingSafeEqual).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Express auth middleware. Applies to every route it is mounted on.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function authMiddleware(req, res, next) {
  const expected = config.TOKEN
  // Open mode — no token configured, allow all requests.
  if (!expected) return next()

  const header = req.headers.authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match || !safeEqual(match[1], expected)) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: '缺少或无效的访问令牌',
    })
  }
  next()
}
