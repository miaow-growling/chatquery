# ChatQuery 项目长期记忆

## 技术栈
Tauri v2 + React + Vite + TypeScript 桌面 SQL 客户端；Rust library crate (sqlx MySQL)。
- 前端 dev: vite :1420；后端: `cargo run --manifest-path src-tauri/Cargo.toml --no-default-features`。
- 前端改动走 vite HMR，窗口内 `Cmd+R` 刷新即生效；Rust 改动需重启 cargo。
- **Rust 编译验证正确命令（重要，踩过坑）**：验证 library 代码（即 Tauri desktop 实际编译配置）用 `cargo check --lib --no-default-features`。**不要**用 `cargo check --no-default-features`（不带 `--lib`）——它会一并编译 `src/main.rs`（TUI 二进制入口，无条件 `use ratatui`），而 `--no-default-features` 禁用了 tui feature，直接报 `unresolved crate ratatui/crossterm`。要验证完整 TUI bin 用 `cargo check`（default features 含 tui）。

## 桌面端对话框陷阱（重要，反复踩）
Tauri v2 webview **不实现** `window.prompt` / `confirm` / `alert`，在桌面窗口里静默失效
（拿到 `null` / `false` 直接 return）。任何需要输入或确认的 UI 必须走：
- 输入确认：自建 React modal（`App.tsx` 的 `promptAsync` / `confirmAsync` / `dlg`）
- 结果提示：既有 `showToast` / `toast`
切勿新增 `window.prompt` / `alert` / `confirm` 调用。

## sqlx + MySQL INFORMATION_SCHEMA 坑（重要，反复踩）
查询 `INFORMATION_SCHEMA`（`TABLES`/`COLUMNS`/`SCHEMATA`/`KEY_COLUMN_USAGE`）的**文本列**
（TABLE_NAME、TABLE_TYPE、COLUMN_NAME、DATA_TYPE、COLUMN_KEY、IS_NULLABLE、
COLUMN_DEFAULT、EXTRA、SCHEMA_NAME、CONSTRAINT_NAME、REFERENCED_* 等）在 MySQL 中
定义为 **binary 字符集**，sqlx 把它们报成 SQL 类型 `BINARY`，`try_get::<String>` 会直接报
`mismatched types ... not compatible with SQL type BINARY`。
- **修复模板**：对每个文本列 `CAST(col AS CHAR) AS col`，让它以 `VARCHAR` 回来。
- `SHOW INDEX` / `SHOW CREATE TABLE` 返回的是正常 `VARCHAR`，不受此影响，无需 CAST。
- 涉及函数：`list_databases`、`schema`、`list_tables`、`describe_table`、主键查询、
  `list_relationships`（src/db/mysql.rs）。新增任何 INFORMATION_SCHEMA 查询时务必先 CAST。

## WKWebView 合成层崩溃陷阱（macOS，反复踩，致命）
- 现象：窗口瞬间消失、无任何 JS 报错 → 是 WKWebView/WebProcess **原生崩溃**，不是 Rust panic（JS 报错只会白屏/报错浮层，不会关窗）。
- 诱因 A：`setup` 闭包里用 `with_webview` + `objc2::msg_send!` 调 WKWebView 内部 API，一旦内部 panic 会在 non-unwinding 的 objc 回调边界 unwind → `panic_cannot_unwind` → SIGABRT。**绝不在 objc/FFI 回调里裸 `msg_send!`**，必须 `catch_unwind` 或走官方/插件 API。
- 诱因 B：滚动容器(`overflow:auto`)内的 **`position: sticky` 跨轴单元格（尤其 top+left 双向 sticky，如结果表行号列）** 与页面大量 `backdrop-filter`(毛玻璃)层叠加 → WebKit 合成器崩溃。sticky-top 表头通常安全；**sticky-left 一律不用**。
- 规则：结果表格内不要 sticky-left；需要固定首列用 JS 虚拟滚动/独立固定层。凡是 sticky 的格子背景必须**不透明**，否则透出底层内容（之前"选中列头透明"就是这个）。

