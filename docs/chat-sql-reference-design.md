# ADR: Chat 引用 SQL（单条语句 / 整个查询）

> 状态：**Accepted（已落地，2026-08-07）** · 作者：架构通 · 日期：2026-08-07
>
> 落地实现见文末「实施记录」，其中列出了与本文初稿的三处刻意偏离。

## Context（问题）

当前 Chat 与查询编辑器是**彼此隔离**的两条世界线：

- `chatTurn(connId, messages)` 只接收纯文本 `ChatMessage[]`，AI 对编辑器里写了什么 SQL **一无所知**。
- 用户想就「光标所在的某一条 SQL 语句」或「整个查询」问 AI（解释 / 优化 / 排错 / 运行），现在只能**手动复制粘贴**进 Chat 输入框——这会丢失两样关键东西：
  1. **语句边界**：粘贴的可能是半截语句；
  2. **连接与库上下文**：AI 不知道这段 SQL 属于哪个实例、哪个库，要运行还得重新问。

这正好落在我们定的产品定位上——**「AI 驱动的查询助手」**，是编辑器与 AI 协作甜区里性价比最高的一块，值得专门设计。

设计目标：

1. **引用粒度**：单条语句（按 `;` 边界 snap）或整个查询。
2. **自动携带 provenance**：`connId + db`，复用编辑器头刚做好的连接信息。
3. **可逆、非破坏性**：引用不改动用户 SQL，可随时撤销（dismiss）。
4. **复用现有 Agent**，最小协议改动。
5. **透明**：用户在 Chat 里能看见 AI 这次到底「收到了哪段 SQL」。

---

## 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 文本注入** | 把 SQL 作为引用块拼进输入框文本，一起发给 AI | 零协议改动、最简单 | 引用在聊天里堆积；AI 易把引用误当对话；撤销只靠删文本；provenance 仅文本无结构 |
| **B. 附件式引用 chip**（推荐） | composer 挂一个可 dismiss 的「引用」chip，结构化随 turn 发送 | 结构化、可逆、携带元数据、Chat 渲染成引用块清晰 | 需加 composer 状态 + `chatTurn` 加一个可选参 |
| **C. 常驻上下文** | Chat 始终自动包含当前 tab 全文 SQL | 零点击 | 噪音大、易让 AI 误用无关 SQL、多 tab 语义混乱 |

**推荐 B**：结构化元数据让 AI 可靠解析，可逆性最好，且协议改动极小（一个可选数组参数）。

---

## 数据模型

```ts
interface SqlReference {
  connId: string;          // SQL 出处连接（编辑器 tab 的连接，非 Chat 绑定连接）
  db: string | null;       // 出处库；null = 默认库
  scope: "statement" | "full";  // 单条语句 / 整个查询
  sql: string;             // 实际引用的文本（已 snap 到语句边界 / 全文）
  preview: string;         // 截断预览，用于 chip 显示
}
```

composer 持有：`pendingRefs: SqlReference[]`。

---

## 交互设计

### 编辑器侧（触发引用）

- **有选区** → 右键 / 悬浮按钮「问 AI ▾」子菜单：
  - 解释选中 SQL
  - 优化选中 SQL
  - 运行选中 SQL
  - 引用到 Chat（仅挂 chip，不预填问题）
- **无选区** → 「引用整个查询」（scope = `full`）。

行为区分：

- **引用到 Chat**：把 chip 挂到 composer、`聚焦 Chat 输入框`，用户自行输入问题。
- **解释 / 优化 / 运行**：挂 chip + 预填 prompt（解释：`请解释这段 SQL 的执行逻辑与潜在问题`；运行：直接交给 Agent 的 `exec_query`）。

chip 展示：`🐬 connName · db · [选中 N 行 / 全文] · SELECT …`（截断）。
- 点 chip → 弹 modal 看完整 SQL；
- `×` → 移除该引用（可逆）。

### 语句边界 snapping（关键细节）

- **有选区**：用 `;` 把选区 expand 到最近语句边界
  `stmtStart = doc.lastIndexOf(";", from-1) + 1` → `stmtEnd = doc.indexOf(";", to)`
  避免引用半截语句。编辑器 `editor.ts` 现有补全逻辑已用同样算法，可抽成 `getStatementRange(from, to)` 复用。
- **无选区 / 全文**：整段 `getDoc()`。

### 连接归属（provenance）

引用携带 `active.connId / active.db`（SQL 的真实出处）。
若与 Chat 绑定的 `selId` 不同：**以引用里的连接为准执行/分析**，UI 标注差异，避免「问 A 库的 SQL 却跑到 B 库去跑」。

---

## 协议改动（最小）

```ts
// 现有
export function chatTurn(connId: string, messages: ChatMessage[]): Promise<string>;
// 改为（向后兼容，refs 可选）
export function chatTurn(
  connId: string,
  messages: ChatMessage[],
  refs?: SqlReference[],
): Promise<string>;
```

Rust 侧 `chat_turn` 命令接收 `refs`，作为 **N2 上下文**注入本次 user turn（与现有 SessionMemory 注入同构）：

