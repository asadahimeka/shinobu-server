# src/translate/shinobu/ — Node-hosted copy of the browser Shinobu pipeline

This directory is a **server-side copy** of the browser manga-translation pipeline
`src/utils/translate/shinobu/` (65 files, copied verbatim, derivation headers kept —
the pipeline is derived from ShinobuTranslator, GPL-3.0).

The **source** `src/utils/translate/shinobu/` is READ-ONLY (project rule). The server
HTTP layer (tasks 5/10) and this spike (task 1b) host the pipeline in Node by editing
**this copy only**.

## Wiring applied (task 1b spike)

| File in copy | Change |
|---|---|
| `index.js` | `const platform = options.platform ?? browserPlatform` (3-line platform injection) |
| `runtime/onnxBridge.js` | **Replaced** — re-exports the Node ONNX bridge `src/pipeline/nodeOnnxBridge.js`; converts pipeline TensorTransport `{data,dims,type}` ↔ onnxruntime-node `ort.Tensor` |
| `runtime/modelRegistry.js` | **Replaced** — wraps `src/pipeline/nodeModelRegistry.js` (absolute paths, `['cpu']` runtime) + session cache dedup |
| `pipeline/image.js` | `fileToImage`: Node fallback — no `FileReader`, uses `File.arrayBuffer()` → Buffer → `platform.loadImage(Buffer)` |
| `pipeline/ocr/ocrShared.js` | `loadCharset`: absolute filesystem paths read via `fs` instead of `fetch()` |
| `translators/googleWeb.js` | Removed webpack alias import `@/consts` → inline `COMMON_PROXY` (never used in server mode) |
| `pipeline/translate.js` | LLM per-region fallback: translation failure degrades to `sourceText` (keep original text) instead of throwing |

Also required (seam extension, not in this copy):
`src/pipeline/nodeOnnxBridge.js` gained an additive `getSessionInfo(sessionId)`
accessor returning `{ inputNames, outputNames }` — the pipeline handle contract needs
real tensor names, which the T1a-2 seam verification never exercised.

## Never imported in Node (dead code here)

`runtime/onnxWorkerBridge.js`, `workers/onnx-worker.js`, `workers/gpuPreprocess.js`
(Comlink/onnxruntime-web/localforage). The browser `onnxBridge.js` lazy-loads the
worker bridge; the Node replacement never does.