## 架构要点
- 连接树的环境/组是一等实体（ADR-016），可创建空容器；命令 `create_environment` / `create_group`（已注册于 commands.rs）。
- **环境绑定单一数据库类型（ADR-022）**：用户确认"新建环境时选 MySQL/Redis"，环境 `Container` 带 `db_type: Option<DbType>`，树按环境自身 `db_type` 归类（空环境也有家，不再放顶层）。新建环境弹窗用 `promptEnvType`（App.tsx 的 envType dialog 变体 + `.seg` 分段选择）。`__ungrouped` 合成环境仍按连接类型拆分。
- 分页：仅单条 SELECT 走 `query_paged` 改写 LIMIT/OFFSET + COUNT；SHOW/EXPLAIN/INSERT/UPDATE/DELETE/多语句回退普通 `query`。
- **连接池约束（用户偏好，重要）**：`src/db/mysql.rs` 的连接池**必须限制数量/内存**（用户明确要求）。采用按连接缓存的长生命周期池：全局 `OnceLock<Mutex<PoolCache>>` 做 LRU（`MAX_CACHED_POOLS=64` 实例上限）+ 每池 `MAX_CONN_PER_POOL=4` + `idle_timeout=30s`+`min_connections(0)`（空闲连接归零，缓存只留几 KB 元数据）。key=`host:port:user:password:database`（含密码→改密自动失效；删连接无需显式 invalidate，LRU 淘汰）。**不要**无限制新建短生命周期池（曾导致 EOF 与连接抖动）。调用点**禁止 `pool.close()`**（池被共享缓存，关闭会影响其他查询）。
- **大库性能策略（重要）**：8000+ 表的库曾两处卡死 → 已改为"懒加载 + 有界"。
  - 编辑器自动补全**不再**在选中库时拉全量 schema：移除 `editor.ts` 的 `setSchema(全量map)`，改 `setSchemaContext(connId,db)` + 自定义异步 `CompletionSource`（挂在 `MySQL.language.data`）按需按前缀调 `search_tables`(LIMIT 200) / `list_columns`，带客户端小缓存。
  - 后端 `search_tables`(`INFORMATION_SCHEMA.TABLES`, 前缀 `LIKE` + `LIMIT`, 通配符已转义) 取代 `list_tables` 用于补全/过滤；`list_tables` 仍用于树预取全量（仅建 Node 不一次性渲染）。
  - 树表文件夹用 `FolderView` 窗口化(`TREE_PAGE=200`)+ 过滤输入框，**禁止一次性渲染几千节点**（曾因 8000 个 `<div>` 冻结主线程）。
  - 遗留：`schema()`(供 AI 补全 `complete_sql` 经 `schema_cache`)仍全量拉列；首次对超大库用 AI 补全会卡一次，需要时给 `schema()` 加 `LIMIT` 截断。

## Agent 架构（2026-08-03 决策）
- **方向：多智能体（C）**。用户明确选 C（Orchestrator + 专项 worker：Explorer/Executor/Analyst/MCP Bridge），但落地必须走 A→B→C：A 是地基（C 的硬前置），B 的"规划"能力由 Orchestrator 吸收。当前**已完成 A 地基**（src/llm/）：
  - `ToolRegistry`（`tools.rs`）：用 `BuiltinTool` 枚举取代原 `exec_tool` 字符串分发（async trait 不能 dyn，故用枚举而非 Box<dyn Tool>）；MCP 工具仍按 `mcp__server__tool` 名路由。worker 未来 = 不同 `BuiltinTool` 子集。
  - `Agent` 结构体（`session.rs`）：持有 `cfg/conns/mcp/registry/memory`，`run()` 即原 ReAct 循环；`run_turn` 改为构造 `Agent` 的入口，签名加 `conn_id`。
  - `SessionMemory`（`memory.rs`）：工作记忆（current_conn/current_db/last_results 有界 8），供系统提示与跨轮记忆。
  - `policy.rs`（**N1 护栏，ADR-AI-1**）：`check_statement` → `Allow`(只读) / `ConfirmRequired`(写操作，暂拒绝并说明) / `Deny`(DDL/破坏性/未知)。执行 `execute_query` 前对 MySQL 跑策略闸，破坏性 SQL 不触库即拒。
  - **N2 上下文注入**：`build_system_prompt` 循环前构造 system 消息，含可用连接 + 当前连接 + 当前库最多 100 张表（复用 `search_tables`），模型首次获得真实 schema 感知。
  - **并行**：同一轮多个 `tool_calls` 用 `futures::join_all` 并发执行。
