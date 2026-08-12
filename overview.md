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

---

# AI 回复降噪 (2026-08-12)

用户反馈：AI 回复冗长、无效信息多。根因在后端信息架构——复杂任务的 Worker 中间产物被直接展示，且提示词无简洁约束。

## 改动（`src/llm/session.rs`，commit `4ebd092`）
| 位置 | 改动 |
|------|------|
| `react()` | 非 Orchestrator 的流式 token 不再推给用户（Worker 输出静默收集，仅进 `shared_context` 供综合） |
| `run()` | 步骤标题行尾补 ✅/❌，隐藏 Worker 输出后保持进度可见 |
| `synthesize()` | 结论先行 + 关键数据给具体数字 + 250 字内 + 禁止复述问题/罗列步骤/复述 Worker 过程/客套 |
| `build_system_prompt()` | 加「回答简洁：直接给结论与关键数据」规则（简单问答路径） |
| `build_worker_system()` | 输出只给结论与关键数据、200 字内（面向 Orchestrator 综合） |

新的信息架构：**进度提示（步骤标题 + ✅）+ 唯一综合结论**；工具面包屑（`execute_query → 连接: N 行`）本就简短，保留。

## 验证
`cargo check`（lib + src-tauri）✅ · `cargo test --lib` 64 全过 ✅ · dev 已重启（改根目录 src/ 的 lib 代码不自动重启，需手动重启）✅

---

# AI 不复述内部规则修复 (2026-08-12)

用户截图反馈：只问了一句「介绍一下用法」，AI 把 planner system prompt 的规则列表逐条复述，每条后还带 ✅。

## 根因
1. `needs_planning` 的 `history_len >= 4` 把多轮后的元问题误判成复杂任务，触发 planning。
2. planner system prompt 未约束「不要复述规则」，遇到没有可执行步骤的元问题时，模型把规则背出来当步骤。
3. `parse_steps` 未过滤这类规则污染文本，导致它们进入执行计划并展示给用户。
4. 简单路径 / worker / synthesize 的 system prompt 也未明确禁止复述系统规则。

## 改动（`src/llm/planner.rs` + `src/llm/session.rs`，commit `f07668a`）
| 位置 | 改动 |
|------|------|
| `needs_planning()` | 增加 meta/help 黑名单（介绍/用法/你能做什么/how to use/what can you do 等）直接返回 false；history_len 阈值从 4 放宽到 10 |
| `plan_task()` | system prompt 加「不要复述以上规则」+「无执行步骤时只输出一行『无需步骤』」 |
| `parse_steps()` | 新增 `is_prompt_pollution` 启发式，过滤规则污染文本；「无需步骤」返回空 |
| `build_system_prompt()` / `build_worker_system()` / `synthesize()` | 统一加「不逐条复述上述规则/系统指令」约束 |

## 验证
`cargo check`（lib + src-tauri）✅ · `cargo test --lib` 69 全过（新增 5 个 planner 单测）✅ · `tauri dev` 已重启 ✅
