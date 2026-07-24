# 本地数据库终端工具 — 架构设计

> 目标：一个本地终端程序，替代 Navicat 做 MySQL / Redis 查询，资源占用小，并接入 LLM 对话查询与 MCP 工具。
> 状态：设计基线（已与用户确认关键决策）

---

## 1. 核心矛盾与解决方案

「资源占用小」与「跑 LLM + MCP」天然冲突。本设计用三道隔离把主程序内存压到最低：

- **LLM 算力外推**：走云端 OpenAI 兼容流式 API，主程序只持有网络缓冲，几乎零额外内存。
- **MCP 进程隔离**：MCP server 作为独立 OS 子进程（stdio）按需拉起，空闲回收，崩溃不影响主程序。
- **原生编译**：Rust 单二进制，无 GC、RSS 可控、启动快。

---

## 2. 已确认的关键决策

| 维度 | 决策 | 代价 |
|------|------|------|
| 语言 | Rust（原生编译） | 编译慢、学习曲线陡 |
| LLM | 云端 OpenAI 兼容流式 API | 需网络 + Key；SQL/结构发往云端（隐私） |
| UI | 完整交互式 TUI（ratatui） | 开发量最大 |
| MCP | stdio 子进程按需拉起 | spawn 延迟；需管理子进程生命周期 |

---

## 3. 架构选型：模块化单体（单二进制）

**理由**：本地单用户 CLI 工具，无独立扩展/团队边界需求。微服务或独立服务只会增加运维与常驻资源开销。
**做法**：单二进制内部按 bounded context 划分模块，模块间单向依赖 + trait 隔离外部依赖，未来可单独抽离而不必重写。

### C4 Container 视图

```
┌──────────────────────────────────────────────────────────────┐
│                         TUI 层 (ratatui + crossterm)            │
│   连接面板 │ 查询编辑器 │ 结果表格 │ Chat 面板 │ MCP 面板 │ 状态栏 │
└───────────────────────────────┬──────────────────────────────┘
                                 │  (App State / 事件总线)
┌───────────────────────────────┴──────────────────────────────┐
│                    应用编排层 (tokio async runtime)             │
└───────┬───────────────┬───────────────┬───────────────┬───────┘
        │               │               │               │
┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼──────┐ ┌──────▼───────┐
│  连接管理     │ │  QueryEngine │ │  LLMChat   │ │   MCPHost    │
│  (SQLite)    │ │ MySQL/Redis  │ │ 流式+工具  │ │ stdio 子进程  │
│  连接池/配置  │ │  适配器      │ │  编排      │ │ 生命周期管理  │
└──────────────┘ └──────────────┘ └────────────┘ └──────────────┘
        │               │               │               │
   ~/.config/app/db  sqlx/mysql     reqwest(流式)    spawn 进程
                    redis crate     tool_calling     JSON-RPC
```

---

## 4. 模块职责与接口

### 4.1 连接管理（Connections）
- 职责：MySQL / Redis 连接配置的增删改查、连接池、健康探测。
- 存储：本地 SQLite（`~/.config/<app>/app.db`）；密码走 OS keychain 或加密字段，不落明文。
- 接口：`connect(id) -> Pool`、`list() -> [ConnMeta]`、`introspect(connId) -> Schema`。

### 4.2 QueryEngine
- 职责：对统一查询接口屏蔽 MySQL/Redis 差异。
- 适配器：
  - `MysqlAdapter`：`sqlx` 异步执行，返回表格结果（列头 + 行）。
  - `RedisAdapter`：执行命令，返回键值 / 列表 / 状态；提供键空间浏览。
- 接口：`execute(connId, statement) -> QueryResult`（统一 `tabular | kv | status` 三态）。

### 4.3 LLMChat
- 职责：流式对话、schema 上下文注入、工具调用编排。
- 行为：把当前连接的结构（脱敏后）作为 system context；当 LLM 返回 `tool_call` 时，路由到 MCP 工具或内置工具（如「执行查询」）。
- 接口：`chat(stream, tools) -> TokenStream`；`dispatch(toolCall) -> ToolResult`。

### 4.4 MCPHost
- 职责：MCP stdio 客户端，按需 spawn 子进程，JSON-RPC over stdin/stdout。
- 生命周期：配置驱动 spawn → `initialize` → `list_tools` 注册到 LLM → 调用 → 空闲 TTL 后 `kill`。
- 接口：`load(serverCfg) -> McpClient`、`callTool(name, args) -> ToolResult`。
- 容错：子进程崩溃 → kill + 标记工具不可用，主程序继续。

### 4.5 TUI
- 职责：布局与交互（ratatui）。连接面板、查询编辑器（textarea）、结果表格、Chat 面板、MCP 面板、状态栏。
- 事件循环：`tokio` + `crossterm`，UI 渲染与异步任务分离。

### 4.6 编排层
- 职责：持有 `AppState`，连接各模块，驱动事件总线。

---

## 5. 架构决策记录（ADR）

### ADR-001：采用 Rust 单二进制原生程序
- **Context**：需要资源小、本地常驻、交互式 TUI。
- **Decision**：Rust + tokio（异步）+ ratatui/crossterm（TUI），编译为单原生二进制（release + strip）。
- **Consequences**：
  - ✅ 二进制 10–20MB、无 GC 停顿、RSS 可控、启动快；异步生态成熟（sqlx、reqwest）。
  - ❌ 编译慢、学习曲线陡；UI 状态需谨慎处理借用。
  - 🔁 可逆性：用 trait 隔离外部依赖，未来换语言只需重写适配层。

### ADR-002：LLM 走云端 OpenAI 兼容流式 API
- **Context**：本地跑模型 1–8GB，与「资源小」冲突。
- **Decision**：默认云端流式 API，支持自定义 `base_url`（兼容网关）；用 `tool_calling` 触发 MCP/内置工具。
- **Consequences**：
  - ✅ 主程序内存几乎不变，能力随模型升级。
  - ❌ 需网络 + Key；SQL/结构发往云端（隐私风险）→ 提供「仅结构/脱敏」选项，并预留本地模型可插拔位。
  - ❌ 延迟受网络影响。

### ADR-003：MCP 以 stdio 子进程按需拉起
- **Context**：MCP server 可能用任意语言实现且吃资源，需隔离。
- **Decision**：实现 MCP stdio 客户端（JSON-RPC over stdio），按配置 spawn，空闲 TTL 后 kill；`list_tools` 注册到 LLM 工具集。
- **Consequences**：
  - ✅ 进程隔离，崩溃不影响主程序；资源不常驻。
  - ❌ spawn 有延迟；需管理生命周期、超时、僵尸进程。
  - 🔁 本期不做 SSE 远程，但接口预留。

### ADR-004：本地 SQLite 持久化（非独立 DB 服务）
- **Context**：需存连接配置、查询历史、聊天历史、设置。
- **Decision**：`rusqlite` 存于 `~/.config/<app>/app.db`；密码加密或走 keychain。
- **Consequences**：
  - ✅ 零外部依赖、单文件、易备份。
  - ❌ 单写者并发限制（本地单用户无碍）。

### ADR-005：模块化单体而非微服务
- **Context**：本地 CLI，无独立扩展/团队边界需求。
- **Decision**：单二进制，内部模块边界 + 单向依赖。
- **Consequences**：
  - ✅ 简单、资源省、易调试。
  - ❌ 若未来要拆远程服务需重构 → 模块按上下文划好便于迁移。

