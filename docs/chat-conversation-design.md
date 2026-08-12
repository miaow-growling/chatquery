# AI 对话会话体系设计（Conversation System）

> 状态：待评审 · 作者：SoftwareArchitect · 日期：2026-08-12
> 关联：ADR-016（一等实体）、ADR-AI-2（连接上下文注入）、ADR：Chat 引用 SQL（方案 B）

## 1. 背景与问题

当前 CHAT 面板是**单一全局 transcript**：

- 前端只有一个 `chat: ChatItem[]` 状态，A 库问完切到 B 库，历史全部混在一起；
- 消息**零持久化**——刷新窗口全部丢失，无法回看；
- 没有「会话」这个概念，`chat_turn(connId, messages, refs)` 每轮把全量历史重发给模型；
- `SessionMemory`（`src/llm/memory.rs`）只存活单个 turn 内（current_conn/current_db/最近 8 条工具结果），不跨轮、不落盘。

用户诉求：① A 库 / B 库的对话分开；② 有地方回看历史会话；③ 最好能跨会话引用（在 B 会话里引用 A 会话的结论/SQL）。

## 2. 设计目标与原则

1. **会话是一等实体**（对齐 ADR-016）：有 id、标题、绑定连接、时间戳，可持久化、可管理。
2. **持久化在后端**：消息存 SQLite（复用现有 `app.db`），前端只负责展示与加载；TUI/未来客户端可复用同一套命令。
3. **展示与回放分离**：transcript 里 plan/ref/tool 装饰卡片一并落盘（meta JSON），但**回放给模型时仍只发 user/assistant**（沿用现状过滤逻辑，token 成本不变）。
4. **跨会话引用复用既有 refs 通道**：历史消息以「带 provenance 的上下文块」注入，与编辑器 SQL 引用同一套注入机制。
5. **不破坏现有行为**：无会话需求的老路径（TUI、简单调用）不感知新增参数。

## 3. 数据模型

### 3.1 表结构（`src/store/mod.rs` 的 `init_schema` 追加）

```sql
CREATE TABLE IF NOT EXISTS conversations (
    id      TEXT PRIMARY KEY,          -- gen_id("s")
    title   TEXT NOT NULL,             -- 首条消息自动生成，可重命名
    conn_id TEXT,                      -- 绑定的连接；NULL = 通用会话
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,          -- 排序键（最近对话置顶）
    pinned  INTEGER NOT NULL DEFAULT 0 -- 置顶会话
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id      TEXT PRIMARY KEY,          -- gen_id("m")
    conv_id TEXT NOT NULL,             -- FK → conversations.id
    seq     INTEGER NOT NULL,          -- 会话内自增，保证顺序
    role    TEXT NOT NULL,             -- user/assistant/tool/system/plan/ref
    content TEXT NOT NULL DEFAULT '',
    meta    TEXT,                      -- JSON：ref→refs[]；plan→steps[]；assistant→usage
    ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON chat_messages(conv_id, seq);
```

说明：

- `chat_messages` 全量保留装饰卡片（`role='plan'/'ref'/'tool'`），meta 存结构化数据；
- 消息明文存储（与 `queries` 同敏感级，符合现有密钥分级；连接密码仍走 AES-GCM 加密，不受影响）；
- 删除会话级联删除其消息（事务内完成）。

### 3.2 Rust 结构（`src/model.rs`）

```rust
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub conn_id: Option<String>,
    pub conn_name: Option<String>,   // join 连接名，UI 展示标签
    pub created: i64,
    pub updated: i64,
    pub pinned: bool,
    pub last_preview: String,        // 最后一条消息前 60 字
    pub msg_count: i64,
}

pub struct StoredChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub meta: Option<serde_json::Value>,
    pub ts: i64,
}

/// 跨会话引用：注入目标会话（或其中单条消息）的最近对话。
pub struct ConversationRef {
    pub conv_id: String,
    pub scope: String,               // "session" | "message"
    pub message_id: Option<String>,  // scope=message 时定位
}
```

## 4. 后端命令（`src-tauri/src/commands.rs`）

| 命令 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `list_conversations` | — | `Vec<ConversationSummary>` | 按 updated 倒序，上限 200 |
| `create_conversation` | `conn_id: Option<String>`, `title: Option<String>` | `id` | 默认绑定当前选中连接 |
| `rename_conversation` | `id`, `title` | — | |
| `delete_conversation` | `id` | — | 事务内级联删消息 |
| `get_conversation` | `id`, `offset: u32`, `limit: u32` | `{ info, messages }` | 消息按 seq 升序；默认最近 100 条 |
| `append_chat_messages` | `conv_id`, `messages: Vec<StoredChatMessage>` | — | 校验 role 白名单 + 长度上限；更新 conv.updated |
| `chat_turn`（改造） | 增加 `conv_id: String`、`conv_refs: Vec<ConversationRef>` | 不变 | conv_refs 注入历史上下文（见 §6） |

所有命令在 `main.rs` 注册。`chat_turn` 新增参数均为可选默认（TUI 调用传空），保持向后兼容。

## 5. 前端交互（`App.tsx`）

### 5.1 会话选择器（CHAT 面板头部）

