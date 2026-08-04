# ChatQuery AI 功能规划

> 版本：v1 · 2026-08-03 · 状态：草案（供评审）
> 范围：基于当前代码现状，规划 ChatQuery 的 AI 能力演进路线。
> 角色视角：软件架构师。所有决策遵循"先讲权衡，再定方案"。

---

## 0. 摘要

ChatQuery 的 AI 底座**已经超出"功能雏形"阶段**——后端是一个带工具调用循环的 ReAct Agent，前端是流式聊天 UI，LLM 接入了 9 个厂商（含本地 Ollama），并通过 MCP 预留了工具扩展能力。换言之，"能聊天、能自己跑 SQL、能接外部工具"的主链路已经跑通。

真正缺的不是"有没有 AI"，而是四件事：

1. **安全护栏**：内置 `execute_query` 工具目前能执行**任意** SQL（含 `DROP/DELETE/UPDATE`），没有只读限制、没有危险拦截、没有确认环节。
2. **上下文质量**：Agent 决策时拿到的信息太弱（只传连接名 + SQL），没有把"当前库 / 选中表结构 / 业务语义"注入系统提示，NL→SQL 准确率受限。
3. **能力广度**：只有"对话 + 执行"，缺少 SQL 解释/优化、错误诊断、结果洞察、可视化、跨库编排等"围着数据库工作"的高频 AI 能力。
4. **会话与体验**：单会话、无持久化、无停止/重生成、无成本可观测、AI 产出与编辑器之间缺乏桥接。

本文按 **Now（安全+质量+基础体验）/ Next（深度能力）/ Later（平台化）** 三阶段规划，并以 4 个 AI 系列 ADR 锁定关键技术决策。

---

## 1. 现状盘点（已经建了什么）

| 能力 | 状态 | 关键文件 | 说明 |
|---|---|---|---|
| LLM 接入（多厂商） | ✅ 成熟 | `src/config.rs` (`LlmConfig`, `VENDOR_PRESETS`) | 9 预设：OpenAI / 阿里云通义 / 腾讯混元 / DeepSeek / 智谱 / OpenRouter / **Ollama 本地** / Anthropic / 自定义 OpenAI 兼容。协议仅 OpenAI + Anthropic 两种。 |
| API Key 安全存储 | ✅ 已建 | `config.rs` + `crypto` | api_key 加密落盘（ADR-004），与连接密码同机制。 |
| 流式 Agent 会话（ReAct） | ✅ 核心已建 | `commands.rs:chat_turn` → `src/llm/session.rs:run_turn` | `stream_chat` 流式调用 → 解析 `tool_calls` → `exec_tool` 执行 → 结果回传 → 循环，直到无 tool_calls。 |
| 流式事件桥接 | ✅ 已建 | `chat_turn` emit `chat-token`/`chat-tool`/`chat-done`/`chat-error`；前端 `api.ts` + `App.tsx` listen | 前端 `chat` state 渲染 user/assistant/tool 消息。 |
| 内置工具 `execute_query` | ⚠️ 有隐患 | `src/llm/tools.rs` | MySQL 执行任意 SQL / Redis 执行命令。**无只读限制**。结果对回传模型做脱敏（`mask`）。 |
| MCP 可扩展层 | ✅ 基础设施已建 | `src/mcp/host.rs` (`McpHostManager`) | stdio MCP server 连接、tool schema 收集、命名空间路由 `mcp__server__tool`。已有集成测试 fixture。**暂无内置/推荐 server**。 |
| 编辑器内联 AI 补全 | ✅ 已建 | `editor.ts` `aiProvider` → `commands.rs:complete_sql` | 打字 debounce 500ms → LLM 生成 SQL 续写（灰色 inline）。注入 `schema()`（**LIMIT 1000 截断**）。 |
| 设置面板（模型配置） | ✅ 已建 | `commands.rs:get/save_llm_config`；`App.tsx` 设置"模型"页 | 厂商下拉 + BaseURL/模型/APIKey + 保存；通用页有"AI 内联补全开关"。 |

### 1.1 关键缺口（规划重点）

