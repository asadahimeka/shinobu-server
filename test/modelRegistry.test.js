/**
 * modelRegistry LRU 驱逐单元测试。
 *
 * 链路说明：modelRegistry.getModelSession → onnxBridge.createSession →
 * nodeBridge.createSession + nodeBridge.getSessionInfo → ort.InferenceSession.create。
 *
 * 注（task 3 环境适配）：Node 24 的 mock.method 无法重定义 ESM 命名空间导出
 * （module namespace exotic object 的 [[DefineOwnProperty]] 恒抛
 * "Cannot redefine property"），因此不能直接 mock nodeOnnxBridge 命名空间。
 * 改为 mock 最底层可重写的 seam：onnxruntime-node 的 InferenceSession.create
 * （CJS 类的静态方法，configurable:true），mock 沿真实链路生效，
 * created/disposed 断言与 brief 完全一致。
 * ESM 命名空间对象是 frozen，不能直接赋值，必须用 mock.method。
 */
import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { getModelUrlNode } from '../src/pipeline/nodeModelRegistry.js'
import { getModelSession, disposeAllModelSessions } from '../src/translate/shinobu/runtime/modelRegistry.js'

const require = createRequire(import.meta.url)
const ort = require('onnxruntime-node')

/** 绝对 modelUrl → 模型名 key（mock 里把 url 还原成断言用的 key） */
const urlToKey = new Map(
  ['detector', 'inpaint', 'paddleocr_v6_medium_rec', 'bubble'].map(name => [getModelUrlNode(name), name]),
)

/** @type {string[]} */
const created = []
/** @type {string[]} */
const disposed = []

beforeEach(async () => {
  mock.restoreAll()
  mock.method(ort.InferenceSession, 'create', async (modelUrl) => {
    created.push(urlToKey.get(modelUrl))
    return {
      inputNames: ['input'],
      outputNames: ['output'],
      dispose: async () => { disposed.push(urlToKey.get(modelUrl)) },
    }
  })
  await disposeAllModelSessions()
  created.length = 0
  disposed.length = 0
})

test('缓存命中时不重复创建 session', async () => {
  await getModelSession('detector')
  await getModelSession('detector')
  assert.deepEqual(created, ['detector'])
  assert.equal(disposed.length, 0)
})

test('驻留上限默认 1：加载新模型时驱逐旧模型', async () => {
  await getModelSession('detector')
  await getModelSession('inpaint')
  assert.deepEqual(created, ['detector', 'inpaint'])
  assert.deepEqual(disposed, ['detector']) // detector 被挤出
})

test('被驱逐的模型再次请求会重新创建', async () => {
  await getModelSession('detector')
  await getModelSession('inpaint') // 驱逐 detector
  await getModelSession('detector') // 重新创建
  assert.deepEqual(created, ['detector', 'inpaint', 'detector'])
  assert.deepEqual(disposed, ['detector', 'inpaint']) // inpaint 随后也被挤出
})