### ADR-006：惰性加载 + 有界内存，拒绝「连接越多越卡」
- **Context**：主流 DB GUI（Navicat 等）在连接时把全量库表结构与数据预载进内存，连接数增多后内存线性膨胀、交互变卡。本工具目标是「连接数增长，内存保持平稳」。
- **Decision**：
  1. **惰性元数据**：仅当用户展开某连接/库时才按需查 `information_schema`，绝不连接即预取。
  2. **有界结果集**：查询默认 `LIMIT` + 服务端游标分页（"加载更多"）；用 sqlx 流式 `fetch` 增量渲染，不在内存持有全量结果。
  3. **受限连接池**：每连接池上限（如 1–5），空闲超过 TTL 自动回收。
  4. **LRU 元数据缓存**：带容量上限与 TTL，可随时淘汰、按需重取。
  5. **Redis 键空间**：用 `SCAN` 游标增量浏览，禁用 `KEYS *`。
- **Consequences**：
  - ✅ 内存随连接数近似常数——10 个连接与 1 个连接的工作集几乎相同（仅活跃连接占内存）。
  - ✅ 连接瞬间快（不扫全库）。
  - ❌ 首次展开某库有小幅元数据延迟（用转圈提示掩盖，可接受）。
  - 🔁 可逆：若某场景确需常驻缓存，可在 LRU 上限内放开，不撼动整体架构。

### ADR-007：Redis 结果统一为 `DisplayResult` 联合类型，而非强塞表格
- **Context**：MySQL 返回固定表（列 + 行），Redis 返回命令结果（单值 / 数组 / 状态），形状本就不同。强行把 `GET`/`HGETALL`/`SCAN` 拍平进 `QueryResult` 的"列+行"会丢失语义（如 `HGETALL` 是 field/value 交错数组，当表格渲染反而难读）。
- **Decision**：引入 `DisplayResult` 联合枚举（`Table(QueryResult)` / `Redis(RedisResult)`）。`app.run_query` 按 `DbType` 分派；`ui::render_result` 对联合做 `match` 分派渲染——MySQL 走 `Table`，Redis 用 `List`（带命令回显 `$ <cmd>`、序号、截断时追加提示行），空结果或拒绝（`KEYS`）展示 `note`。
- **Consequences**：
  - ✅ 两类结果各自最佳呈现，Redis 数组/状态一目了然。
  - ✅ 未来接入更多 DB 类型只需往联合里加一个变体，TUI 一处 `match` 即可。
  - ❌ 多一处分派（`app.rs` / `main.rs` / `ui.rs` 各一行 `match`），但成本极低。
  - 🔁 可逆：若某天 Redis 也要表格视图（如 `HGETALL` 专显），可在 `RedisResult` 上附加可选表格表示，不影响 MySQL 路径。

### ADR-008：按限界上下文拆分目录（模块化工程结构）
- **Context**：Phase 1–2 把源码平铺在 `src/` 顶层（`app/ui/event/storage/error`），仅 `db/` 拆出。随着 Phase 3（LLM）与 Phase 4（MCP）加入，顶层会越来越挤，且 LLM/MCP 与 TUI 混在一起，违背 ADR-005/006 的「模块化单体 + 隔离」精神。
- **Decision**：按 bounded context 划分模块，每个上下文一个目录（不为「将来可能拆微服务」提前建空层，只为**已存在的上下文**建目录）：
  ```
  src/
  ├── main.rs        # 入口：runtime 构建 + TUI 主循环编排
  ├── error.rs       # 统一错误 AppError
  ├── config.rs      # LLM 配置（env：CHATQUERY_LLM_*）
  ├── model.rs       # 跨模块共享类型：DisplayResult / BackendMsg / ChatMessage
  ├── store/         # SQLite 持久化（原 storage.rs）
  ├── db/            # 查询上下文：connection / mysql / redis
  ├── llm/           # 对话上下文：client / session / tools   ← Phase 3
  ├── mcp/           # MCP 宿主上下文：transport / host         ← Phase 4
  └── tui/           # 界面上下文：app / ui / event
  ```
  依赖方向单向：`tui → {model, db, llm}`；`llm → {db, model}`；`db → {store, model}`；底层 `model/store/error` 不反向依赖上层。
- **Consequences**：
  - ✅ 边界清晰，新人无需通读即可定位；未来把 LLM/MCP 抽成独立服务成本低（ADR-005 的可迁移性落地）。
  - ✅ LLM 流式、DB 查询、TUI 渲染各自封闭，编译单元更小、改一处影响面可控。
  - ❌ 多一层 `mod`/`use` 路径（一次性迁移成本），文件数变多。
  - 🔁 可逆：若某上下文膨胀，可在其内部继续按子域细分（如 `tui/widgets/`），不影响其他模块。

---

### ADR-009：MCP server 以独立子进程运行（stdio 进程隔离）
- **Context**：用户要求「接入 MCP 工具处理」。MCP 工具多来自不可信/不稳定的第三方进程（文件系统、shell、各类 API 封装）。若在主程序内嵌运行，其内存、崩溃或死循环都会直接拖垮这个主打「资源小、稳定」的本地工具。
- **Decision**：每个 MCP server 作为**独立 OS 子进程**启动，stdio 传输裸 JSON-RPC 2.0（`initialize` → `notifications/initialized` → `tools/list` → `tools/call`）。`McpHost` 管理生命周期，全部工具以 `mcp__<server>__<tool>` 命名空间注册进 LLM。配置从 env `CHATQUERY_MCP_SERVERS`（JSON 数组）读取，**不落盘**（ADR-004）。
- **Consequences**：
  - ✅ 进程隔离：MCP 崩溃/OOM 不影响主程序（ADR-003 精神）；其内存不计入主程序 <30MB 工作集。
  - ✅ 懒连接 + 崩溃跳过：`McpHostManager` 首次用到才 spawn，连不上的 server 仅 stderr 警告并跳过，不会让整个 LLM 会话失败。
  - ✅ 零新增依赖：纯 `std::process` + 行分隔 JSON-RPC，release 二进制仅 +0.1MB（3.0→3.1MB）。
  - ❌ 子进程调用为**同步** stdin/stdout（本地管道，毫秒级），当前在持有 `tokio::Mutex` 期间执行；极端并发多 server 调用会串行化。
  - ❌ 未实现空闲回收 / 自动重连（进程驻留到退出，或崩溃后本次会话该 server 不可用）——Phase 4 范围。
  - 🔁 可逆：未来若要内嵌可信 MCP，可加 in-process 传输实现，不影响 stdio 路径。

---