- **安全**：`execute_query` 直接 `mysql::query(cfg, &query, None)`，可跑 DDL/DML，零护栏。
- **上下文**：`run_turn` 把 `conns`（全部连接）和 `messages` 传入，但**没有把当前连接/库、选中表结构作为 system prompt 注入**；工具也只接收"连接名 + query"字符串，LLM 自行猜库。
- **质量**：`complete_sql` 用 `schema()` 全量（截断 1000 表），大库覆盖不全；NL→SQL 无"当前 db/表"约束。
- **会话**：单 `chat` 数组，刷新即丢；无多会话、无持久化、无停止/重生成、无 token 成本。
- **桥接**：AI 生成的 SQL 只在聊天里执行，不能直接"填入编辑器并运行"。
- **能力**：无 SQL 解释/优化、错误诊断、结果洞察、可视化、跨库编排、结构问答。
- **可运维**：turn 不可取消（关窗口/切连接后仍在跑）、无超时、无 token 统计、无审计日志。

---

## 2. 愿景与原则

**愿景**：让 ChatQuery 成为"会自己动手的数据库助手"——用户用自然语言描述意图，AI 在受控边界内查数据、解释 SQL、定位错误、给出优化，并把成果无缝交还给编辑器。

**原则（架构约束）**：
1. **安全优先于便利**：AI 能看、能查，但默认不能擅自改；任何写操作必须显式确认。
2. **上下文按需、成本可控**：注入 schema 必须截断/懒加载，不为准确率无限烧 token。
3. **AI 产出可审计、可接管**：AI 生成的 SQL 进编辑器而非自动执行；执行结果可溯源。
4. **复用已建骨架**：不重写 Agent 循环 / MCP / 流式层，只在上面加护栏、加上下文、加能力。
5. **本地模型是一等公民**：规划不假设"必须云端强模型"，离线/Ollama 路径要能跑通（准确率可降级）。

---

## 3. 能力蓝图（Now / Next / Later）

### 3.1 Now 阶段（0–6 周）— 安全 + 质量 + 基础体验

| # | 功能 | 价值 | 关键改动 | 依赖 |
|---|---|---|---|---|
| N1 | **工具执行安全护栏** | 堵住"AI 误执行 DROP/DELETE"最大风险 | `tools.rs:exec_builtin` 加只读模式（仅 SELECT/SHOW/EXPLAIN）+ 危险语句拦截 + 写操作二次确认协议 | — |
| N2 | **系统提示上下文注入** | 大幅抬升 NL→SQL 准确率 | `run_turn` 构造 system prompt：当前连接/库名 + 选中表结构摘要 + 时间；工具调用前把目标库显式传入 | N1 |
| N3 | **SQL 解释 / 优化建议** | 高频刚需（读懂复杂 SQL、找慢因） | 新增命令 `explain_sql(sql)`：自然语言解释 + 索引/重写建议（复用流式） | N2 |
| N4 | **错误诊断** | 执行报错时一键找原因 | 执行失败时捕获错误 → 调 LLM 分析根因 + 修复 SQL 建议 | N2 |
| N5 | **聊天体验补全** | 可用性底线 | 停止生成（取消 turn）、重新生成、token 用量显示、异常兜底 UI | — |
| N6 | **AI↔编辑器桥接** | 让 AI 成果可直接用 | 聊天里 AI 生成的 SQL 出现"填入编辑器并运行"按钮；`complete_sql` 不自动跑 | N2 |
| N7 | **内联补全上下文增强** | 补全更准、更省 | `complete_sql` 注入当前 db + 光标上下文表结构（替代全量 LIMIT 1000） | N2 |

**Now 验收**：打开聊天 → 用中文问"上周注册的用户有哪些"→ AI 在只读护栏下生成 SELECT 并跑出结果；选中一段慢 SQL → 一键得到优化建议；报错 → 一键诊断。全程无危险写操作漏网。

### 3.2 Next 阶段（1–3 月）— 深度能力

| # | 功能 | 价值 | 关键改动 |
|---|---|---|---|
| X1 | **结果智能洞察** | 把"数据"变"结论" | 查询结果 → 摘要/异常值/分布描述（流式） |
| X2 | **自然语言 → 图表** | 看图比看表快 | AI 建议图表类型 + 前端渲染简单图表（柱状/折线/饼） |
| X3 | **跨连接/跨库编排** | 多源数据汇总 | Agent 协调多个 `execute_query`（不同连接）并汇总；需 N1 护栏覆盖 |
| X4 | **多会话管理** | 分主题不乱 | 会话列表 + 持久化（本地文件）+ 重命名/删除/导出 |
| X5 | **MCP 预设与一键接入** | 扩展 AI 手脚 | 内置文件系统 / 代码执行 / 数据分析 server 配置模板 |
| X6 | **数据库结构问答** | "这张表干嘛用的" | 基于 schema + 关系（`list_relationships`）的业务问答 |
| X7 | **聊天内"应用修改"** | AI 改表也能落地 | DDL/DML 建议 → 预览 diff → 确认执行（复用 N1 护栏） |