- 设计取舍（用户已确认 C）：多智能体代价=委派额外 LLM 调用+结果回传搬运+调试难+编排者可能循环；收益=能力隔离、单 worker 上下文小更省 token、加能力=加 worker。
- **已完成 B 规划能力**（`planner.rs`，2026-08-03）：`needs_planning` 零成本启发式路由（多步连词/Join/多 FROM/history≥4 → 复杂）；`plan_task` 一次**无工具** LLM 调用产出 `Vec<String>` 步骤（plan 专用 system + 当前库≤30表上下文，容错剥编号/中文序号）；`session.rs` 接入——`Agent::run` 开头路由，复杂则 plan 喷给用户（`ChatToken` 📋，前端零改可见）+ 注入 `build_system_prompt(plan=?)` 作为执行约束。`plan` 是结构化步骤列表，未来 C 可直接遍历委派给 worker；planner 失败安全降级为直接 ReAct；简单任务零额外 LLM 开销。
- **已完成 C worker 拆分首台阶**（`worker.rs` + `session.rs` 重构，2026-08-03，`cargo check --lib --no-default-features` 零警告）：
  - 新增 `worker.rs`：`WorkerKind` 枚举（Orchestrator/Explorer/Executor）+ `system_prefix`（角色化系统提示前缀）+ `classify_step`（零成本启发式：探索类关键词/show/describe → Explorer，否则 Executor）。
  - `Agent` 增 `role: WorkerKind` 字段；`build` 默认 Orchestrator，`build_worker(role, ...)` 构造带角色的独立子 Agent（fresh `SessionMemory` + 独立上下文窗口，工具结果不污染 Orchestrator）。
  - `session.rs` 抽出可复用 `react(&mut self, messages, tx) -> Option<String>`（原 ReAct 循环，返回最后 assistant 文本供汇总）；`run` 重组为两条路径：
    - **简单任务**（`!needs_planning`）：单 ReAct，零额外 LLM 开销（保持 B 行为）。
    - **复杂任务**：`plan_task` → 逐步委派——每步 `classify_step` 路由到 Explorer/Executor worker，`build_worker_system` 注入「全局计划 + 当前步 + 前序结果」，`worker.react` 跑独立 ReAct，`react` 首个 token 用 `[角色]` 前缀归因 → Orchestrator `synthesize` 一次无工具 LLM 调用综合成面向结论的答复（📊 前缀）。
  - 串行委派（步骤可能依赖，且稳延迟/成本）；planner 失败仍降级为直接 ReAct。
  - 架构收益：每步独立上下文窗口避免长任务 token 污染；角色隔离提升聚焦。**代价**：复杂任务 = plan(1) + N×worker + synthesize(1) 次 LLM 调用，延迟与成本上升（已在 ADR-AI-5 写明，属刻意取舍）。
  - `model.rs` 加 `ChatMessage::system` 构造器供 synthesize 用。
- **已完成 交互控制面**（`control.rs` + 全链路，2026-08-03，三套 Rust 配置 + 前端 tsc/build 全通过）：
  - 新增 `src/llm/control.rs`：`TurnControl`（Tauri 无关、含 3 单测）= `cancelled: AtomicBool` + `Notify` + `pending: Mutex<HashMap<String, oneshot::Sender<bool>>>`。API：`cancel()`/`cancelled()`(await)/`register_confirm()->(id, rx)`/`resolve(id, approved)`/`cancel_confirmations_only()`（TUI 降级用，写操作立即拒）。
  - **写确认 UI**：`policy.rs` 的 `ConfirmRequired` 不再硬拒 → `exec_with_policy` 注册 oneshot、发 `BackendMsg::ChatConfirm(ConfirmRequest)` → Tauri emit `chat-confirm` → 前端 `confirmQueue` + 自建 modal（拒绝/红色执行）→ `resolve_confirm` 命令回填。**300s 超时**防 webview 刷新挂死；拒绝/超时以**工具结果**回灌"用户拒绝，不要重试"。DDL/破坏性仍 `Deny`，不开确认通道。
  - **可取消 turn（ADR-AI-4）**：`chat_turn` 同步返回 `turn_id`，`AppState.turns: Mutex<HashMap<String, TurnControl>>` 登记；新命令 `cancel_turn`；`react`/`synthesize` 用 `tokio::select!{ biased; _ = ctl.cancelled() => break, r = stream_chat(...) }` 竞速 + 每步/每轮检查点。worker **共享同一 ctl**（一次取消停整棵树）。取消≠失败：吞错发 `⏹ 已取消。`。
  - **计划卡片**：`plan` 改发 `BackendMsg::ChatPlan(Vec<String>)` → emit `chat-plan` → 前端 `ChatItem` 联合类型 + `.chat-plan` 卡片（`<ol>` 步骤）独立渲染。
  - 顺带修两个预存 bug：① 桌面 `run_turn` 不发 `ChatDone` 致 `streaming` 卡 true；② 前端把展示用 `tool` 气泡回传模型（缺 `tool_call_id` → OpenAI 400），现只回放 user/assistant 文本。
  - **坑**：`tokio::select!` arm 借用贯穿整句，`schemas()`/`on_delta` 闭包必须具名绑定（否则 E0716）；`BackendMsg` 新增变体后 `src/main.rs` TUI match 与 commands.rs 桥接都要补 arm（E0004）；终端错误/`ChatDone` 必须塞回 `tx` 由桥接顺序 emit，直接 `app.emit` 会插队截断消息。
- 仍待做（C 后续）：写操作审计日志（ADR-AI-1 决策3）、单 turn 总超时 + token 用量统计（ADR-AI-4 决策2/3）、跨轮持久化记忆、复杂度路由升级 LLM 自评、worker 并行调度（可并行步骤并发）、worker 工具子集真正拆分（Explorer 去写工具）。
