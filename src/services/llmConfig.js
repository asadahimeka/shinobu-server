/**
 * LLM configuration builder (Task 7).
 *
 * Builds the shinobu-pipeline-compatible translation config from server config,
 * supporting any OpenAI-compatible endpoint.
 *
 * Config precedence (low → high):
 *   1. Built-in defaults below
 *   2. server/config.js values (env / config.json)
 *   3. userOverrides (per-request overrides such as targetLang / llmModel)
 *
 * Contract alignment:
 *   - Pipeline config keys llmProvider / llmAuthMode / llmBaseUrl / llmApiKey /
 *     llmModel — see src/utils/translate/shinobu/types.js PipelineConfig typedef
 *   - Frontend provider keys baseUrl / apiKey / model / authMode — see
 *     src/store/index.js mangaTrans.providers (spread-merged into the pipeline config)
 *
 * Missing LLM_API_KEY is NOT fatal here: the config is still returned and the
 * translation stage reports `{ error: 'LLM_CONFIG_MISSING' }` later at request time.
 */
import config from '../../config.js'

const DEFAULT_MODEL = 'THUDM/GLM-4-9B-0414'
const DEFAULT_TIMEOUT = 60000
const DEFAULT_TARGET_LANG = 'zh-CN'

/**
 * Normalize an OpenAI-compatible base URL into a full chat-completions endpoint.
 *
 * Mirrors the exact logic of src/utils/translate/shinobu/translators/llm.js:493-501:
 * strip a trailing slash, then append `/chat/completions` unless already present
 * (no double slash, no duplicate suffix).
 *
 * @param {string} baseUrl - e.g. 'https://api.siliconflow.cn/v1'
 * @returns {string} e.g. 'https://api.siliconflow.cn/v1/chat/completions'
 */
export function normalizeChatCompletionsUrl(baseUrl) {
  if (!baseUrl) return ''
  const trimmed = baseUrl.replace(/\/$/, '')
  return trimmed.endsWith('/chat/completions')
    ? trimmed
    : `${trimmed}/chat/completions`
}

/**
 * Build the pipeline translation config.
 *
 * The returned object is the seed config T10 extends: the non-LLM stages
 * (sourceLang / targetLang / translator / processMode / ocrEngine / ...) plus
 * the LLM block. `llmBaseUrl` is normalized to the full chat-completions
 * endpoint so any OpenAI-compatible server works out of the box.
 *
 * @param {Object} [userOverrides] - Per-request overrides (highest precedence).
 *   Recognized keys (pipeline contract): targetLang, translator, processMode,
 *   ocrEngine, ocrPostFilter, typesetDebug, eraseDebug, collectDebugLog,
 *   llmModel, llmBaseUrl, llmApiKey, llmTimeout.
 * @returns {Object} PipelineConfig-shaped translation config
 */
export function buildTranslateConfig(userOverrides = {}) {
  const merged = {
    // non-LLM seed config (T10 extends this)
    sourceLang: 'ja',
    targetLang: DEFAULT_TARGET_LANG,
    translator: 'llm',
    processMode: 'translate',
    ocrEngine: 'paddleocr_v6_medium',
    ocrPostFilter: 'balanced',
    typesetDebug: false,
    eraseDebug: false,
    collectDebugLog: false,
    // LLM block — shinobu PipelineConfig typedef + frontend providers contract
    llmProvider: 'custom',
    llmAuthMode: 'api_key',
    llmBaseUrl: config.LLM_BASE_URL || '',
    llmApiKey: config.LLM_API_KEY || '',
    llmModel: config.LLM_MODEL || DEFAULT_MODEL,
    // Exposed for the HTTP request layer (not part of the shinobu PipelineConfig typedef)
    llmTimeout: config.LLM_TIMEOUT || DEFAULT_TIMEOUT,
    // userOverrides win over config.js values
    ...userOverrides,
  }
  // Normalize the effective base URL (post-merge, so overrides benefit too)
  merged.llmBaseUrl = normalizeChatCompletionsUrl(merged.llmBaseUrl)
  return merged
}