### 3.3 Later 阶段（3–6 月）— 平台化

| # | 功能 | 价值 |
|---|---|---|
| L1 | **多步 Agent 工作流** | 自动探索 schema → 试查询 → 迭代 → 给结论（自主分析） |
| L2 | **语义层 / 业务术语映射** | 表/列中文业务名，显著提升 NL 理解准确率 |
| L3 | **企业能力** | 权限分级（谁能跑写）、审计日志、脱敏策略开关 |
| L4 | **私有化大模型深度优化** | 本地模型提示工程、量化、RAG 知识库（schema 太大时检索而非全注入） |
| L5 | **可观测性** | token 成本看板、慢查询/失败告警、NL→SQL 质量评估集 |

---

## 4. 关键架构决策（AI 系列 ADR）

### ADR-AI-1：工具执行安全护栏

- **状态**：Accepted（2026-08-03 落地，交互确认已接前端 modal）
- **上下文**：`execute_query` 当前执行任意 SQL，AI 幻觉或越权可造成数据破坏。这是上线前必须解决的最高风险。
- **落地时相对下方原始决策的偏离（重要）**：
  1. 原决策 1 的"只读白名单 + 其余全拒"实现为**三档分级**（`src/llm/policy.rs`）：只读（`SELECT/SHOW/EXPLAIN/DESCRIBE/WITH/USE/SET/CALL`）→ `Allow`；写（`INSERT/REPLACE/UPDATE/DELETE`）→ `ConfirmRequired`；DDL/破坏性（`DROP/TRUNCATE/ALTER/CREATE/RENAME/GRANT/REVOKE`）与无法识别的语句 → `Deny`。
  2. 原决策 2 把 `DROP/TRUNCATE/ALTER` 也归入"可二次确认"，实现中**收紧为硬拒、无确认通道**。理由：DDL 的爆炸半径和 `UPDATE` 不是一个量级，不值得为它开一个用户容易顺手点过的口子；需要 DDL 请用户自己在编辑器里执行。
  3. "二次确认"没有做成 `requires_confirm` 返回值，而是**带外事件 + oneshot 回填**——流式回调 `FnMut(&str) + Send` 既不能 await 也不能中止，返回值里表达不了"暂停等人"。改为 `ChatConfirm` 事件 → 前端自建 modal → `resolve_confirm` 命令 → 唤醒 `exec_with_policy` 中挂起的 oneshot（机制见 ADR-AI-4）。等待上限 300s，超时按"拒绝"处理，防止 webview 刷新导致 turn 永久挂起。
  4. 用户拒绝时**以工具结果形式回灌模型**（"用户拒绝执行，不要重试，请说明影响并给出可手动执行的 SQL"），而不是抛错。模型需要看见"人否决了"才会解释自己；抛错只会让它盲目重写再试。
  5. 原决策 3（写操作审计日志）**尚未实现**，留待后续。
- **原始决策（保留供对照）**：
  1. 默认 **只读模式**：`execute_query` 仅允许 `SELECT/SHOW/EXPLAIN/DESCRIBE`（白名单），其余直接拒绝并返回原因。
  2. **危险语句拦截**：对 `DROP/DELETE/UPDATE/INSERT/TRUNCATE/ALTER` 等，即使关闭只读也需走"二次确认"——后端返回 `requires_confirm` 信号，前端弹确认框，用户确认后才真正执行（带显式 `confirmed: true` 标记）。
  3. **写操作审计**：所有非只读执行写入审计日志（连接/库/SQL/时间/来源=AI）。
- **后果**：
  - 易：数据破坏风险归零；用户信任度提升。
  - 难：Agent 自主完成"改数据"类任务受限（需人确认）——这是刻意取舍，Later 阶段 L3 再做权限分级放开。

### ADR-AI-2：上下文注入策略