### ADR-010：连接配置在落盘时加密（AES-256-GCM，密钥文件隔离）
- **Context**：Phase 1–4 的连接密码以明文 JSON 存于 `~/.config/chatquery/app.db`。一旦该文件被误提交 / 纳入备份 / 共享，凭据即泄露。ADR-004 早就要求「不写明文凭据」，但之前只是把 LLM/MCP 配置放到 env，DB 连接密码仍未解决。
- **Decision**：连接记录整条 JSON 在写入 SQLite 前用 **AES-256-GCM** 加密（`src/crypto.rs`），32 字节密钥独立存于 `~/.config/chatquery/key`（**0600** 权限）。读取时解密；解密失败则回退明文解析（兼容旧库），并在加载时把旧明文记录**就地重写**为密文，使数据库首次加载后即全加密。新增依赖 `aes-gcm` + `getrandom` + `base64`。
- **Consequences**：
  - ✅ 被动泄露防护：泄露/同步 `app.db` 不再暴露任何凭据（密文 + 独立密钥文件，缺密钥无法解密）。
  - ✅ 内存中仍为明文（查询时需要），但「静态存储」已无明文——满足 ADR-004 核心目标。
  - ✅ release 二进制仅 +0.1MB（3.1→3.2MB）。
  - ❌ **威胁模型有限**：仅防被动泄露，不防已获用户账户的攻击者（他能同时读 key 与 db）。要彻底隔离需 OS keychain（macOS Keychain / libsecret），列为未来可选项（不引入跨平台 keychain 依赖以保持轻量）。
  - 🔁 可逆：若改用 OS keychain，只需替换 `crypto::load_key/encrypt/decrypt` 实现，存储层接口不变。

### ADR-011：连接管理内置于 TUI（表单 + 删除确认），而非仅 CLI
- **Context**：Phase 1–5 只能靠 `chatquery add` CLI 落库连接，TUI 里连接面板只支持上下选择。作为 Navicat 替代品，连「加/改/删连接」都要切到终端敲命令行，体验割裂，且密码在明文命令行参数里易泄露进 shell 历史。
- **Decision**：在 TUI 的 `Connections` 焦点内提供 `a` 新增 / `e` 编辑 / `d` 删除（二次确认）/ `Enter` 或 `Tab` 进入查询。新增/编辑走一个**覆盖式表单弹窗**（`ConnForm`）：7 个字段（名称/类型/主机/端口/用户/密码/库），`db_type` 用 ← → 切换（封闭枚举），文本字段复用单 `TextArea` 在切换时在两缓冲间搬运；`Ctrl+S` 保存、`Esc` 取消。删除走 `y` 确认的居中弹窗。持久化复用已有 `ConnectionStore::add/update/remove` + `Storage::delete_connection`（连接密码仍走 ADR-010 加密落盘）。
- **Consequences**：
  - ✅ 连接全生命周期可在 TUI 内闭环，无需离开终端；编辑/删除直接改密文记录。
  - ✅ 密码不再经过 `ps`/shell 历史（CLI 参数全会进 history），改为 TUI 内临时明文（仅内存，不落盘明文）。
  - ✅ 表单用「单 TextArea + 字段缓冲」而非每字段一个 widget，内存/复杂度可控（符合 ADR-006）。
  - ❌ 表单非全屏编辑器，仅单行字段；多行/复杂值（如含换行的备注）暂不支持——当前连接字段均为单行，足够。
  - 🔁 可逆：表单状态全在 `App.form`，不影响存储层；将来要换更重的编辑器（如弹出 vim）只需替换 `render_form`/`handle_form_key`。

### ADR-012：查询结果上云前脱敏（仅云路径，本地 TUI 不变）
- **Context**：LLM 工具 `execute_query` 把查询结果作为 `detail` 原样回灌给**云端**模型。MySQL/Redis 里的手机号、邮箱、身份证、token、密码等字段会直接泄露给第三方。这是 Phase 1–5 一直悬而未决的隐私债（见各阶段"已知限制"）。
- **Decision**：新增 `src/mask.rs`，对回灌模型的 `detail` 做**脱敏副本**（本地 TUI 仍显示真实数据，因为终端属于用户自己）。两套互补规则：① 列名规则——列名含敏感词（password/token/phone/email/id_card…）整列脱敏；② 值规则——用**单个组合正则**（手机/邮箱/身份证/13–19 位长数字）在任意列/Redis 行里脱敏命中值。脱敏风格保留前缀+后缀（`138****5678`、`110***********002X`），中间打码，避免二次匹配串扰（单次非重叠匹配，不级联）。**默认开启（fail-safe）**，可用 `CHATQUERY_MASK_RESULTS=0|off|false|no` 关闭；发起对话时状态栏显示「结果脱敏:开/关」。
- **Consequences**：
  - ✅ 默认值安全：即使忘了配置，上云数据也已脱敏；本地查询/导出不受影响（真实数据仍在用户手中）。
  - ✅ 双规则互补：列名规则兜住"列名即敏感"的整列，值规则兜住混在正常列里的敏感值（如 `remark` 含手机号）。
  - ✅ 单组合正则一次非重叠 pass，无级联打码、无重复匹配导致的乱码（早期多正则串行版曾出现只打部分字符的级联 bug，已修）。
  - ✅ 依赖仅 +`regex`（release +0.6MB → 3.8MB），纯本地计算，不联网、不拖慢查询。
  - ❌ 规则是启发式：陌生列名/非标准格式可能漏脱敏或误脱敏（如把订单号当卡号打码）。属可控误报/漏报，非正确性缺陷。
  - 🔁 可逆：仅作用在 `exec_builtin` 的 `detail` 字符串（云路径），与存储层、TUI 显示完全解耦；改规则/加白名单只需动 `mask.rs`。

### ADR-013：TUI 交互重构 — Tab 栏 + Ctrl 直切 + 快捷键栏 + 焦点边框
- **Context**：Phase 1–6 的 TUI 有三个可聚焦面板（Connections / Editor / Chat），用 Tab 循环切换。问题：① Query 和 Chat 模式外观完全相同，只靠标题文字区分；② 按键提示挤在各面板标题栏，小终端截断；③ 连接列表无健康状态指示；④ 表单密码字段明文显示。
- **Decision**：
  - 右侧上方加模式 Tab 栏（Query / Chat），Ctrl+1→Connections、Ctrl+2→Editor、Ctrl+3→Chat 直切（Tab 循环保留）；
  - 底部拆成两行：快捷键提示栏 + 运行状态栏（面板标题回归简洁）；
  - 焦点面板边框用亮色（Cyan+BOLD）高亮，非焦点用暗灰色（DarkGray）；
  - 连接列表加健康圆点（● 绿 = 最近查询成功 / ○ 红 = 最近失败 / ○ 灰 = 未测试），追踪于 `App.conn_status: HashMap<String, ConnStatus>`，查询成功/失败经 `BackendMsg::ConnHealth(id, ok)` 更新；
  - 表单密码字段（非活跃时）显示 `***` 替代明文。
- **Consequences**：
  - ✅ 模式区分清晰（Tab 栏 + 焦点边框），不再需要"看标题猜模式"；
  - ✅ 快捷键集中一处、不截断；
  - ✅ 连接状态可视化（绿/红/灰圆点）；
  - ✅ 密码不再明文泄露到屏幕；
  - ⚠️ 底部多占 1 行（总共 2 行 vs 之前 1 行），但终端 40 行高度下影响极小；
  - ⚠️ `conn_status` 只记录"最近一次查询"的成败，不是持续连接状态（因 ADR-006 惰性加载：我们不维持长连接池）；
  - 🔁 可逆：所有改动只在 `ui.rs` + `app.rs` 的渲染/事件层，不影响存储/DB/LLM/MCP 模块。

