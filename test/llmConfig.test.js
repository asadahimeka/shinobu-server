/**
 * llmConfig unit tests (Task 16).
 *
 * Env is set before the dynamic import so config.js resolves deterministic
 * LLM_* values at module load. normalizeChatCompletionsUrl is pure — no env
 * dependence — and mirrors llm.js:493-501 exactly (single trailing slash
 * stripped, `/chat/completions` appended unless already present).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.LLM_BASE_URL = 'https://api.siliconflow.cn/v1'
process.env.LLM_API_KEY = ''
process.env.LLM_MODEL = ''
process.env.LLM_TIMEOUT = ''

const { normalizeChatCompletionsUrl, buildTranslateConfig } = await import('../src/services/llmConfig.js')

test('baseUrl gains /chat/completions suffix', () => {
  assert.equal(
    normalizeChatCompletionsUrl('https://api.siliconflow.cn/v1'),
    'https://api.siliconflow.cn/v1/chat/completions'
  )
})

test('already-suffixed URL is left unchanged', () => {
  const endpoint = 'https://api.siliconflow.cn/v1/chat/completions'
  assert.equal(normalizeChatCompletionsUrl(endpoint), endpoint)
})

test('trailing slash stripped → no double slash; empty → empty', () => {
  assert.equal(
    normalizeChatCompletionsUrl('https://api.siliconflow.cn/v1/'),
    'https://api.siliconflow.cn/v1/chat/completions'
  )
  assert.equal(normalizeChatCompletionsUrl(''), '')
})

test('missing LLM_API_KEY does not throw — config still returned', () => {
  const cfg = buildTranslateConfig()
  assert.equal(cfg.llmApiKey, '')
  assert.equal(cfg.llmBaseUrl, 'https://api.siliconflow.cn/v1/chat/completions')
  assert.equal(cfg.llmModel, 'THUDM/GLM-4-9B-0414')
  assert.equal(cfg.targetLang, 'zh-CN')
  assert.equal(cfg.translator, 'llm')
  assert.equal(cfg.llmProvider, 'custom')
})

test('userOverrides win over config; effective baseUrl normalized post-merge', () => {
  const cfg = buildTranslateConfig({
    llmModel: 'model-x',
    llmApiKey: 'sk-abc',
    llmBaseUrl: 'https://override.example.com/v2/',
    targetLang: 'en',
  })
  assert.equal(cfg.llmModel, 'model-x')
  assert.equal(cfg.llmApiKey, 'sk-abc')
  assert.equal(cfg.llmBaseUrl, 'https://override.example.com/v2/chat/completions')
  assert.equal(cfg.targetLang, 'en')
})