- **状态**：Proposed
- **上下文**：Agent 决策信息太弱，NL→SQL 容易选错库/表；`schema()` 全量注入成本不可控。
- **决策**：
  1. system prompt 注入**当前连接 + 当前库 + 选中表的结构摘要**（列名/类型/主键），而非全库。
  2. 大库（>阈值表数）改**懒加载**：先注入表名清单（截断 N），Agent 需要时通过工具按需取某表 `describe_table` 拿列。
  3. `complete_sql` 复用同一策略：注入当前 db + 光标上下文表，替代 `schema()` LIMIT 1000。
- **后果**：
  - 易：准确率↑、token 成本↓、大库不卡。
  - 难：懒加载增加一轮工具往返（延迟略升）；需保证"当前库"在 UI 切库时同步到 Agent 上下文。

### ADR-AI-3：聊天 ↔ 编辑器桥接

- **状态**：Proposed
- **上下文**：AI 生成的 SQL 只在聊天里执行，用户要拿去改/跑得手动复制。
- **决策**：聊天中 AI 产出的 SQL 块附带"填入编辑器并运行"操作；AI 不直接对生产库做"生成即执行"之外的动作。
- **后果**：
  - 易：AI 成果可接管、可审计、可控。
  - 难：比"全自动执行"少一步点击（刻意取舍，符合安全原则）。

### ADR-AI-4：流式可取消与可观测

- **状态**：Accepted（取消已落地 2026-08-03；总超时与 token 统计仍为 Proposed）
- **上下文**：`chat_turn` spawn 的后台任务无法取消；无超时、无成本统计。此外一个 turn 有时需要**中途问用户一句话**（写确认），这同样无法通过流式回调表达——两件事本质是同一个问题：turn 需要一条带外控制通道。
- **决策**：
  1. **统一控制面 `TurnControl`**（`src/llm/control.rs`，Tauri 无关）：一个 turn 一份，内含 `AtomicBool` 取消标志 + `Notify`（唤醒等待者）+ `oneshot` 确认注册表。取消与确认共用它，因为两者都是"turn 外部想影响 turn 内部"。
  2. **turn 标识与注册表**：`chat_turn` 生成 `turn_id`（时间戳 + 进程内自增，不引 uuid 依赖）并**同步返回给前端**——前端必须在流开始前就拿到句柄，否则无从取消。`AppState.turns: Mutex<HashMap<String, TurnControl>>` 保存在飞行中的 turn，`cancel_turn` / `resolve_confirm` 按 id 找回；桥接任务在通道关闭时自行摘除条目，注册表随并发数有界。
  3. **取消的落点**：`react` 每轮工具迭代前检查标志，并用 `tokio::select!` 让 `stream_chat` 与 `ctl.cancelled()` 竞速——丢弃 `stream_chat` future 会拆掉 HTTP body reader，所以取消在**一个 chunk 内**生效，而不是等一整次补全。取消同时会拒绝所有挂起的确认，避免等待者饿死。多智能体下 worker **共享同一个 `TurnControl`**，一次取消停掉整棵树。
  4. **取消不是失败**：`run_turn` 在取消时吞掉中断流产生的错误，改发 `⏹ 已取消。`，UI 显示"已取消"而非"报错"。
  5. **完成信号走通道而非直接 emit**：`ChatDone` 与终态错误都塞回 `tx`，由桥接任务顺序 emit。若直接 `app.emit`，`chat-done` 会插队到通道里尚未排空的 token 前面，UI 提交出截断的消息。（顺带修复了桌面端 `run_turn` 从不发 `ChatDone`、`streaming` 卡死的旧 bug。）
  6. 单次 turn 总超时与 token 用量统计：**仍未实现**，保持 Proposed。
- **后果**：
  - 易：跑飞的 turn 可一键叫停；写确认与取消复用同一套机制，没有第二条并行的控制路径；TUI 用 `cancel_confirmations_only()` 声明"我没有确认 UI"，写操作立即被拒而不是挂住。
  - 难：取消是**协作式**的，只在检查点生效——已发出的 SQL 不会被回滚，工具执行中途也不中断（只在其返回后停止推进）。这是刻意取舍：真正的中途中止需要每个工具都支持取消，代价远大于收益。

### ADR-AI-5：多智能体编排（Orchestrator + Worker 拆分）