### ADR-014：桌面端采用 Tauri（WebView 前端 + Rust 后端命令）
- **Context**：用户希望有类似 Navicat 的桌面体验，并明确要求 SQL 编辑时的自动提示/补全。原 TUI 是纯终端界面，补全需手写弹窗且观感有限；而补全能力是其核心诉求。后端（db/llm/mcp/mask/store/crypto）自 Phase 1 起就与 UI 解耦成纯 Rust 模块，换前端不必重写逻辑。
- **Decision**：
  - 引入 Tauri v2 桌面壳：`src-tauri/`（Rust 命令层 + `tauri.conf.json` + capabilities）+ `frontend/`（Vite + React + TypeScript + CodeMirror 6）。
  - 根包 `chatquery` 重构为 **library**：`src/lib.rs` 暴露所有后端模块；原 TUI 保留为 `pub mod tui`（gated 在 `tui` feature 下），`cargo run --features tui` 仍可跑终端版。
  - 后端函数暴露为 Tauri commands：`list/add/update/delete_connection`、`test_connection`、`execute_query`、`get_schema`、`chat_turn`、`get_status`。LLM 流式输出经 Tauri 事件（`chat-token`/`chat-tool`/`chat-done`/`chat-error`）推给前端，等价于旧 TUI 的 `BackendMsg` 通道。
  - 前端用 **CodeMirror 6 + `@codemirror/lang-sql`**：连接选中时调用 `get_schema` 取 `INFORMATION_SCHEMA` 的表/列（按连接惰性缓存于 `AppState.schema_cache`），实现 schema-aware 自动补全——这是选 Tauri 而非 TUI/原生 GUI 的关键理由（现成工业级编辑器，零自研补全）。
  - 密码不回传前端：`list_connections` 返回不含 password 的摘要；编辑连接时密码留空 = 保留原值（密码始终只在 Rust 侧）。
- **Consequences**：
  - ✅ SQL 编辑获工业级语法高亮 + 表/列自动补全，体验最接近 Navicat；
  - ✅ 后端零重写——同一套 domain 逻辑被 Tauri 与 TUI 双前端复用；
  - ✅ 跨平台（macOS/Windows/Linux 共用系统 WebView，不打包浏览器）；
  - ⚠️ 内存比 TUI 高一个量级：常驻约 50–150MB（WebView 进程），与原需求"小占用"冲突——这是用户明确选择接受；
  - ⚠️ 启动依赖前端构建产物（`frontend/dist`）；开发期 `tauri dev`（前端本地 CLI）自动起 Vite dev server；
  - 🔁 可逆：Tauri 命令层是薄适配（仅 DTO 转换 + 事件桥接），换回纯 TUI 或换原生 GUI 都不动后端。
  - ▶️ 运行：先 `cd frontend && npm install`；开发用 `./frontend/node_modules/.bin/tauri dev`（或 `cd frontend && npx tauri dev`，因本机 `cargo` 未装 `tauri` 子命令）。发行 `./frontend/node_modules/.bin/tauri build`。终端版回退：`cargo run --features tui`。⚠️ `tauri.conf.json` 的 `beforeDevCommand` 必须用绝对路径 `npm --prefix`（否则 Tauri 以 frontend 为 cwd 执行时双重嵌套 `frontend/frontend/...` 导致 ENOENT）。

### ADR-015：左侧导航树 + 连接按「环境→分组」聚合
- **Context**：用户看了 Tauri 桌面端后要求：(1) 连接能按**环境**（生产/测试/开发）分组，环境下还能再分组；(2) 表可展开看列；(3) 接近 Navicat 左侧菜单的基本功能。原桌面端左侧是扁平连接列表，无树、无分组、表不可展开。经确认，本阶段范围收敛为：**只读浏览 + 结构展开**（点表→`SELECT * LIMIT N` 网格；双击列名→插入编辑器），不含数据写回。
- **Decision**：
  - `ConnectionConfig` 增加 `env: String` 与 `group: String`（均 `#[serde(default)]`，向后兼容旧连接），纯展示元数据，后端只存不路由；连接表单新增「环境」「分组」输入。
  - 后端新增**惰性** introspection 函数（每条按 ADR-006 有界）：`list_databases`（INFORMATION_SCHEMA.SCHEMATA，排除系统库）、`list_tables`（TABLES，返回 `TableMeta{name,is_view}`）、`list_columns`（COLUMNS，含 key/nullable/default）、`browse_table`（`SELECT * FROM \`db\`.\`tbl\` LIMIT n`，标识符 sanitize 防注入）；Redis 侧 `list_redis_dbs`（CONFIG GET databases + 各 db DBSIZE）、`list_redis_keys`（SCAN 限长）、`browse_key`（按 TYPE 返回 string/hash/list/set/zset 值）。均暴露为 Tauri 命令（`src-tauri/src/commands.rs`）。
  - 前端新增 `Tree.tsx`：按 `env→group→连接` 聚合，连接以下节点**惰性展开**（点击才发请求，结果按节点 key 缓存）；点表→只读网格；双击列名→插入编辑器；Redis 走 `db→key` 子树。
  - 密码仍不回传；`browse_*` 只读，无写回（用户确认的范围）。
- **Consequences**：
  - ✅ 左树层级接近 Navicat，连接可多层分组，表/列可展开浏览；
  - ✅ 惰性加载：展开才查，不预载全库，内存仍受 ADR-006 约束；
  - ✅ 后端零重写，仅加函数 + Tauri 命令薄适配；
  - ⚠️ 范围按确认收敛为「只读浏览 + 结构展开」——未做数据网格行内编辑、表结构/DDL 编辑、函数/事件/索引/外键节点、用户管理/导入导出，列为后续；
  - ⚠️ Redis 树为近似 Navicat-for-Redis：db 仅列有键的索引，key 用 SCAN 采样（限 300），超大键空间不一次展开；
  - 🔁 可逆：树是纯前端组件，后端 introspection 命令均为只读 SELECT/SCAN，可随时加写回或更多节点。

### ADR-016：环境/组提升为「一等容器实体」（支持空容器）
- **Context**：ADR-015 把 `env`/`group` 作为 `ConnectionConfig` 上的**派生字符串字段**，树在前端聚合。用户随后要求"空容器"——点「新建组 / 新建环境」应立即在树里出现一个**没有任何连接的空文件夹**（Navicat 行为），而不是必须先建连接、用预填字段"蹭"出分组。派生字段模型无法表达"无连接的组"，因此环境/组需成为**独立持久化的实体**。
- **Decision**：
  - 新增 `Container { id, kind: Env|Group, name, parent(组的 env_id), ord }`（`src/db/container.rs`），存于 SQLite 新表 `containers`（id/kind/name/parent/ord）。连接不再携带 `env`/`group` 字符串，改为 `group_id: Option<String>` 指向所属组；组的父环境由 `parent` 上溯得到。`None` 表示"未分组"，前端用合成环境「未分组」兜底。
  - `ConnectionStore` 持有 `containers`，新增 CRUD：`create_env` / `create_group(env_id, name)` / `rename_container` / `delete_container`（**非空拒绝**：环境有子组或连接、分组有连接时返回 Err，避免孤儿连接）。
  - 一次性迁移：旧连接 blob 仍含 `env`/`group` 字符串（`LegacyConnection` 兼容解析）；`ConnectionStore::load` 对缺 `group_id` 的连接，按 `(env, group)` 合成容器并回填 `group_id`，再写回，使旧库自洽。
  - 新增 Tauri 命令：`list_tree`（返回 `TreeModel { environments→groups→connections }`，空容器自然出现）、`create_environment`、`create_group`、`rename_container`、`delete_container`；原 `list_connections` 被 `list_tree` 取代。前端 `Tree.tsx` 改为消费 `TreeModel`，连接表单的「环境/分组」两个文本框换成「分组」下拉（列出 环境/分组 + 不分组）；下拉「新建组/新建环境」直接落库空容器，环境/组右键支持 新建组 / 重命名 / 删除。
