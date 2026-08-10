#!/usr/bin/env node
/**
 * @file test-pipeline.mjs — task 1b spike: run the shinobu manga
 * translation pipeline entirely in Node (CPU, onnxruntime-node) against a
 * Japanese manga page.
 *
 * Wires the three server seam modules into the server-hosted pipeline copy:
 *   - nodePlatform            → src/pipeline/nodePlatform.js (node-canvas)
 *   - nodeOnnxBridge          → src/pipeline/nodeOnnxBridge.js (via the
 *                               copy's runtime/onnxBridge.js wrapper)
 *   - nodeModelRegistry       → src/pipeline/nodeModelRegistry.js (via
 *                               the copy's runtime/modelRegistry.js wrapper)
 *
 * Usage: LLM_API_KEY=xxx node test-pipeline.mjs <jp-image> [--stub-llm]
 *   (LLM_API_KEY from the environment — the .env / server config.js
 *   convention; when unset a stub key is used and translations degrade to
 *   source text with a warning.)
 *
 * Evidence outputs (inside , gitignored):
 *   .qa-evidence/task-1-result.png        — resultCanvas (translated page)
 *   .qa-evidence/task-1-stages.json       — stageTimings + region dump
 *   .qa-evidence/task-1-textmetrics.log   — node-canvas measureText probe
 *
 * GPL-3.0-only — pipeline copy derived from ShinobuTranslator (GPL-3.0).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Node global shims — MUST run before any pipeline module import
// ---------------------------------------------------------------------------
// llm.js / googleWeb.js check `window.__httpRequest__` unguarded. In Node only
// fetch exists; pointing `window` at globalThis makes `window.__httpRequest__`
// undefined → both translators take their fetch() path.
if (!('window' in globalThis)) {
  globalThis.window = globalThis
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = path.join(__dirname, '.qa-evidence')
mkdirSync(EVIDENCE_DIR, { recursive: true })

// eslint-disable-next-line import/first
import { nodePlatform } from './src/pipeline/nodePlatform.js'
// eslint-disable-next-line import/first
import { runPipeline } from './src/translate/shinobu/index.js'

const FONT_PATH = path.join(__dirname, 'fonts', 'SourceHanSansSC-Regular.otf')
if (existsSync(FONT_PATH)) {
  // Family must match drawTypeset.js defaultFontFamily 'MTX-SourceHanSans-CN'.
  nodePlatform.registerFont(FONT_PATH, 'MTX-SourceHanSans-CN')
  console.log(`[font] registered ${FONT_PATH} as "MTX-SourceHanSans-CN"`)
} else {
  console.warn('[font] SourceHanSansSC-Regular.otf not found — typeset may fall back to sans-serif')
}

function buildConfig() {
  const realKey = process.env.LLM_API_KEY || ''
  const apiKey = realKey || 'sk-stub-invalid-key'
  if (!realKey) {
    console.warn('[config] LLM_API_KEY 未设置 — 使用 stub key，翻译将退化为保留原文')
    console.warn('[config] 用法: LLM_API_KEY=xxx node test-pipeline.mjs <img>')
  }
  return {
    sourceLang: 'ja',
    targetLang: 'zh-CN',
    translator: 'llm',
    llmProvider: 'custom',
    llmAuthMode: 'api_key',
    llmBaseUrl: 'https://api.siliconflow.cn/v1',
    llmApiKey: apiKey,
    llmModel: 'THUDM/GLM-4-9B-0414',
    ocrEngine: 'paddleocr_v6_medium',
    processMode: 'translate',
    ocrPostFilter: 'balanced',
    typesetDebug: false,
    eraseDebug: false,
    collectDebugLog: false,
  }
}

function toErrorDetail(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

async function main() {
  const argv = process.argv.slice(2)
  const imagePath = argv.find(arg => !arg.startsWith('-'))
  if (!imagePath || !existsSync(imagePath)) {
    console.error('用法: node test-pipeline.mjs <日文漫画图片>')
    process.exit(1)
  }

  console.log('======================================================')
  console.log('task 1b spike — shinobu pipeline on Node (CPU)')
  console.log(`image: ${imagePath}`)
  console.log('======================================================')

  // --- textmetrics probe (node-canvas measureText is width-only) ---
  const metricsProbe = probeTextMetrics()

  // --- build File and config ---
  const bytes = readFileSync(imagePath)
  const fileName = path.basename(imagePath)
  const file = new File([bytes], fileName, { type: 'image/png' })
  const config = buildConfig()
  console.log(`[config] translator=llm baseUrl=${config.llmBaseUrl} model=${config.llmModel} apiKey=${config.llmApiKey.slice(0, 8)}...`)

  // --- run pipeline ---
  const startedAt = Date.now()
  const seenStages = new Set()
  const onProgress = progress => {
    const key = progress.stage
    const isNew = !seenStages.has(key)
    seenStages.add(key)
    const percent = progress.percent !== undefined ? ` ${progress.percent}%` : ''
    console.log(`  [stage${percent}] ${progress.stage} — ${progress.detail}`)
    if (progress.timings && progress.timings.length > 0 && isNew) {
      // Print per-stage timings as they become available
      for (const t of progress.timings) {
        console.log(`      ${t.stage}: ${Math.round(t.durationMs)}ms`)
      }
    }
  }

  let artifacts
  try {
    artifacts = await runPipeline(file, config, onProgress, {
      platform: nodePlatform,
    })
  } catch (error) {
    const detail = toErrorDetail(error)
    console.error(`\n[pipeline] FAILED: ${detail}`)
    if (error && error.artifacts) {
      writeSummary(error.artifacts, imagePath, metricsProbe, 'FAILED', detail)
    }
    process.exit(1)
  }
  const elapsedMs = Date.now() - startedAt

  // --- collect results ---
  const stageTimings = artifacts.stageTimings || []
  const regions = artifacts.detectedRegions || []
  const translatedRegions = regions.filter(r => (r.translatedText || '').trim() !== '')
  const sourceRegions = regions.filter(r => (r.sourceText || '').trim() !== '')
  const resultCanvas = artifacts.resultCanvas

  console.log('\n======================================================')
  console.log('[result] pipeline complete')
  console.log(`  wall time: ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`)
  console.log(`  runtimeStages: ${JSON.stringify(artifacts.runtimeStages || [], null, 2)}`)
  console.log(`  detected regions: ${regions.length} (${sourceRegions.length} with OCR sourceText)`)
  console.log(`  translated regions: ${translatedRegions.length}`)
  console.log('\n  stageTimings:')
  for (const t of stageTimings) {
    console.log(`    ${t.stage}: ${Math.round(t.durationMs)}ms — ${t.label}`)
  }

  console.log('\n  region dump (source → translated):')
  const regionDump = []
  for (const r of regions) {
    const src = (r.sourceText || '').replace(/\s+/g, ' ').trim()
    const tr = (r.translatedText || '').replace(/\s+/g, ' ').trim()
    if (!src && !tr) continue
    const dir = r.direction || 'h'
    const line = `  [${dir}] ${JSON.stringify(src)} → ${JSON.stringify(tr)}`
    console.log(line)
    regionDump.push({ direction: dir, sourceText: src, translatedText: tr, box: r.box })
  }

  // NaN font-size check across typeset outputs
  const nanFontSizes = collectNaNFontSizes(artifacts)
  console.log(`\n  typeset NaN font-size check: ${nanFontSizes.length === 0 ? 'PASS (no NaN)' : `FAIL (${nanFontSizes.length} NaN)`}`)

  // --- save result canvas ---
  const resultPath = path.join(EVIDENCE_DIR, 'task-1-result.png')
  if (resultCanvas && typeof resultCanvas.toBuffer === 'function') {
    writeFileSync(resultPath, resultCanvas.toBuffer('image/png'))
    console.log(`\n[output] resultCanvas → ${resultPath}`)
  } else {
    console.warn('\n[output] resultCanvas has no toBuffer (unexpected platform object)')
  }

  // --- write JSON summary ---
  const textmetricsPath = path.join(EVIDENCE_DIR, 'task-1-textmetrics.log')
  writeFileSync(textmetricsPath, JSON.stringify(metricsProbe, null, 2))
  console.log(`[output] textmetrics → ${textmetricsPath}`)

  const summary = {
    spike: 'task-1b',
    image: imagePath,
    imageSize: `${resultCanvas?.width ?? '?'}x${resultCanvas?.height ?? '?'}`,
    status: 'DONE',
    wallTimeMs: elapsedMs,
    stageTimings,
    runtimeStages: artifacts.runtimeStages || [],
    regionCount: regions.length,
    sourceRegionCount: sourceRegions.length,
    translatedRegionCount: translatedRegions.length,
    nanFontSizes: nanFontSizes.length,
    regions: regionDump,
    translationDebug: artifacts.translationDebug || null,
    textMetricsProbe: metricsProbe,
  }
  const stagesPath = path.join(EVIDENCE_DIR, 'task-1-stages.json')
  writeFileSync(stagesPath, JSON.stringify(summary, null, 2))
  console.log(`[output] summary → ${stagesPath}`)

  console.log('\n[spike] DONE — all stages completed, exit 0')
  process.exit(0)
}

/**
 * Probe node-canvas measureText output shape.
 * @returns {Object} per-font probe result
 */