- **状态**：Accepted（C 首台阶已实现，2026-08-03；A 地基 + B 规划能力已于此前落地）
- **上下文**：单一 ReAct Agent 在长多步任务里把所有中间工具输出堆进同一上下文窗口，导致 token 膨胀、上下文污染、且"规划"与"执行"耦合在同一循环里难以聚焦。用户明确选择方向 C（多智能体）。
- **决策**：
  1. **角色分层**：`Orchestrator`（默认）负责规划与综合；`Explorer` 负责只读探查（结构/规模/采样）；`Executor` 负责按计划取数执行。角色由 `WorkerKind` 枚举建模，差异在系统提示前缀（当前工具集共享，预留未来 Explorer 去写工具）。
  2. **计划即委派单元**：复用 B 的 `plan_task` 产出的 `Vec<String>`，逐步委派——`classify_step`（零成本启发式：探索类词/show/describe → Explorer，否则 Executor）决定每步派给谁。
  3. **上下文隔离**：每个 worker 是 fresh `Agent`（独立 `SessionMemory` + 独立上下文窗口），只接收「全局计划 + 当前步 + 前序结果」；其工具输出不回灌 Orchestrator 上下文，仅以文本摘要回传供综合。
  4. **串行委派 + 综合**：步骤串行（可能依赖、稳延迟）；全部完成后 Orchestrator 用一次无工具 LLM 调用（`synthesize`）生成面向结论的答复。
  5. **零开销保底**：简单任务（`!needs_planning`）仍走单 ReAct，不触发任何额外 LLM 调用；planner 失败安全降级为直接 ReAct。
- **后果**：
  - 易：长任务不再污染单一上下文（每步独立窗口）；角色聚焦提升质量与可维护性；加能力 = 加 worker（开闭友好）；简单任务无回归。
  - 难（刻意取舍）：复杂任务 LLM 调用数 = plan(1) + N×worker + synthesize(1)，**延迟与 token 成本明显上升**；串行委派吞吐受限；多跳结果搬运增加调试面。后续可优化：可并行步骤并发调度、复杂度路由升级为 LLM 自评、确认交互接前端。
- **落地文件**：`src/llm/worker.rs`（角色+路由）、`src/llm/session.rs`（`Agent.role` + `react` 抽取 + `run` 双路径 + `build_worker_system`/`synthesize`）、`src/llm/mod.rs`（`pub mod worker`）、`src/model.rs`（`ChatMessage::system`）。
- **补充（2026-08-03）：计划的呈现从"文本"改为"结构化事件"**。原先计划以 `ChatToken("📋 执行计划：…")` 混进 token 流，读起来像 AI 的回答内容；实际它是"我打算做什么"，语义层级不同。改为 `BackendMsg::ChatPlan(Vec<String>)` → `chat-plan` 事件 → 前端渲染独立卡片（`.chat-plan`），计划卡之后另起一条 assistant 气泡承接 worker 输出。代价是前端聊天记录不再是纯 `ChatMessage[]`（引入 UI-only 的 `plan` 项），回传历史时必须过滤——`ChatRole` 没有 `plan` 变体，漏过滤会导致后端反序列化失败。同批修掉的相关问题：前端把展示用的 `tool` 气泡也回传给模型，而这些消息缺 `tool_call_id`，OpenAI 会整请求拒绝；现在只回放 user/assistant 文本（模型在自己的 turn 内已经看过真实工具结果）。

---

---

## ADR-AI-6：知识库（轻量全文注入 + 连接/库级一对多绑定）

### Status
Accepted（2026-08-04 全链路落地 + 单测：数据层/命令层/AI 注入/前端设置面板均已实现，并通过 `cargo test --lib --no-default-features`（34 passed，含 KB 相关 11 个：store 5 + tools 6）+ 前端 `tsc`/`npm run build` 验证）

### Context
用户希望在设置里上传知识库、绑定到连接/数据库，AI 查询时读取知识库辅助分析。约束（来自现状盘点）：
- 仓库**零 RAG 基础**（无 embedding / 向量 / FTS5），`Cargo.toml` 追求极致二进制瘦身；
- AI 唯一外部知识注入点是 `src/llm/session.rs` 的 `context_block()`，被 Orchestrator 与所有 Worker 共享；
- `app.db` 用 rusqlite（bundled，未开 FTS5），加两张表照抄现有 PRAGMA migration 范式即可，零新依赖；
- 文件上传只有"前端读成 string 经 invoke 回传"先例（证书/SSH key 导入）。