- **Consequences**：
  - ✅ 真正的空容器：新建环境/组立刻在树里可见，且与任意连接解耦；
  - ✅ 重命名/删除/未来拖拽排序都是单记录操作，连接经 `group_id` 外键自动跟随，无字符串匹配脆弱性；
  - ✅ 旧连接无缝迁移（自修复式），不丢数据；
  - ⚠️ 代价：多一张 `containers` 表 + 迁移逻辑 + 容器 CRUD 命令 + 表单/树改动；比 ADR-015 的"预填字段"方案更重——但这是用户明确二次确认要的；
  - ⚠️ 分组仍强制嵌套在环境之下（与 ADR-015 树形一致）；若未来要"跨环境同名组"或"组并列于环境顶层"，需再调整模型；
  - 🔁 可逆：迁移只写 `group_id` 且不删旧字段容错逻辑；若需回退旧二进制，旧 blob 仍可解析（仅缺 group_id 会再次触发合成）。排序 `ord` 暂未做 UI，留作后续。

---

### ADR-017：查询可用性补齐（历史/片段、EXPLAIN、导出 CSV、多标签、运行选中）
- **Context**：Phase 12 后工具"能连、能看、能跑 SQL、能只读翻页"，但仍是只读浏览器——查询跑了就丢、看不出执行计划、结果拿不出来、编辑器只有一个结果区。对照 Navicat/TablePlus/DBeaver 层级，这四件属于"低成本·高价值"象限，是让工具从"能看"变"能干活"的最短路径（矩阵左上角）。
- **Decision**：
  - **后端**：`queries` 表（id/name/sql/conn_id/db/created）。`name` 为 NULL=自动记录的历史，非 NULL=用户命名的片段，二者同表，历史面板统一展示。命令 `log_query`（每次成功执行自动记）、`list_queries`（最近 200 条）、`save_query`（id 为空则新建命名片段，非空则为历史条目命名/重命名）、`delete_query`；`explain_query`（MySQL 前缀 `EXPLAIN `，Redis 返回提示）。
  - **前端**：查询编辑器改为**多标签**状态（每标签独立 sql/result/browseCtx），切换标签用 `editor.replaceValue` 同步内容、变更经 updateListener 写回活动标签；**运行选中**（有选区则只跑选区，否则跑全文）；新增「执行计划」「历史」「存为片段」按钮；**历史/片段面板**（载入 / 命名 / 删除）；表结果提供**导出 CSV**（RFC-4180 引号转义 + BOM，Blob 下载）。
- **Consequences**：
  - ✅ 查询不再丢失，可重放、可保存为片段复用；
  - ✅ 能看 `EXPLAIN` 执行计划，排查慢查询有抓手；
  - ✅ 结果一键导出 CSV（含中文 BOM，Excel 不乱码）；
  - ✅ 多标签并行多个查询/连接上下文；
  - ⚠️ 代价：后端多一张表 + 4 个命令 + EXPLAIN 分支；前端重构成标签状态（编辑器实例仍单例，靠 replaceValue 切换内容）；
  - ⚠️ 已知未做：`queries` 表未做容量裁剪（仅 `list` 限 200，老数据仍堆积，后续可加 prune）；**数据写回（行内编辑）仍在右上角未做**，属独立重 Phase；EXPLAIN 仅 MySQL。
  - 🔁 可逆：全部新增能力，未改动既有连接/容器模型；历史表独立，不影响主数据流。

---

### ADR-018：数据写回 MVP（MySQL 表单元格行内编辑）
- **Context**：ADR-017 后工具仍"只读"——能浏览、能导出，但改不了数据。对照标杆，行内编辑 + 提交是"只读浏览器"变"完整查询工具"的最后一跃，也是缺口矩阵右上角头号痛点。但完整写回（增删改 + 事务 + 类型校验 + 回滚 + 单元格 UI）是重工程，不应和日常可用性混作一次性大改。故先做**最小可验证切片**：仅 MySQL 表的单元格 UPDATE。
- **Decision**：
  - **主键定位**：`browse` 现在额外查 `INFORMATION_SCHEMA.COLUMNS` 取 `COLUMN_KEY='PRI'` 列，随结果返回 `primary_keys`。无主键的表（多为视图或无 PK 表）`primary_keys` 为空，前端**禁用编辑**——因为没有稳定行标识，写回不安全。
  - **写回命令** `apply_edit(conn_id, database, table, pk[], set[])`：后端把一行所有脏单元格**合成单条参数化 `UPDATE`**（`SET` 带新值，`WHERE` 用**原始主键快照**），在事务里提交；`pk` 为空或 `set` 为空直接 no-op。参数化绑定杜绝注入；主键被编辑时，同一语句先按旧 PK 定位再写入新 PK。
  - **前端**：`QueryOutput.Table` 增 `primaryKeys`；结果网格在 `editable`（浏览态 + 有 PK）时单元格**双击进入编辑**、脏单元格 `.dirty` 高亮、`editable` 类显示编辑光标；「保存修改」按行分组逐行调用 `apply_edit`，成功后重新 `browseTable` 刷新并清空编辑态；「撤销修改」清空 overlay。编辑态在切换标签 / 重新查询 / 翻页时自动清空。
- **Consequences**：
  - ✅ MySQL 表终于能改了：双击单元格、回车提交、一键保存，体验对齐 Navicat 基础编辑；
  - ✅ 定位用原始主键快照 + 单语句事务，正确性与安全性（注入）都有保障；
  - ✅ 无 PK 的表/视图/任意 SQL 结果/Redis 自动保持只读，不会误写；
  - ⚠️ **明确放弃（后续独立 Phase）**：① 新增行 / 删除行（INSERT/DELETE）；② Redis 写回；③ 视图写回；④ 乐观锁 / 并发冲突检测（当前用快照 WHERE，并发改同一行会静默覆盖）；⑤ 置 NULL 编辑（空串即空串，不识别 NULL 字面）；⑥ BLOB/二进制列编辑。
  - ⚠️ 代价：后端 `QueryResult` 增字段（含 `query`/`mask` 路径补 `primary_keys: vec![]`）、`browse` 增一次 PK 查询、新 `apply_edit` 命令与 DTO；前端网格从纯展示改为可交互。
  - 🔁 可逆：纯增量，未改连接/容器模型；编辑态是前端 overlay，不污染 stored 数据。

---

