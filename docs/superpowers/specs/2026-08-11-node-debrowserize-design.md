# Node 端去浏览器化 + 恢复按需加载 Design

**日期**: 2026-08-11
**状态**: 已确认（brainstorming 完成，用户批准范围）

## 背景

shinobu-server 的 pipeline 是从浏览器项目（ShinobuTranslator）移植的 Node 副本（`src/translate/shinobu/`）。上一轮异步化改造（9 commits）解决了 Cloudflare 超时和 2C2G 资源问题，但留下了浏览器时代的痕迹：dead worker 文件、window shim、probe 预加载、死参数。

用户决策：
- 彻底去浏览器化——不保留 `window` shim、不要 `window.__httpRequest__` 兼容路径，不考虑与浏览器源的关系
- 清理范围：A 类 5 个 dead 文件 + window shim + `__httpRequest__` 分支 + probe 禁用 + 死参数
- B 类 GPU 分支（webgpu/webnn 运行时不可达）**不动**（删了要动推理热路径，风险大收益低）
- probe 禁用方式：`probeRuntime` 改静态/不预加载（保留所有调用点与 await 结构，控制流 diff 最小）
- `MAX_RESIDENT_SESSIONS` 默认回退 4→1（真正按需加载）

## 目标

Node 部署下零浏览器痕迹：不加载浏览器代码、不保留浏览器兼容路径、probe 不再预加载 session、模型按需加载恢复。

## 改动清单

### 1. 删除 5 个 dead 文件

| 文件 | 内容 | 验证 |
|---|---|---|
| `src/translate/shinobu/workers/onnx-worker.js`（1084 行） | onnxruntime-web worker：WASM CDN、localforage 缓存、webgpu powerPreference、graph capture | 无运行时 import（README:28-31 声明 dead） |
| `src/translate/shinobu/runtime/onnxWorkerBridge.js`（485 行） | Comlink Worker 代理、Toast、cache quota 警告 | 同上；还 import `@/lib/vant-apis`（webpack alias，Node 下解析不了） |
| `src/translate/shinobu/workers/gpuPreprocess.js`（338 行） | WGSL GPU letterbox 着色器 | 仅被 onnx-worker.js import |
| `src/translate/shinobu/workers/inferenceQueue.js` | 串行推理队列 | 仅被 onnx-worker.js import |
| `src/translate/shinobu/runtime/selfCheck.js` | 浏览器能力自检（navigator.gpu/ml） | 仅 JSDoc 引用 |

**注意**：`runtime/onnxWorkerTypes.js` **保留**（它是类型定义，被 `onnxBridge.js` 的 JSDoc 引用；需确认删除 dead 文件后无残留引用报错）。

### 2. 移除 window shim + `__httpRequest__` 分支

- `src/services/translateService.js:55-57`：删 `globalThis.window = globalThis`（含 51-52 注释）
- `src/translate/shinobu/translators/llm.js:525-538`：删 `if (window.__httpRequest__)` 分支，只留 fetch 路径
- `src/translate/shinobu/translators/googleWeb.js:82-95`：删 `if (window.__httpRequest__)` 分支，只留 fetch 路径（含 `COMMON_PROXY` 之后逻辑）

**验证过的安全边界**：
- `translate.js:68` 的 `/context[_\s-]*(?:length|window)/iu` 是**正则匹配文本**（LLM 错误分类），非 window 对象引用，不动
- 全 repo Node 可达路径无其他 `window` 引用（已 grep）

### 3. probe 禁用（probeRuntime 改静态，不预加载）

`src/translate/shinobu/index.js`：
- `probeRuntime(model)`（321-356 行）：不再调 `getModelSession`/`preparePaddleOcrRuntime` 创建 session，改为返回静态结果：
  ```js
  { model, enabled: true, provider: 'wasm', detail: `${model} 模型已加载 (wasm)` }
  ```
- `probePaddleOcrRuntime()`（283-315 行）：不再调 `warmupPaddleOcrRuntime`/`preparePaddleOcrRuntime`，返回静态 OCR 结果（`model: 'ocr', enabled: true, provider: 'wasm', detail: 'Paddle OCR 就绪 (CPU)'`）
- 所有调用点（614/657-665/716-724/735-751/774-798/795/835 行）与 await 结构**保持原样**——probe 变成"纯诊断静态数据"，不触发 session 创建
- `runtimeStages` 数组保留（静态数据；消费方 test-pipeline.mjs 只读不依赖具体值）

**效果**：LRU 驱逐竞态根因（probe 并发创建 session）消失；模型加载从"probe 预加载"移到"stage 首次使用时"。

### 4. `MAX_RESIDENT_SESSIONS` 默认 4→1

- `src/translate/shinobu/runtime/modelRegistry.js:130`：默认回退 `|| 1`
- 该处注释改为按需加载语义（删掉 final-review 加的"probe 并发风险，4 模型全驻留"理由）
- `test/modelRegistry.test.js:21` 的 `process.env.MAX_RESIDENT_SESSIONS = '1'` 保留（与默认一致，无害；或删掉——实现者二选一，测试逻辑不变）
- `readme.md §6.5`：改回"默认驻留 1 个模型，按需加载，`MAX_RESIDENT_SESSIONS` 可调"，删掉"4 模型全驻留 ~360MB"表述

### 5. 清理死参数

- `src/translate/shinobu/index.js:801`：不再传 `compactActiveBatch: config.ocrCompactActiveBatch`
- `src/translate/shinobu/pipeline/ocr/index.js:179`（`_options` 参数）：同步删除
- `src/translate/shinobu/types.js:335` 的 `compactActiveBatch` 属性 JSDoc：同步删除

## 风险面

| 风险 | 缓解 |
|---|---|
| probe 静态化改变模型加载时序 | 正确性不变（stage 首次使用时加载），仅延迟从 probe 移到 stage；await 结构保留，控制流零改动 |
| 删 window shim 后漏网 `window` 引用 | 已 grep 全 repo Node 可达路径，仅 llm.js/googleWeb.js 两处 + translate.js 正则（非对象引用） |
| 删 dead 文件后 `onnxWorkerTypes.js` 残留引用 | 保留该类型文件；实现时跑 `lsp_diagnostics` 验证无断裂 |
| `runtimeStages` 变静态后消费方异常 | 唯一消费方 test-pipeline.mjs 只打印，不依赖具体值 |

## 测试

- 现有 45 测试应全绿（无测试依赖被删文件/probe 预加载/runtimeStages 非空）
- 新增回归测试（可选但推荐）：
  - `test/modelRegistry.test.js`：probe 静态化后 `getModelSession` 不被 probe 触发（现有 LRU 测试已隐式覆盖——probe 不再创建 session）
  - llm.js 删分支后走 fetch：现有测试无直接覆盖，靠 http 集成测试间接覆盖（stub 不走 llm）
- 最终：`npm test` 全绿 + `lsp_diagnostics` 干净 + `node --check` 各改动文件

## 非目标（明确不做）

- B 类 GPU 分支（onnxDetect.js:974-1023、inpaint.js:404-448、paddleocrProvider.js:127-196 的 webgpu/webnn/cuda 分支）——运行时不可达，删了要动推理热路径
- `warmedPaddleSessionIds` 等纯内存死数据——顺带清理可做可不做，不单列
- 前端（pixiv-viewer）适配——独立仓库，不在本计划