### Decision
1. **轻量全文注入，不引向量库**——与第 6 节风险 4「当前不引入向量库」一致；知识库过大时加字符上限截断，将来撑爆上下文再升 RAG（只换检索层，可逆）。
2. **知识库 = 纯文本/Markdown**，前端 `FileReader` 读 string 经 invoke 回传，存 `app.db` TEXT（无落盘插件依赖）。
3. **绑定粒度 = 一对多，连接与数据库可选**：
   - `kb_bindings(kb_id, conn_id, database)`，`database` 为 `TEXT NULL`。**每一行是一个绑定目标**：`database IS NULL` = 绑定整条连接；`database = 'xxx'` = 仅绑定该连接下的具体库。
   - **一个文档可拥有多行绑定**（多连接、多库任意组合）——天然 Junction 表，满足用户「一个文档帮到多个链接和多个数据库」诉求。
   - 一条连接/库也可被多份文档绑定（多对多）。
4. **双注入**：`context_block()` 被动注入（每库 ≤2000 字、总计 ≤6000 字，参考 N2 的 100 表上限思路）+ 新增 `SearchKnowledge` 工具按需检索兜底大库。
5. **注入过滤逻辑**：AI 上下文已知当前 `conn_id` 与当前 `database` 时，拉取满足
   `(conn_id = ? AND database IS NULL) OR (conn_id = ? AND database = ?)` 的文档——即「整条连接级」+「当前库级」两份并集，避免向无关库注入噪声。
6. **存储**：`kb_docs(id, name, content, created, updated)` + `kb_bindings(kb_id, conn_id, database)`，明文存储（与 `queries` 表同级）；涉密可后续复用 `crypto` 加密。
7. **依赖方向**：`context_block` 与 `SearchKnowledge` 通过注入的闭包访问 kb 数据，llm crate 不强耦合 `Store`。

### Consequences
- 易：MVP 快速可用、零新依赖、符合瘦身取向；绑定粒度/检索方式/文档-目标关系**全都可逆**；前端设置页加 `kb` tab 成本极低（现有三 tab 范式照抄）。
- 难/代价：全文截断可能丢相关片段；纯文本不支持 PDF/Word（需后续引解析依赖）；多对多绑定使 UI 需支持「为一个文档增删多条绑定」，交互比单选略复杂。