```
[ ▾ 会话标题        ] [＋新建]
```
- 下拉列表：搜索框 + 按连接分组（`当前连接` / `其他连接` / `全部`），每项显示 `标题 / 连接标签 / 相对时间 / 消息数`；
- 项上 hover：`重命名`、`删除`（confirmAsync 确认，删除当前会话后自动切到最近一个）；
- 新建：`create_conversation(conn_id = selId)`，加载空会话；
- 切换：`get_conversation(id)` 填充 `chat` 状态。

### 5.2 消息持久化时机

- `sendChat`：记录本次 turn 的 items 快照（含 ref/plan 卡片）到 `turnItemsRef`；
- 收到 `chat-done`：用 `chat` 里最终 assistant 文本回填占位，调 `append_chat_messages(conv_id, items)`；
- 首条 user 消息 → `rename_conversation(前 24 字)` 自动起标题；
- 列表刷新：发送后重新 `list_conversations`。

### 5.3 首次启动

`list_conversations` 为空时自动创建「默认会话」（绑定第一个连接或 NULL），保证 UI 始终有当前会话。

## 6. 跨会话引用协议

### 6.1 交互

输入框输入 `@` → 弹出会话搜索列表（数据来自已缓存的 `list_conversations`）→ 选中一个会话 → 出现**引用卡片**（显示标题 + 摘要），可再选择「整段对话」或展开消息列表选单条 → 发送时随 `conv_refs` 传给后端。引用卡片与现有 ref 卡片并列显示在输入框上方（可移除）。

### 6.2 后端注入（`src/llm/session.rs`）

新增 `render_conv_refs(conv_refs, store) -> Option<String>`，格式：

```
[引用的历史会话「A库订单问题」]
以下内容来自另一会话，仅作背景参考（数据可能已变化）：
- 用户：……
- AI：……
```

- 注入位置：复用 `attach_refs_to_last_user`（挂在最后一个 user 消息前），与编辑器 SQL 引用并列；
- 上限：每个会话取最近 **8** 条 user/assistant，每条截断 **2000** 字，总量上限 **12000** 字，超限截断不丢弃；
- `run_turn` 增加 `conv_refs: &[ConversationRef]` 参数，命令层从 store 取消息后传入（store 只读，无锁风险）。

### 6.3 安全

- 注入块明确标注「数据可能已变化」，防止模型把历史结论当现状；
- 引用的内容随 user 消息走现有审计路径，无额外风险面。

## 7. 演进路径

| 阶段 | 内容 |
|---|---|
| **P0（本次）** | 实体 + 存储 + 命令 + UI：会话列表 / 新建 / 切换 / 重命名 / 删除 / 消息持久化 / 自动标题 / 首次默认会话 |
| **P1** | 跨会话引用：`@` 会话/消息级注入（§6） |
| **P2** | 会话内搜索、导出（MD/JSON）、按连接自动归组、AI 摘要标题、置顶、会话共享 |

## 8. 兼容与回滚

- `chat_turn` 新参数带默认值，旧前端调用不破坏；TUI 不传 conv_id 则行为与现状一致；
- 老用户无历史消息可迁移（本来就不持久化），首次进入自动建默认会话，无感升级；
- 表新增均为 `CREATE TABLE IF NOT EXISTS`，无 schema 迁移成本。

## 9. 验证清单

- [x] `cargo check --lib --no-default-features` + `cargo check`（src-tauri）
- [x] store 单测：conversation CRUD、消息级联删除、seq 顺序、meta 往返
- [x] `tsc --noEmit`、`vite build`
- [x] 手动：A 库建会话 → 提问 → 切 B 库建会话 → 提问 → 会话列表两条独立 → 切回 A 会话回放 → 刷新窗口后仍在 → `@` 引用 A 会话提问

## 10. 实施记录

### P0 后端（#224-#226，已完成）
- 存储层：`conversations` / `chat_messages` 表 + CRUD（#224）
- 命令层：6 个 Tauri 命令 + `chat_turn` 增 `conv_id`/`conv_refs`（#225）
- 注入层：`render_conv_refs` 跨会话引用块（最近 8 条、2000 字/条、12000 字预算）（#226）

### P0+P1 前端（#227，已完成）
- `types.ts`：`ConversationSummary` / `NewChatMessage` / `StoredChatMessage` / `ConversationRef` / `ConvRefCard` / `ConversationDetail`
- `api.ts`：6 个会话命令封装；`chatTurn` 增 `convId`/`convRefs`（可选，向后兼容）
- `App.tsx`：
  - 会话选择器：pane-head 下拉（搜索 + 分组显示 + hover 重命名/删除）+ 新建按钮；
  - 持久化：`turnItemsRef` 快照（含 plan/ref 卡片，绑定 convId 防串台）→ `chat-done` 时 `append_chat_messages` → 刷新列表；
  - 自动标题：首条 user 消息 → 前 24 字；
  - 首次启动：无会话自动建「默认会话」并回放最近会话；
  - @ 引用（P1）：输入 `@` 弹出会话候选（↑↓/Enter/Esc），卡片支持「整段对话 / 展开消息选单条」，随 `conv_refs` 发送。
- 验证：`tsc --noEmit` ✓、`vite build` ✓、`cargo check`（lib + src-tauri）✓、64 个单测全过 ✓

