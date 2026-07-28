# Phase 19 概览 — LLM 模型厂商配置页

## 问题
用户发现「LLM 模型厂商配置」没有接入 app：此前只能从环境变量 `CHATQUERY_LLM_*` 读，且进程启动时一次性固定。打包后双击打开无法设环境变量 → LLM 永远"未配置"；改厂商/模型必须改 env + 重启；只有 OpenAI 兼容一个形状，无法选阿里云/腾讯云/Anthropic 等；ADR-004 又禁止明文落盘。

## 做了什么
1. **厂商预设 + 协议抽象**（`src/config.rs`）
   - `LlmProvider` 枚举：`OpenAi` / `Anthropic`。
   - `VENDOR_PRESETS`：OpenAI、阿里云通义千问、腾讯云混元、DeepSeek、智谱 GLM、OpenRouter、Ollama、Anthropic、自定义。每个含 `base_url` + 默认 `model`，前端下拉选厂商自动填充。
   - `LlmConfig` 新增 `provider` / `vendor` 字段；保留 `from_env()` 作 dev 回退。

2. **多协议客户端**（`src/llm/client.rs`）
   - `stream_chat` 按 `provider` 分发。OpenAI 兼容走原逻辑（覆盖所有 OpenAI-shape 厂商）。
   - 新增 `stream_chat_anthropic`：`x-api-key` + `anthropic-version` 鉴权、顶层 `system`、Assistant `tool_use` block、Tool→`user` 消息内 `tool_result` block、SSE 解析 `text_delta` / `input_json_delta`。

3. **运行时可变配置 + 加密落盘**（Tauri 端）
   - `AppState.llm` 改为 `Mutex<LlmConfig>`；新增命令 `get_llm_config` / `get_vendor_presets` / `save_llm_config`。
   - `LlmConfig::load()` 从 `~/.config/chatquery/llm.json` 读取（`api_key` 经 `crypto` AES-256-GCM 解密，复用 ADR-010 密钥文件）；无文件回退 `from_env`。
   - `save_llm_config` 持久化（`api_key` 加密，非敏感字段明文）。**api_key 不回传前端**，表单留空即保留已存密钥。

4. **前端设置页**（`frontend/src`）
   - `App.tsx`：侧栏加 ⚙ 按钮打开设置弹窗（厂商下拉 / API Base URL / 模型 / API Key 密码框），保存后刷新状态栏。
   - `types.ts` + `api.ts`：新增 `LlmConfigDto` / `VendorPreset` / `LlmConfigInput` 及对应命令调用。

## 验证
- `cargo check`（lib + TUI）✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `npm run build` ✅
- `cargo test` 16/16 ✅

## 已知限制 / 待办
- **Anthropic 分支为静态实现，未经真实 API 联调**（沙箱无密钥 / 无 TTY）。逻辑按官方协议实现，但首次实跑可能需微调。
- 未做 OS keychain，沿用 AES 文件加密（ADR-010 记录的"未来可选"）。
- `from_env` 仍保留，`CHATQUERY_LLM_VENDOR=anthropic` 可 dev 直连 Anthropic。