### 落地计划（确认后按此实现，Craft 模式）
1. **数据层** `store/mod.rs`：建表 + `add_kb_doc / list_kb_docs / delete_kb_doc / set_kb_bindings(kb_id, Vec<(conn_id, Option<db>)>) / get_injected_kb_docs(conn_id, Option<db>)`。
2. **命令层** `commands.rs` + `main.rs`：注册上述命令（约 5–6 个 Tauri 命令）。
3. **前端** `api.ts` + `App.tsx`：`settingsTab` 加 `"kb"`，kb tab 做列表/上传（`<input type=file>` + FileReader，复用 CertPickButton 模式）/**绑定编辑器（每文档可加多条：选连接 → 可选具体库 → 增行）**。
4. **AI 注入** `session.rs`：给 `context_block` 加 `kb_loader` 闭包参数，紧跟 `search_tables` 后注入绑定知识库；`tools.rs` 加 `SearchKnowledge` 变体 + 3 处 match + 关键词检索执行逻辑（复用 `get_injected_kb_docs`）。
5. **验证**：`cargo check` 三套配置 + `tsc` + `npm run build` 全绿。
6. **收尾**：端到端试一遍（上传 → 绑连接/库 → AI 在对应库读到知识）+ 记忆更新。

---

## 5. 优先级路线图

```
Now (0-6w)          Next (1-3m)             Later (3-6m)
─────────────       ─────────────          ─────────────
N1 安全护栏  ★★★     X1 结果洞察            L1 多步 Agent
N2 上下文注入 ★★★    X2 NL→图表             L2 语义层
N3 SQL解释/优化 ★★   X3 跨库编排            L3 企业权限/审计
N4 错误诊断   ★★     X4 多会话管理          L4 私有化优化
N5 聊天体验   ★★     X5 MCP预设             L5 可观测性
N6 编辑器桥接 ★★     X6 结构问答
N7 内联增强   ★       X7 应用修改
```

**★ 说明**：N1/N2 是地基——护栏确保"不会出事"，上下文注入确保"答得对"，其余 Now 项都建在它俩之上。建议先落 N1+N2，再并行推 N3–N7。

### 5.1 当前进度与知识库后续（截至 2026-08-04）

**已落地（Agent 地基闭环 + 知识库均完成）**
- Agent A 地基：ToolRegistry（枚举分发，替原字符串 `exec_tool`）、Agent/会话循环、SessionMemory（N2 上下文注入）、policy N1 护栏（Allow / ConfirmRequired / Deny）。
- Agent B 规划：`needs_planning` 启发式 + `plan_task` 无工具规划。
- Agent C 多智能体：worker 拆分 Orchestrator / Explorer / Executor + `synthesize` 综合；串行委派、共享 `TurnControl` 可整树取消。
- 交互控制面（ADR-AI-4）：可取消 turn、写确认 UI、计划卡片。
- 知识库 ADR-AI-6：数据层 + 命令层 + 前端设置面板 + AI 双通道注入（被动 `context_block` + 主动 `SearchKnowledge`）；**已补单测**（store 5 + tools 6，总计 34 passed / 0 failed）。

**Now 阶段（地基补齐，建议先做）**
- **KB 端到端自测**：真连接上 上传→绑库→发查询，确认注入效果（单测保逻辑，E2E 保集成；本环境无显示器跑不了 GUI）。
- **写操作审计日志**（ADR-AI-1 决策3）：写确认通过后落库，事后可追溯"谁改了什么"。
- **单 turn 总超时 + token 用量统计**（ADR-AI-4 决策2/3）：成本可观测，是后续一切优化的度量地基。
- **知识库随连接导出/导入**：连接导出 yaml（#1/#2）目前不含 kb 内容，需补。

**Next 阶段（质量与深度）**
- **跨轮持久化记忆**：`SessionMemory` 仅会话内、有界 8 条，关窗即失。
- **worker 工具子集真正拆分**：Explorer 理论上不该有写工具，当前仍可调写工具。
- **复杂度路由升级 LLM 自评**：`needs_planning` 现为零成本启发式，未上 LLM 自判。
- **worker 并行调度**：当前串行委派，可并行步骤未并发（延迟/成本还有优化空间）。
- **知识库 RAG 升级**（原风险4 / L4）：换向量库或 FTS5，解决字面匹配 miss 语义改写 + 大库截断丢信息；检索逻辑已收敛在 `get_injected_kb_docs` + `SearchKnowledge` 两点，换层上层零改动（可逆）。**按需触发**：真实用起来发现字面匹配不够用时再做，现在做是过度投入。

**工程收尾**
- 全部改动（Agent 重构 + 知识库）尚未 `git commit`，建议先提交落库防丢。

**建议推进顺序**：`git commit`（零风险防丢）→ KB 端到端自测 → 审计日志 + token 统计（可观测地基）→ 其余按需。

---

## 6. 风险与待确认

1. **本地模型能力**：Ollama 等本地模型做复杂 NL→SQL 可能不准。规划默认"云端优先、本地降级"，是否要对本地模型关闭自主工具循环（仅聊天）？**待确认**。
2. **token 成本**：上下文注入（N2）在大库下仍需控制预算，懒加载阈值（多少表开始懒加载）需实测。**待确认阈值**。
3. ~~**安全边界**：N1 的"二次确认"在 Agent 多步循环里如何不打断体验又能防误写？~~ **已定（2026-08-03）：每次确认**。实现为逐条弹窗（同一轮并发多个写调用时排队，一次只显示一条）。暂不做"会话级一次性授权"——授权一次就等于把整轮的写操作都放行，而多智能体下用户看不见后续 worker 会写什么，风险与收益不匹配。若后续实测确认过于频繁，再评估"同一张表 + 同一语句类型"的窄粒度授权。
4. **是否引入向量库（RAG）**：schema 极大（万表）时，ADR-AI-2 的懒加载可能不够，需检索式注入。当前阶段不引入，记入 L4。**可后续评估**。
5. **MCP server 供应链**：X5 若内置推荐 server，需评估第三方 server 的安全边界（它能做什么）。**待评估**。

---

## 7. 建议的下一步动作

1. 先实现 **N1（安全护栏）+ N2（上下文注入）**——改动集中在 `tools.rs` / `session.rs` / `complete_sql`，可逆、低风险，且是后续一切的前提。
2. 用本文第 1 节的现状盘点做"已建/缺口"对照，避免重复造轮子（Agent 循环、MCP、流式层都**不要重写**）。
3. 评审 4 个 ADR，尤其是 ADR-AI-1 的确认交互方式（第 6 节风险 3）。