```
[用户引用] 连接 X / 库 Y / 范围：单条语句
```sql
<sql>
```
```

同时把引用渲染成一条**可见 ChatItem**（`role: "ref"`），让用户在聊天记录里看到 AI 收到的内容（透明性）。`ref` 与现有 `plan` 同理：发送历史回模型前被 strip，只留 user/assistant 文本。

---

## Agent 复用

- AI 已有 `exec_query` 工具；引用「运行」时直接把 `ref.sql` 交给它，连接来自 `ref.connId / ref.db`，无需新工具。
- 解释 / 优化为纯文本分析，无需执行。

---

## 风险与取舍

- **半语句 / 嵌套子查询边界不准**：靠 `;` snap 兜底；存储过程、嵌套派生表边界可能切错——接受此局限，因为用户绝大多数引用顶层语句。必要时可让用户手动框选精确范围。
- **连接不一致**：引用连接 ≠ Chat 连接时，以引用连接为准执行并在 UI 标注。
- **「运行选中」与编辑器自身「执行」按钮语义重叠**：明确区分——引用运行走 **AI 分析路径**（可附带解释与风险提示，复用写护栏 ConfirmRequired），编辑器执行是纯执行。这正是「AI 驱动」差异化的体现。

---

## 实施拆分（建议顺序，纯前端先行、零风险起步）

1. **前端**：composer `pendingRefs` 状态 + 引用 chip UI + 编辑器「问 AI ▾」菜单 + `getStatementRange` 边界 snap 辅助。
2. **前端**：`sendChat` 把 `pendingRefs` 接进 `chatTurn(connId, history, refs)`；`api.ts` 签名加 `refs?`。
3. **后端**：`chat_turn` 接 `refs`，注入 N2 上下文 + 渲染可见 `ref` 块。
4. **可选增强**：引用「运行」快捷 → 预填 `请运行并解释这段 SQL`；`ref` 块可点击回跳到对应编辑器 tab。

> 第 1–2 步纯前端、不改协议契约（refs 先本地暂存、prompt 里附带文本也能工作），可独立验收；第 3 步才是真正的协议落地。

---

## Consequences（后果）

**变得更易**：用户从「复制粘贴 + 解释连接」降级为「选中 → 问 AI」；AI 拿到的 SQL 自带连接/库，运行与分析准确率提升；引用可逆、透明。

**变得更难**：composer 多了一层状态；`chat_turn` 协议多一个可选维度；需要在「引用运行」与「编辑器执行」之间划清语义边界，避免用户困惑。

---

## 实施记录（2026-08-07）

方案 B 已完整落地（前端 + 后端协议），与初稿的**刻意偏离**如下：

1. **字段命名改 snake_case**：`SqlReference { conn_id, db, scope, sql }`，与仓库既有 DTO（`QueryItem.conn_id`、`ConnSummary.db_type`）一致，前后端共用一套字段名，省掉 serde rename。
2. **删掉 `preview` 字段**：预览只服务于 chip 渲染，属派生数据，放进协议等于让前后端各存一份可能不同步的截断结果。改为渲染时用 `refPreview(sql)` 现算。
3. **注入位置：折进「最后一条 user 消息」，而不是 system 块**。理由是 provenance 是本轮证据，近因位置最能压住模型「拿着上一段 SQL 继续答」的倾向；同时避免部分 provider 对尾部 system 消息的兼容性问题。

其他实现要点：

- **规划启发式喂纯文本**：`needs_planning` 只看用户自己打的字，不含引用块——否则贴一段 40 行 SQL 问「解释一下」会被判成复杂任务，白买一次 plan + N 个 worker。但 `plan_task` 仍拿增强后的文本，否则「优化这段 SQL」只能规划出空泛步骤。
- **引用长度上限 `MAX_REF_SQL_CHARS = 8000`**：超长截断而非丢弃——半截语句还能回答「这查询在干嘛」，丢掉就什么都答不了。
- **零引用路径 byte-identical**：`render_refs` 返回 `None` 时完全不注入，老行为不受影响；已有单测锁死这条不变量。
- **落地文件**：`src/model.rs`（`SqlReference`）、`src/llm/session.rs`（`render_refs` / `attach_refs_to_last_user` + 5 个单测）、`src-tauri/src/commands.rs`（`chat_turn` 加 `refs: Option<...>`）、`src/tui/app.rs`（传 `&[]`）、`frontend/src/{types,api,editor,App}.ts(x)` + `style.css`。

**暂缓项**（不是遗漏，是取舍）：

- **「运行选中」走 AI 路径**：与编辑器「执行」按钮语义重叠，先只给「解释 / 优化」两个预填动作，观察用户是否真的会用 AI 去跑。
- **`ref` 卡片点击回跳编辑器 tab**：引用产生后 tab 可能已关闭或改写，回跳语义不稳，等真实需求出现再做。
- **语句边界靠 `;` 朴素扫描**：字符串字面量、存储过程体内的分号会切早。现状可接受——chip 显示的就是实际引用内容，切错用户当场可见。真要修得上 tokenizer。