function probeTextMetrics() {
  const probe = {}
  const canvas = nodePlatform.createCanvas(64, 64)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { error: 'no ctx' }
  }
  for (const [label, fontSize, family] of [
    ['default', 40, 'sans-serif'],
    ['SourceHanSansSC', 40, 'MTX-SourceHanSans-CN'],
  ]) {
    ctx.font = `${fontSize}px ${family}`
    const m = ctx.measureText('国字A1')
    const keys = Object.keys(m)
    const entry = {
      font: ctx.font,
      keys,
      width: m.width,
      actualBoundingBoxAscent: m.actualBoundingBoxAscent,
      actualBoundingBoxDescent: m.actualBoundingBoxDescent,
      actualBoundingBoxLeft: m.actualBoundingBoxLeft,
      actualBoundingBoxRight: m.actualBoundingBoxRight,
      fontBoundingBoxAscent: m.fontBoundingBoxAscent,
      fontBoundingBoxDescent: m.fontBoundingBoxDescent,
      hasVerticalMetrics: Number.isFinite(m.actualBoundingBoxAscent),
      hasOnlyWidth: keys.length === 1 && keys[0] === 'width',
    }
    probe[label] = entry
    console.log(`[textmetrics] ${label}: keys=${JSON.stringify(keys)} width=${m.width} ascent=${m.actualBoundingBoxAscent}`)
  }

  // Verbatim copy of the pipeline's guarded fallback math (fontFitCore /
  // horizontalFit) to prove no NaN when ascent/descent are undefined:
  const finiteMetric = value => (value !== undefined && Number.isFinite(value) ? Math.abs(value) : 0)
  for (const [label, fontSize] of [['default', 40], ['SourceHanSansSC', 40]]) {
    ctx.font = `${fontSize}px ${label === 'default' ? 'sans-serif' : 'MTX-SourceHanSans-CN'}`
    const m = ctx.measureText('国')
    const ascent = finiteMetric(m.actualBoundingBoxAscent)
    const descent = finiteMetric(m.actualBoundingBoxDescent)
    const resolvedAscent = ascent > 0 ? ascent : fontSize * 0.8
    const resolvedDescent = descent > 0 ? descent : fontSize * 0.2
    const metricsOk = Number.isFinite(resolvedAscent) && Number.isFinite(resolvedDescent) && resolvedAscent > 0 && resolvedDescent > 0
    probe[label].fallbackAscent = resolvedAscent
    probe[label].fallbackDescent = resolvedDescent
    probe[label].fallbackProducesNaN = !metricsOk
    console.log(`[textmetrics] ${label}: fallback ascent=${resolvedAscent} descent=${resolvedDescent} → ${metricsOk ? 'OK (no NaN)' : 'NAN!'}`)
  }
  return probe
}

