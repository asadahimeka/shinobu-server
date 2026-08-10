# Shinobu 服务端漫画翻译 API

> Reference: https://github.com/DonutShinobu/ShinobuTranslator

自建 Node 漫画翻译服务：接收图片 URL → 服务端完成完整漫画翻译管线（检测/OCR/修复/翻译/排版）→ 返回翻译后的 PNG 整图。

- 基础路径：`http://<host>:<port>`（默认 `3000`，可用 `PORT` 环境变量覆盖）
- 鉴权：Bearer Token（`Authorization: Bearer <TOKEN>`；`TOKEN` 未配置时为开放模式）

---

## 1. 翻译图片（异步）

### `POST /translate`

请求体（JSON）不变：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `imageUrl` | string | ✅ | — | 源图片 URL（服务端自行下载，处理 pixiv 防盗链） |
| `sourceLang` | string | 否 | `ja` | 源语言 |
| `targetLang` | string | 否 | `zh-CN` | 目标语言（当前模型为 ja→zh 专用） |
| `translator` | string | 否 | `llm` | `llm`（服务端仅支持 LLM） |
| `llmModel` | string | 否 | 服务端配置 | LLM 模型名，留空用服务端默认 |
| `processMode` | string | 否 | `translate` | `translate` / `erase` / `original` |

**成功响应 `202 Accepted`**：

```json
{ "id": "<jobId>", "status": "queued" }
```

### `GET /translate/jobs/:jobId` — 查询状态

| status | 说明 | 附加字段 |
|---|---|---|
| `queued` | 已受理，等待执行 | — |
| `running` | 执行中 | `stage`、`percent` |
| `done` | 完成 | `resultMeta: {regions, durationMs, noText, cacheHit}` |
| `failed` | 失败 | `error`（错误码）、`message` |

job 不存在 → `404 {error:'JOB_NOT_FOUND'}`

### `GET /translate/jobs/:jobId/result` — 取结果

`done` 时返回 `200` 二进制 PNG（`Content-Type: image/png`）+ 原 `X-Translate-*` 头：

| 头 | 说明 |
|---|---|
| `X-Translate-Cache` | `hit` / `miss`（服务端内容缓存） |
| `X-Translate-Duration` | 翻译耗时（ms） |
| `X-Translate-Regions` | 检测到的文字区域数 |
| `X-Translate-NoText` | 存在且为 `1` 时：未检测到文字，返回原图透传 |

`failed` → `409 {error:'JOB_FAILED', message, detail}`（`detail` 为原始错误码，客户端应停止轮询）；
未完成 → `409 {error:'JOB_NOT_READY'}`；不存在 → `404 JOB_NOT_FOUND`。

任务 30 分钟后自动清理。

**错误响应**：JSON `{ "error": "<code>", "message": "<中文描述>" }`

| HTTP | error code | 场景 |
|---|---|---|
| 400 | `BAD_REQUEST` | 缺少 `imageUrl` / 请求体非法 |
| 401 | `UNAUTHORIZED` | 无 Token 或 Token 错误 |
| 404 | `JOB_NOT_FOUND` | 任务不存在 / 结果已被清理 |
| 409 | `JOB_NOT_READY` | 任务未完成，不可取结果 |
| 409 | `JOB_FAILED` | 任务已失败（`detail` 字段带原始错误码） |
| 413 | `IMAGE_TOO_LARGE` | 图片超过大小限制（默认 10MB） |
| 429 | `LLM_RATE_LIMITED` | LLM 限流（含 `Retry-After` 头） |
| 502 | `IMAGE_FETCH_FAILED` | 图片下载失败（网络/404/防盗链） |
| 503 | `BUSY` / `TIMEOUT` | ~~队列忙/排队超时~~ → 现为 job 的 `failed` 状态（`error:'BUSY'/'TIMEOUT'`），HTTP 层不再返回 |
| 500 | `LLM_CONFIG_MISSING` | 服务端未配置 LLM key |
| 500 | `PIPELINE_FAILED` | 翻译管线阶段失败（含 `stage` 字段） |
| 500 | `INTERNAL` | 其他内部错误 |

---

## 2. 健康检查

### `GET /health`

```json
{
  "status": "ok",
  "models": {
    "detector": "loaded",
    "bubble": "loaded",
    "ocr": "loaded",
    "inpaint": "loaded"
  }
}
```

同样受鉴权保护（未配置 Token 时开放）。

---

## 3. 请求示例

```bash
# 提交翻译任务（异步，立即返回 job id）
curl -X POST http://localhost:3000/translate \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"imageUrl": "https://i.pximg.net/.../p0_master1200.jpg"}'

# 轮询任务状态（直到 done）
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/translate/jobs/<jobId>

# 任务 done 后下载结果 PNG
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/translate/jobs/<jobId>/result \
  -o translated.png

# 健康检查
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/health
```

---

## 4. 行为说明

- **串行队列**：ONNX 会话非线程安全，同一时间只处理一个翻译任务；并发任务排队（超 3 个排队或等待 >60s → job 以 `failed` 状态结束，`error:'BUSY'/'TIMEOUT'`）。
- **缓存**：服务端按图片内容 sha256 + 配置签名缓存结果（`.cache/`，LRU 500 条）；同图同配置二次请求命中缓存（<1s）。
- **LLM**：任意 OpenAI 兼容端点（服务端配置 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`）。
- **图片下载**：服务端带 `Referer: https://www.pixiv.net/` 下载；若网络无法直连 pixiv CDN，配置 `IMAGE_PROXY` 前缀代理。
- **CORS**：允许跨域（前端 localhost:8080 → 服务端），鉴权仍由 Bearer Token 保证。

---

## 5. 配置（`.env`，自动加载）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `TOKEN` | 空 | Bearer 鉴权 Token（空 = 开放） |
| `LLM_BASE_URL` | 空 | OpenAI 兼容端点（如 `https://api.siliconflow.cn/v1`） |
| `LLM_API_KEY` | 空 | LLM key（缺省时翻译返回 `LLM_CONFIG_MISSING`） |
| `LLM_MODEL` | `THUDM/GLM-4-9B-0414` | 模型名 |
| `IMAGE_PROXY` | 空 | 图片下载前缀代理 |
| `MAX_IMAGE_BYTES` | `10MB` | 图片大小上限 |
| `CACHE_DIR` | `.cache/` | 缓存目录 |

---

## 6. 部署

```bash
bash deploy.sh        # 安装系统依赖 + 字体 + 下载模型 + 生成 .env
npm install
npm start       # 启动（--env-file-if-exists=.env 自动加载配置）
```

详见 `deploy.sh`（幂等，可重复执行）。

---

## 6.5 低配部署（2C2G 建议）

- `ORT_THREADS=1`：ONNX 推理单线程，留一核给 HTTP/LLM（默认已是 1）
- `MAX_IMAGE_BYTES=10m`（默认已是 10MB）
- 模型按需加载：默认同时驻留 1 个模型（`MAX_RESIDENT_SESSIONS` 可调），
  2GB 内存峰值约 600MB-1GB，**务必配置 2-4GB swap**
- 异步 API 已规避 Cloudflare 100s / nginx 60s 超时：HTTP 请求 <100ms 返回，
  慢任务后台执行，客户端轮询
- nginx 如仍要调大：`proxy_read_timeout 300s;` 仅影响直连场景
