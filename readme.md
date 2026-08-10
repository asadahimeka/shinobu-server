# Shinobu 服务端漫画翻译 API

> Reference: https://github.com/DonutShinobu/ShinobuTranslator

自建 Node 漫画翻译服务：接收图片 URL → 服务端完成完整漫画翻译管线（检测/OCR/修复/翻译/排版）→ 返回翻译后的 PNG 整图。

- 基础路径：`http://<host>:<port>`（默认 `3000`，可用 `PORT` 环境变量覆盖）
- 鉴权：Bearer Token（`Authorization: Bearer <TOKEN>`；`TOKEN` 未配置时为开放模式）

---

## 1. 翻译图片

### `POST /translate`

请求体（JSON）：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `imageUrl` | string | ✅ | — | 源图片 URL（服务端自行下载，处理 pixiv 防盗链） |
| `sourceLang` | string | 否 | `ja` | 源语言 |
| `targetLang` | string | 否 | `zh-CN` | 目标语言（当前模型为 ja→zh 专用） |
| `translator` | string | 否 | `llm` | `llm`（服务端仅支持 LLM） |
| `llmModel` | string | 否 | 服务端配置 | LLM 模型名，留空用服务端默认 |
| `processMode` | string | 否 | `translate` | `translate` / `erase` / `original` |

**成功响应 `200`**：二进制 PNG（`Content-Type: image/png`）

响应头：

| 头 | 说明 |
|---|---|
| `X-Translate-Cache` | `hit` / `miss`（服务端内容缓存） |
| `X-Translate-Duration` | 翻译耗时（ms） |
| `X-Translate-Regions` | 检测到的文字区域数 |
| `X-Translate-NoText` | 存在且为 `1` 时：未检测到文字，返回原图透传 |

**错误响应**：JSON `{ "error": "<code>", "message": "<中文描述>" }`

| HTTP | error code | 场景 |
|---|---|---|
| 400 | `BAD_REQUEST` | 缺少 `imageUrl` / 请求体非法 |
| 401 | `UNAUTHORIZED` | 无 Token 或 Token 错误 |
| 413 | `IMAGE_TOO_LARGE` | 图片超过大小限制（默认 20MB） |
| 429 | `LLM_RATE_LIMITED` | LLM 限流（含 `Retry-After` 头） |
| 502 | `IMAGE_FETCH_FAILED` | 图片下载失败（网络/404/防盗链） |
| 503 | `BUSY` / `TIMEOUT` | 队列忙 / 排队超时（ONNX 串行执行） |
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
# 翻译一张图片
curl -X POST http://localhost:3000/translate \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"imageUrl": "https://i.pximg.net/.../p0_master1200.jpg"}' \
  -o translated.png

# 健康检查
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/health
```

---

## 4. 行为说明

- **串行队列**：ONNX 会话非线程安全，同一时间只处理一个翻译请求；并发请求排队（超 3 个排队或等待 >60s → 503）。
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
| `MAX_IMAGE_BYTES` | `20MB` | 图片大小上限 |
| `CACHE_DIR` | `.cache/` | 缓存目录 |

---

## 6. 部署

```bash
bash deploy.sh        # 安装系统依赖 + 字体 + 下载模型 + 生成 .env
npm install
npm start       # 启动（--env-file-if-exists=.env 自动加载配置）
```

详见 `deploy.sh`（幂等，可重复执行）。
