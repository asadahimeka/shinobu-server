/**
 * @file Node.js PlatformProvider — uses node-canvas (npm package "canvas").
 *
 * All canvas/image operations are routed through the node-canvas library
 * (Cairo-based implementation of the Canvas API) and returned as native
 * node-canvas objects — the pipeline consumes them directly, same as the
 * browser platform returns native DOM objects.
 *
 * Mirrors the browser PlatformProvider semantics in
 * src/utils/translate/shinobu/runtime/browserPlatform.js:
 *   - createCanvas/loadImage/createImageData return native objects
 *   - loadImage resolves a loaded Image (node-canvas `loadImage` accepts
 *     file paths, data URLs, Buffers and canvas instances — superset of the
 *     browser's data-URL behavior)
 *   - fonts are available immediately after registerFont on Node, so
 *     waitForFonts resolves synchronously (browser waits on document.fonts)
 *
 * Ported from ShinobuTranslator `benchmark/nodePipelinePlatform.ts`
 * (TS → JS). The PlatformProvider typedef lives in
 * src/utils/translate/shinobu/runtime/platform.js; the import below is
 * doc-only.
 *
 * measureText note (verified empirically against canvas@3.2.3, 2026-08-09):
 * node-canvas `measureText()` returns `actualBoundingBoxLeft/Right/Ascent/
 * Descent`, `emHeightAscent/Descent` and `alphabeticBaseline` — NOT the
 * width-only stub of node-canvas 2.x. The typeset stage reads those fields
 * and its own `Number.isFinite`/`?? 0` guards make it version-proof, so NO
 * measureText shim is needed here. `fontBoundingBoxAscent/Descent` are NOT
 * returned by node-canvas (falls back to `?? 0` → em-box/`fontSize` in
 * resolveFontVerticalAdvance). Verified: 0 NaN font sizes across the whole
 * pipeline (task 1b).
 *
 * createImageBitmap: intentionally NOT provided. The pipeline only calls it
 * on the WebGPU detect path (`onnxDetect.js`, guarded by
 * `provider === 'webgpu'`); on Node the probe reports `wasm` (CPU), so that
 * branch is unreachable. `runDetectWithGpuPreprocess` rejects with
 * UNSUPPORTED_ON_CPU as a safety net.
 */

/** @typedef {import('../translate/shinobu/runtime/platform.js').PlatformProvider} PlatformProvider */

import { createCanvas, loadImage, registerFont, Image, ImageData } from 'canvas'

/**
 * Node.js PlatformProvider: native canvas / Image / ImageData via node-canvas.
 *
 * @type {PlatformProvider}
 */
export const nodePlatform = {
  createCanvas(width, height) {
    const canvas = createCanvas(width, height)
    // Fail fast if Cairo's 2d context is silently missing (would otherwise
    // surface as NaN text metrics / blank output far downstream).
    if (!canvas.getContext('2d')) {
      throw new Error('node-canvas: 2d context unavailable')
    }
    return canvas
  },

  createImage() {
    return new Image()
  },

  async loadImage(src) {
    return loadImage(src)
  },

  createImageData(width, height) {
    return new ImageData(width, height)
  },

  registerFont(path, family) {
    // node-canvas registerFont takes a fontFace object { family, weight?, style? }
    registerFont(path, { family })
  },

  waitForFonts() {
    // node-canvas fonts are available immediately after registerFont;
    // no async waiting needed unlike browser's document.fonts.ready.
    return Promise.resolve()
  },
}

export { createCanvas, loadImage, registerFont, Image, ImageData }
