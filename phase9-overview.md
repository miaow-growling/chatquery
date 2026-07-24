# Phase 9 — Tauri 桌面端落地

## 背景

用户确认放弃纯 TUI，转向桌面应用，核心诉求是 **SQL 编辑时的自动提示/补全**。
Tauri v2（系统 WebView + Rust 命令层）可在**零后端重写**的前提下复用全部 Rust 逻辑
（`db` / `llm` / `mcp` / `mask` / `store`），并用 CodeMirror 提供 schema-aware 补全。

> ADR-014 已写入 `ARCHITECTURE.md`。

## 做了什么

### 1. 后端重构为 library（零逻辑改动）
- 根 crate 改为 lib（`src/lib.rs`），暴露全部领域模块；TUI 收进 `tui` feature，
  桌面以 `default-features = false` 消费，不编译 ratatui。
- `mysql.rs`：抽 `connect_pool()`，新增 `test()` / `schema()`（查
  `INFORMATION_SCHEMA.COLUMNS` 取表/列）；`redis.rs`：新增 `test()`（PING）。

### 2. Tauri 壳（`src-tauri/`）
- `chatquery-desktop` crate，依赖 `tauri v2` + `chatquery` path。
- `AppState`：连接 store + 按连接 schema 缓存 + LLM 配置 + 可选 MCP。
- `commands.rs`：9 个命令，DTO 在边界翻译，**密码绝不回传**；
  `chat_turn` 把后端 `BackendMsg` 流桥接为 Tauri 事件
 （`chat-token` / `chat-tool` / `chat-done` / `chat-error`），LLM 流式照常。

### 3. 前端（`frontend/`，Vite + React + TS）
- CodeMirror 编辑器：`basicSetup` + `autocompletion()`，用 `Compartment` 在拿到
  schema 后重配 `sql({ schema, upperCaseKeywords: true })` → **表/列自动补全**；
  Mod-Enter 执行；Ctrl 清屏。
- 三栏布局：连接侧栏 / SQL 编辑 + 结果 / 流式聊天。结果支持 MySQL 表与 Redis 文本。

## 关键决策（ADR-014）

| 决策 | 取舍 |
|------|------|
| 复用而非重写 | Tauri 命令层是薄适配器，后端 100% 复用；代价是新一层边界翻译 |
| 密码不回传前端 | 安全优先；代价是编辑表单无法预填密码（留空=保留） |
| 有界 schema 拉取 | 按连接惰性取 + 缓存，不预扫整库（守 ADR-006） |
| TUI 保留为回退 | 可逆：`cargo run --features tui` 仍可跑原终端版 |

## 验证

| 项 | 结果 |
|----|------|
| 根 crate 构建（TUI） | ✅ |
| 根 crate `--no-default-features --lib` | ✅ |
| `src-tauri` `cargo check` / `cargo build` | ✅ 46.5MB debug |
| frontend `npm install` / `npm run build` | ✅ 576KB / 188KB gzip |

## 怎么跑

> 注意：本机 `cargo` 未装 `tauri` 子命令。用前端本地 CLI（devDependency `@tauri-apps/cli`）。

```bash
cd /Users/hel04/Desktop/mycode/chatquery
./frontend/node_modules/.bin/tauri dev     # 开发（Vite :1420 + 原生窗口）
# 或：cd frontend && npx tauri dev
./frontend/node_modules/.bin/tauri build   # 打包
cargo run --features tui                    # 回退到 TUI
```

> `tauri.conf.json` 的 `beforeDevCommand` 必须用**绝对路径**的 `npm --prefix`
> （如 `npm --prefix /Users/hel04/Desktop/mycode/chatquery/frontend run dev`），
> 否则 Tauri 以 frontend 为 cwd 执行时会变成 `frontend/frontend/...` 双重嵌套导致 ENOENT。

## 待打磨（TODO，未做）

- 结果导出 CSV（桌面端）
- 连接管理键盘快捷键
- MCP 服务器可视化配置
- Release 体积优化（musl / UPX）
- 桌面端主题切换
