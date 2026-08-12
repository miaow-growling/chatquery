# AI 会话体系 — 实施总结 (2026-08-12)

设计文档：`docs/chat-conversation-design.md`（P0 会话持久化 + P1 跨会话 @ 引用，全部落地）

## 问题
Chat 面板历史全混在一个数组里、刷新即丢，无法按连接/主题管理对话，也不能在会话之间引用上下文。

## 方案
会话成为一等实体（对齐 ADR-016）：`conversations` / `chat_messages` 落 SQLite，前端只负责展示与加载，TUI/未来客户端复用同一套命令；跨会话引用通过 `@` 注入背景上下文块。

## 后端（#224-226）
| 模块 | 改动 |
|------|------|
| `src/store/mod.rs` | 会话表 + CRUD（级联删、seq 顺序、meta JSON 往返）、`get_recent_conv` 注入数据源 |
| `src/model.rs` | `ConversationSummary` / `NewChatMessage` / `StoredChatMessage` / `ConversationRef` |
| `src-tauri/src/commands.rs` | 6 个会话命令 + `chat_turn` 增 `conv_id`/`conv_refs`（可选，向后兼容） |
| `src/llm/session.rs` | `render_conv_refs`：每会话最近 8 条、2000 字/条、12000 字预算注入 |

## 前端（#227）
- `types.ts` / `api.ts`：会话类型与 6 命令封装，`chatTurn` 透传 `convId`/`convRefs`
- `App.tsx`：
  - 会话选择器（pane-head 下拉：搜索 + hover 重命名/删除 + 新建按钮）
  - 持久化：`turnItemsRef` 快照（绑定 convId 防串台）→ `chat-done` 落盘 + 列表刷新；首条 user 自动标题；首次启动自动建默认会话并回放
  - @ 引用：词首 `@` 弹候选（↑↓/Enter/Esc），卡片支持「整段对话 / 消息钻取选单条」，随 `conv_refs` 发送

## 验证
| 检查项 | 结果 |
|--------|------|
| `cargo check --lib --no-default-features` + `cargo check`（src-tauri） | ✅ |
| `cargo test --lib`（64 个） | ✅ |
| `tsc --noEmit` + `vite build` | ✅ |
| `tauri dev` 重启（注册新命令） | ✅ |
| 提交推送 | ✅ `188206c` → origin/main |

## 待办（P2 未做）
会话内搜索、导出（MD/JSON）、按连接自动归组、AI 摘要标题、置顶、会话共享。
