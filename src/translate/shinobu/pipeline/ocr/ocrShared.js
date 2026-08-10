/**
 * @file Load and cache the dictionary character set used by Paddle CTC recognizer.
 *
 * Mechanically converted from ShinobuTranslator
 * `src/pipeline/ocr/ocrShared.ts` (TS → JS).
 *
 * Browser-only — the Node branch (ocrSharedNode.ts) has been removed per plan.
 * pixiv-viewer is a browser-only webpack app; dict files are fetched via
 * fetch() from `public/models/` or CDN (resolved by modelRegistry).
 */

/** @type {Map<string, Promise<Array<string>|null>>} */
const charsetCache = new Map()

/**
 * Load and cache the character set from a dictionary URL.
 * @param {string} [dictUrl] - Dictionary file URL (e.g., './models/paddleocr_v6_dict.txt')
 * @returns {Promise<Array<string>|null>} Array of characters, or null on failure
 */
export async function loadCharset(dictUrl) {
  if (!dictUrl) {
    return null
  }
  const cached = charsetCache.get(dictUrl)
  if (cached) {
    return cached
  }
  const promise = (async () => {
    // Server wiring (task 1b): the Node modelRegistry resolves dictUrl to an
    // absolute filesystem path — Node's fetch cannot load non-http URLs. Read
    // via fs when the URL is not http(s); browser keeps the fetch() path.
    const text = /^https?:\/\//iu.test(dictUrl)
      ? await fetchDictText(dictUrl)
      : await readFileText(dictUrl)
    if (text === null) {
      return null
    }
    const lines = text
      .split(/\r?\n/g)
      .filter(line => line.length > 0)
    return lines.length > 0 ? lines : null
  })()
  charsetCache.set(dictUrl, promise)
  return promise
}

/**
 * Fetch a dict file over http(s) (browser path).
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function fetchDictText(url) {
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    return null
  }
  return response.text()
}

/**
 * Read a dict file from the local filesystem (Node-only helper).
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function readFileText(filePath) {
  const fs = await import('node:fs/promises')
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    console.warn(`[ocr] 字典文件读取失败: ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