### ADR-019：数据写回完善 — INSERT / DELETE 行
- **Context**：ADR-018 让 MySQL 表"能改"（UPDATE），但"不能增、不能删"。日常使用中，行内编辑只覆盖了 CRUD 的 U；INSERT 和 DELETE 是让写回"真正完整"的最后一环。ADR-018 已列出此项为后续独立 Phase，本 ADR 兑现之。
- **Decision**：
  - **后端**（`src/db/mysql.rs`）：新增 `insert_row(cfg, db, table, values[])` 和 `delete_row(cfg, db, table, pk[])`。`insert_row` 只包含用户显式填入的列（空列省略 → DB 默认值/AUTO_INCREMENT 生效），参数化绑定，事务提交。`delete_row` 用原始主键快照定位行（与 `apply_edit` 的 WHERE 策略一致），空 `pk` 直接拒绝（无主键不安全）。二者复用 `apply_edit` 的 `quote_ident` / `qualified_table` / 事务模式。
  - **Tauri 命令**：`insert_row`（复用 `SetPair` DTO）和 `delete_row`（复用 `PkPair` DTO），注册于 `main.rs`。
  - **前端**：
    - 新增 `deletes: Set<number>`（标记删除的行索引）和 `inserts: Record<number,string>[]`（待插入行数组，每项是列索引→值映射）。
    - 编辑态下每行左侧出现 `×` / `↩` 按钮：`×` 标记删除（行变删除线 + 半透明），`↩` 取消删除。
    - 结果面板加「新增行」按钮：追加一行空白行，所有单元格均为 `<input>`（始终可编辑），空单元格在 INSERT 时省略。
    - 「保存修改」统一处理三类操作：先 UPDATE（跳过已标记删除的行）、再 INSERT、最后 DELETE。任一失败则停止并保留 overlay，用户可修正后重试。
    - 「撤销修改」清空全部三类 overlay。切标签 / 重查询 / 翻页时自动清空（`clearEditState` 统一处理）。
- **Consequences**：
  - ✅ MySQL 表 CRUD 完整：增、删、改全在网格内闭环，无需手写 SQL；
  - ✅ INSERT 省略空列 → AUTO_INCREMENT / DEFAULT 自然生效，不要求用户手填主键；
  - ✅ DELETE 用原始 PK 快照定位，与 UPDATE 一致，安全无歧义；
  - ✅ 三类操作共用 overlay 模型，保存/撤销/清理逻辑统一；
  - ⚠️ **仍未做**：① Redis 写回；② 视图写回；③ 乐观锁/并发冲突检测（并发改同一行仍静默覆盖）；④ 置 NULL 编辑（空串=空串，INSERT 空串会写入空字符串而非 NULL）；⑤ BLOB/二进制列编辑；⑥ 批量操作的进度/事务原子性（当前逐行提交，非整体事务）。
  - ⚠️ 代价：后端 +2 函数 +2 命令；前端 `renderData` 重写（加操作列、删除行、插入行），状态多 `deletes`/`inserts` 两层；
  - 🔁 可逆：纯增量，ADR-018 的 UPDATE 路径完全不变；INSERT/DELETE 是独立命令，前端按需调用。

---

### ADR-020：表结构 / DDL 查看
- **Context**：Phase 15 后 MySQL CRUD 在网格内完整闭环，但用户右键表只能"打开数据"——看不到列的完整类型（`varchar(255)` vs `varchar`）、索引、默认值表达式、`AUTO_INCREMENT`/`ON UPDATE` 等元信息。这在 Navicat/TablePlus/DBeaver 中是标配功能（表→结构/DDL 面板），属于"低成本·高价值"象限。后端已有 `list_columns`（供树/补全用），但它只查 `DATA_TYPE`（基类型），不够丰富。
- **Decision**：
  - **后端**（`src/db/mysql.rs`）：新增 `describe_table(cfg, db, table) -> TableStructure`。查 `INFORMATION_SCHEMA.COLUMNS` 取 `COLUMN_NAME/COLUMN_TYPE/IS_NULLABLE/COLUMN_KEY/COLUMN_DEFAULT/EXTRA`（比 `list_columns` 多 `COLUMN_TYPE` 全类型 + `EXTRA`），查 `SHOW INDEX FROM` 取索引（每行一个 index-column pair），查 `SHOW CREATE TABLE` 取 DDL 原文。新结构 `ColumnDetail`（比 `ColumnInfo` 富）、`IndexInfo`、`TableStructure`。复用 `connect_pool_db` / `qualified_table`。
  - **Tauri 命令**：`describe_table`（返回 `TableStructure`），注册于 `main.rs`。
  - **前端**：`types.ts` 加 `ColumnDetail`/`IndexInfo`/`TableStructure`；`api.ts` 加 `describeTable`；`App.tsx` 加 `structureView` 状态——当 set 时结果面板渲染结构视图（列详情表 + 索引表 + DDL `<pre>`）替代数据网格；`Tree.tsx` 表节点右键加"表结构"项；结果面板头部显示"表结构 — db.table"和"返回数据"按钮。`clearEditState()` 统一清空结构视图（切标签/查询/翻页自动关闭）。
- **Consequences**：
  - ✅ 查看表结构不再需要手写 `DESCRIBE`/`SHOW CREATE TABLE`，右键即可；
  - ✅ 列类型完整（`int unsigned` 而非 `int`）、索引一览、DDL 可复制（`<pre>` 可选中文本）；
  - ✅ 结构视图是独立的 transient state，不侵入数据编辑 overlay 也不碰 `QueryOutput` 枚举；
  - ⚠️ 代价：后端 +1 函数 +1 命令 +3 结构体；前端 +1 状态 +1 渲染分支 +右键菜单项 +CSS；
  - ⚠️ 仅 MySQL（Redis 无表结构概念）；`SHOW INDEX`/`SHOW CREATE TABLE` 需要额外两次往返；
  - 🔁 可逆：纯增量，不改 `ColumnInfo`/`QueryResult`/`QueryOutput` 等既有类型；结构视图是前端 overlay 态。

---

### ADR-021：SQL 格式化 + 表关系视图（ER 简版）
- **Context**：对照 Chat2DB（4071 次提交的成熟 AI DB 客户端）发现两个缺失功能：(1) SQL 格式化——所有 DB 工具标配，我们居然没有；(2) 表关系/ER 视图——能直观看到表间外键依赖，对理解陌生数据库结构极有帮助。两者都属于"低成本·高价值"象限。
- **Decision**：
  - **SQL 格式化**（纯前端）：引入 `sql-formatter` npm 包。`editor.ts` 的 `EditorHandle` 加 `formatSql()` 方法——有选区时只格式化选区，否则格式化全文。`App.tsx` 编辑器工具栏加"格式化"按钮。语言固定为 `mysql`，关键字大写，缩进 2 空格。
  - **表关系视图**（前后端）：后端 `src/db/mysql.rs` 新增 `list_relationships(cfg, db) -> Vec<ForeignKeyInfo>`——查 `INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL`，返回 `{constraint_name, table_name, column_name, referenced_table, referenced_column}`。Tauri 命令 `list_relationships` 注册于 `main.rs`。前端 `App.tsx` 加 `relationshipView` 状态——当 set 时结果面板渲染外键关系表（Constraint | 子表 | 子列 | → | 父表 | 父列）。`Tree.tsx` 数据库节点右键加"表关系"菜单项。