/**
 * Scan the artifacts for NaN font sizes in typeset debug output.
 * @param {Object} artifacts
 * @returns {Array<string>} NaN descriptions
 */
function collectNaNFontSizes(artifacts) {
  const nanFound = []
  const scan = (value, keyPath) => {
    if (typeof value === 'number' && Number.isNaN(value)) {
      nanFound.push(keyPath)
      return
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'number' && Number.isNaN(v)) {
          nanFound.push(`${keyPath}.${k}`)
        } else if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
          scan(v, `${keyPath}.${k}`)
        }
      }
    }
  }
  // Scan region geometries + typeset debug log for any NaN
  for (const r of artifacts.detectedRegions || []) {
    scan(r.box, 'regions.box')
    scan(r.quad, 'regions.quad')
    scan(r.fittedFontSize, 'regions.fittedFontSize')
  }
  scan(artifacts.typesetDebugLog, 'typesetDebugLog')
  return nanFound
}

function writeSummary(artifacts, imagePath, metricsProbe, status, errorDetail) {
  const summary = {
    spike: 'task-1b',
    image: imagePath,
    status,
    error: errorDetail,
    stageTimings: artifacts.stageTimings || [],
    runtimeStages: artifacts.runtimeStages || [],
    regionCount: (artifacts.detectedRegions || []).length,
    textMetricsProbe: metricsProbe,
  }
  writeFileSync(
    path.join(EVIDENCE_DIR, 'task-1-stages.json'),
    JSON.stringify(summary, null, 2)
  )
  writeFileSync(
    path.join(EVIDENCE_DIR, 'task-1-textmetrics.log'),
    JSON.stringify(metricsProbe, null, 2)
  )
}

main().catch(error => {
  console.error('[spike] uncaught:', toErrorDetail(error))
  process.exit(1)
})