- **Consequences**：
  - ✅ SQL 格式化让手写 SQL 可读性大幅提升，一键整理凌乱查询；
  - ✅ 表关系视图让用户右键数据库即可看到所有外键依赖，无需手写 `SELECT * FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE`；
  - ✅ 两个功能完全正交，互不依赖；
  - ⚠️ 代价：+1 npm 依赖（sql-formatter，~50KB gzip）；后端 +1 函数 +1 命令 +1 结构体；前端 +1 状态 +1 渲染分支 +右键菜单项 +CSS；
  - ⚠️ SQL 格式化器对非标准语法（存储过程、DELIMITER 等）可能出错——`formatSql` catch 异常后静默失败，不破坏编辑器内容；
  - ⚠️ 表关系视图是列表形式而非图形化 ER 图——没有自动布局的节点/连线。列表对查看足够，图形化留给后续可选增强；
  - 🔁 可逆：纯增量，不改既有类型；`sql-formatter` 只在 `formatSql()` 内部使用，不侵入编辑器核心；`ForeignKeyInfo` 是新类型不碰 `QueryResult`。

---

### ADR-022：参考 Chat2DB 的四项 UI 改进（状态栏 / 结果子标签 / 可折叠 AI 面板 / 明暗主题）
- **Context**：用户提议参考 Chat2DB 的 UI。对照后发现我们缺四类通用 DB 工具模式：(1) **执行后零反馈**——跑完查询只有网格刷新，没有耗时/影响行数/错误提示；(2) 结果多视图（数据/结构/关系）用"返回数据"按钮硬切，不像专业工具的标签条；(3) AI 面板固定 360px 常驻，不用时也占空间；(4) 硬编码暗色，无主题切换。这四项都是"低成本·高价值"且 Chat2DB/DBeaver/TablePlus 均验证过的通用模式——我们决定**借模式不借像素**，不做 Chat2DB 特有的顶部菜单栏等品牌化结构。
- **Decision**：
  - **底部状态栏/控制台**（纯前端）：`App.tsx` 加 `runInfo` 状态，`runQuery`/`browseTable`/`browseRedisKey`/`explainQuery` 用 `performance.now()` 计耗时，成功按结果形状（`'rows' in result` / redis `note`）显示"返回 N 行 / 已截断"或"错误: …"，失败显示红色错误。`main` 底部渲染 `.status-bar`（点 + 文案 + 当前连接名）。
  - **结果子标签**（纯前端）：`App.tsx` 加 `resultTab: 'data'|'structure'|'relation'` 状态，结果面板头部改为标签条（数据/表结构/表关系），body 按 `resultTab` 切换；"表结构/表关系"无缓存数据时从 `browseCtx` 懒加载；`clearEditState` 一并重置 `resultTab`。`showStructure`/`showRelationships` 错误改为写入状态栏而非清空结果面板。
  - **可折叠 AI 面板**（纯前端）：`App.tsx` 加 `chatOpen` 状态（localStorage 持久化）。`.app` 加 `chat-collapsed` 类 → grid 第三列收窄到 30px；折叠时渲染 `.chat-rail` 重开按钮，展开时渲染完整 `.chat` 面板（头部加收起按钮）。
  - **明暗主题切换**（前端 + 编辑器）：`App.tsx` 加 `theme` 状态（localStorage 持久化），切换 `<html data-theme>` 驱动 CSS 变量；`style.css` 加 `:root[data-theme="light"]` 亮色变量集；`editor.ts` 加 `themeConf` Compartment + `setTheme(dark)`，用 `@codemirror/theme-one-dark` 切换 CodeMirror 主题（默认暗色，顺带把编辑器与暗色 app 统一——此前 `basicSetup` 默认是亮色，编辑器长期亮底暗壳不一致）。
- **Consequences**：
  - ✅ 首次有执行反馈：耗时/行数/错误一目了然，符合专业 DB 工具直觉；
  - ✅ 结果三视图用标签条组织，切换顺手、信息层次清晰；
  - ✅ AI 面板可收起，编辑/结果区在不需要 AI 时获得全部宽度；
  - ✅ 明暗主题可切换并持久化，编辑器随主题联动；
  - ⚠️ 代价：+1 npm 依赖（`@codemirror/theme-one-dark`）；前端 +4 状态 +标签条/状态栏/rail 三段 JSX + 亮色变量集 +若干 CSS；编辑器多一个主题 Compartment；
  - ⚠️ 放弃项：未做 Chat2DB 式顶部菜单栏（与 Tauri 桌面形态不符，侧栏+下拉已覆盖）；未做图形化 ER 图（仍为列表）；亮色主题下 `.msg.assistant/.msg.tool` 等少量硬编码暗底气泡未重算（可接受的次要不一致）；
  - 🔁 可逆：纯增量，无 Rust/类型契约改动；`runInfo`/`resultTab`/`chatOpen`/`theme` 均为前端 UI 状态，不侵入数据模型或命令层。

---

## 6. 资源预算（目标）

| 场景 | RSS 估算 |
|------|----------|
| 空闲常驻 | < 30MB |
| 每 MySQL 连接池 | +5–15MB |
| LLM 流式 | 网络缓冲，忽略 |
| 每 MCP 子进程 | 独立、按需、空闲回收 |
| 多连接（10+） | 内存近似常数：仅活跃连接占工作集，元数据走 LRU 有界缓存 |
| 二进制体积 | 实测 ~3.8MB (release: opt-level=z, lto, strip；已含 reqwest/rustls/mcp/crypto/regex；脱敏见 ADR-012) |

> **内存平稳原则**：连接数增长不应导致内存增长——靠 ADR-006 的惰性加载 + 有界缓存保证，而非 Navicat 式的「连接即全量预载」。

---

## 7. 可靠性与失败模式

- **连接断开**：指数退避重连，TUI 状态栏提示。
- **LLM 错误**：显示错误 + 可重试，主程序不崩溃。
- **MCP 子进程崩溃**：kill + 标记工具不可用，主程序继续运行。
- **流式中断**：部分渲染 + 续传提示。

---

## 8. 演进路线（分阶段实现）

- **Phase 1**：脚手架 + TUI 骨架 + SQLite 配置 + MySQL 查询（结果表格）。
- **Phase 2**：✅ Redis 适配器（命令执行 / 键值浏览）— 已完成。
- **Phase 3**：✅ LLM Chat 面板 + 流式（SSE）+ 内置 `execute_query` 工具 — 已完成。
- **Phase 4**：✅ MCPHost stdio 集成（独立子进程 + 工具注册到 LLM）— 已完成。
- **Phase 5**：✅ 打磨（Redis 引号解析 / 连接配置加密 / 结果滚动 / 结果导出）— 已完成；✅ 主题 / OS keychain / 脱敏选项留作后续。

---

## 9. 当前进度与构建（Phase 1–5 已落地）

Phase 1–5 已落地，编译零警告，Redis 适配器经真实 redis 实例冒烟测试验证（`cargo test` 7 项全绿）：
- 工程结构（ADR-008 模块化）：`src/{main,error,config,model,crypto}.rs` + `src/{store,db,llm,tui,mcp}/{...}.rs`
  - `db/`：`connection`(配置) / `mysql`(流式有界+CSV导出) / `redis`(命令+SCAN+引号解析)
  - `llm/`：`client`(OpenAI 兼容流式 SSE) / `session`(工具循环) / `tools`(execute_query + MCP 路由)
  - `mcp/`：`transport`(stdio 子进程+行分隔 JSON-RPC) / `host`(握手+list/call+懒连接管理器)
  - `tui/`：`app`(状态机+Chat+MCP+滚动/导出) / `ui`(渲染) / `event`(输入线程)
  - `crypto/`：AES-256-GCM 加解密 + 密钥文件隔离（ADR-010）
- MySQL 适配器：`sqlx` 异步流式查询，结果集上限 `PAGE_LIMIT=200`（ADR-006 有界内存）；`to_csv` 导出（字段含逗号/引号/换行时自动加引号转义）
- Redis 适配器：`redis` 0.27（tokio-comp）；通用命令 + `SCAN` 游标遍历（上限 500），**拦截 `KEYS`**；结果经 `DisplayResult::Redis` 用 `List` 呈现（ADR-007）；**`tokenize` 支持单/双引号与反斜杠转义**（`SET k "a b"` 正确解析）
- LLM 适配器（Phase 3）：`llm/client` 流式调用 OpenAI 兼容 `/chat/completions`，增量 token 经 `BackendMsg::ChatToken` 实时上屏；`llm/tools::execute_query` 让模型按连接名执行 MySQL/Redis 查询，结果回灌后模型可继续（最多 5 轮工具迭代）；配置走 env `CHATQUERY_LLM_*`，**不落盘**（ADR-004）。回灌模型的查询结果在 `exec_builtin` 处经 `mask.rs` **脱敏**（ADR-012，默认开，仅云路径；本地 TUI 显示真实数据）。
- MCP 适配器（Phase 4）：`mcp/{transport,host}` 以独立子进程跑 MCP server（裸 JSON-RPC stdio）；`McpHostManager` 懒连接、**崩溃跳过**，工具以 `mcp__<server>__<tool>` 命名空间合并进 LLM；`llm/tools::exec_tool` 按前缀路由到对应 server；配置走 env `CHATQUERY_MCP_SERVERS`（JSON 数组），**不落盘**（ADR-004/009）。`cargo test` 含真实握手集成测试（python3 fixture 验证 initialize/list/call 全链路）。
- SQLite 持久化：**连接配置落盘前 AES-256-GCM 加密**（ADR-010），密钥独立存于 `~/.config/chatquery/key`（0600）；加载时旧明文记录自动重写加密。LLM/MCP 配置仍走 env，不落盘。
- TUI：ratatui 面板（连接列表 / 查询编辑器·结果 或 Chat 输入·转录）；**Tab 栏**区分 Query/Chat 模式；**Ctrl+1/2/3** 直切 Connections/Editor/Chat（Tab 仍循环）；`Ctrl+Enter`/`F5` 执行查询或发送对话；`PgUp`/`PgDn` 滚动、`End` 回底、`Ctrl+E` 导出；连接面板 `a`/`e`/`d` 管理；焦点面板边框亮色高亮；底部**快捷键提示栏** + 运行状态栏；连接项加健康圆点（●/○）；密码字段遮蔽（ADR-013）
- CLI：`chatquery add --name ... --type mysql|redis --host ...` 落库连接（密码加密存储）；TUI 内亦可增删改（ADR-011）

### 依赖版本钉法（踩坑结论）
- **ratatui 0.29 + crossterm 0.28 + tui-textarea 0.7 必须对齐**：tui-textarea 0.7 钉死 ratatui 0.29 / crossterm 0.28，三者版本不一致会导致 `Widget` trait 跨版本不匹配、编译失败。
- **sqlx 关闭默认特性**：`default-features=false, features=["runtime-tokio","mysql","chrono"]`。默认特性（bigdecimal/uuid/time/json…）编译期内存爆掉（OOM，exit 137）。
- 构建避 OOM：`CARGO_BUILD_JOBS=2 RUSTFLAGS="-C codegen-units=1" cargo build`。
- **redis 0.27 的 `Value` 变体已改名**：`Data→BulkString`、`Status→SimpleString`、`Bulk→Array`；扁平化结果时要用新名字。
- **redis `Cmd::query_async` 只有一个泛型参数**（返回类型 `T`），连接是 `con: &mut impl ConnectionLike`，**不能**写成 `query_async::<_, T>(...)` 的 turbofish——会误把 `_` 当成连接类型而报 `ConnectionLike` 不满足。正确写法：`.query_async::<T>(&mut conn)`。
- **reqwest 0.12 的 `tokio` 不是可列特性**（异步运行时是硬编码依赖，始终可用）。要用需 `default-features=false, features=["json","stream","rustls-tls"]`；若误写 `tokio` 特性会报 "does not have that feature"。TLS 选 `rustls-tls`（静态、无系统 OpenSSL），避开 `default-tls`(native-tls)。
- **`tokio::spawn` 的 future 必须 `Send`**：跨 `.await` 持有 `&mut dyn FnMut(&str)` 会破坏 `Send`，需写成 `&mut (dyn FnMut(&str) + Send)`（llm/client 的 `stream_chat` 已如此）。
- **ratatui 0.29 移除了 `Table::scroll` / `List::scroll` 构建器**：滚动改为 `TableState`/`ListState` + `render_stateful_widget`。本项目对长内容改用「切片窗口」渲染（`render_table`/`render_redis` 按滚动偏移截取 `rows/items` 子集），`Paragraph` 仍可用 `.scroll((y,0))`。

### 构建与运行
```bash
cargo build                      # debug 二进制 ~15MB
cargo build --release           # 实测 ~3.2MB（profile: opt-level=z, lto, strip, codegen-units=1；含 reqwest/rustls/mcp/crypto）
./target/debug/chatquery add --name demo --type mysql --host 127.0.0.1 --user root --password x --database test
./target/debug/chatquery        # 启动 TUI（需真实终端）
```

### 已知限制（Phase 1–5）
- MySQL / Redis 适配器均已可实际执行；无可用 DB 时返回错误（符合预期）。
- LLM 对话查询已可用，但需联网 + `CHATQUERY_LLM_API_KEY`（配置不落盘）；真实流式效果需在终端里配好 Key 后验证（沙箱无 TTY / Key）。
- 结果集上限：MySQL 200 行 / Redis 500 键，超出提示加 `LIMIT` 或缩小 `MATCH`。
- MCP server 以独立子进程运行，配置用 env `CHATQUERY_MCP_SERVERS`（JSON 数组，如 `[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]`）；状态栏显示 `mcp=N`。连不上的 server 仅 stderr 警告并跳过。
- 连接密码已加密落盘（ADR-010），但加密仅防被动泄露；若要彻底隔离（防已获账户的攻击者）需改用 OS keychain，列为后续可选项。
- 桌面端（ADR-014）已成型：连接 CRUD、SQL 编辑器 + schema 自动补全、结果表格、Chat 流式面板、连接表单。TUI 主题切换已被桌面端取代（TUI 仍作为 `--features tui` 回退保留）。
- 桌面端（ADR-015/016）已支持左侧导航树：连接按「环境→分组」聚合，**环境/组为可独立存在的一等容器（支持空容器，见 ADR-016）**，表可展开看列、点表只读浏览、双击列名插入编辑器；MySQL 走 库→表→列，Redis 走 db→key。
- 桌面端待打磨：Redis 写回、视图写回、乐观锁/并发冲突检测、置 NULL 编辑、函数/事件/索引/外键树节点、连接管理快捷键、MCP 服务器可视化配置、Release 体积优化（musl/UPX）、图形化 ER 图（当前为列表形式）、CSV 数据导入、多数据库支持（Postgres/SQLite）、数据可视化图表（结果集转柱状/折线）、SQL 格式化器对存储过程等非标准语法的兼容。
