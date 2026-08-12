# ADR-025: Redis 查询体验对齐 Redis Desktop Manager（RDM 模式）

## Status
Accepted（Phase A 已实施，2026-08-10）

## Context

ChatQuery 的 Redis 能力（后端 `src/db/redis.rs` + 前端）现状是：

- **命令编辑器**：`redis::query()` 执行任意 Redis 命令，`KEYS` 被拦截改走 `SCAN`（ADR-006），tokenizer 已支持单/双引号与反斜杠转义。
- **Tree 的 db→key 惰性展开**：`list_keys` 用 `SCAN` 采样（≤300），点 db 节点展开键名；`browse_key` 按 `TYPE` 读值。
- **结果呈现**：`browse_key` 把值**拍平成 `RedisResult.lines: Vec<String>`**——`HGETALL` 的 field/value 交错、`ZRANGE` 的分值与成员混排、`LRANGE` 的索引丢失。可读但**丢失结构语义**。
- **无** key-list 面板（类型/TTL/大小列）、**无**命名空间分组、**无**值编辑（ADR-018/019 已显式推迟 Redis 写回）、**无**内存分析/Pub-Sub/Monitor。

参考对象 **Redis Desktop Manager** 已于 2019 年转商业授权；社区当前默认指代开源分支 **Another Redis Desktop Manager（qishibo/AnotherRedisDesktopManager）**。其标志性生产力模型：

1. **Key-list 面板**：键名 + 类型 + TTL + 大小 列，过滤框、方向键导航、**增量加载（绝不一次载入海量键）、Big Key 用 Scan**。
2. **命名空间树**：键按分隔符 `:` 折叠为文件夹（RDM 招牌功能）。
3. **类型感知值查看器**：string（含 JSON 自动格式化/编辑）、hash（field/value 表，可搜索）、list（带索引，可 push/pop）、set（成员）、zset（member+score 可排序）、stream（条目 + 消费组）、binary/RedisJSON 等。
4. **CLI 控制台**：命令历史、命令提示、命令 dump。
5. 连接管理、内存分析、Pub/Sub、Monitor、Slow log、导入/导出。

**张力**：ChatQuery 定位「AI 驱动的查询助手」，**MySQL 优先**，Redis 是二等公民（ADR-022 环境绑定单一 `db_type`，Redis 环境独立成根）。全盘复制 RDM（完整 KV 浏览器 + 写回 + 内存分析 + Pub-Sub）会稀释定位且工程量大。遵循 ADR-022「**借模式不借像素**」原则：借鉴 RDM 的*模式*（key-list + 类型感知查看器 + 命名空间树），不照搬其全部像素布局。

## Decision

分阶段兑现，每阶段纯增量、可独立回退。当前推荐先做 **Phase A**（低成本·高价值），与项目 ADR-017..024 的「最小可验证切片」节奏一致。

### Phase A — 首推切片（低成本·高价值）

**A1 类型感知值查看器（替换扁平 lines）**
- 后端扩展 `RedisResult`，新增可选字段 `value: Option<RedisValueView>`。`browse_key` 在**保留 `lines`** 的同时填充结构化 `value`：
  - `type: "string"|"hash"|"list"|"set"|"zset"|"stream"`
  - `ttl: Option<i64>`（`TTL` 命令，`-1` 持久化→`None`）
  - `size: Option<usize>`（`MEMORY USAGE`，可选/上限内）
  - `entries` 按类型：`string`→`{ raw, json?: bool }`；`hash`→`Vec<{field,value}>`；`list`→`Vec<{index,value}>`；`set`→`Vec<{value}>`；`zset`→`Vec<{member,score}>`；`stream`→`Vec<{id, fields: [{field,value}]}>`
- 前端 `renderRedisResult` 按 `value.type` 分发到专用组件（string 含 JSON 高亮/折叠；hash/list/set/zset 走可排序/可搜索的表格；stream 走条目卡）。**通用命令**（无 key 上下文，如 `PING`/`INFO`）`value=None`，回退 `lines` 渲染——向后兼容。
- 代价：DTO 变大；但只读路径，无写回副作用。

**A2 Key-list 面板（RDM 核心）**
- 后端新增 `list_keys_meta(cfg, db, pattern, limit) -> Vec<KeyMeta>`，`KeyMeta { key, type, ttl, size }`。
- 实现：复用 `SCAN`（含 `MATCH`/`COUNT`）游标遍历，**用 `redis::pipe()` pipeline 批量 `TYPE`+`TTL`(+`MEMORY USAGE`)**，避免「每键 3 次往返 × 上限 500」的放大；结果仍受 `PAGE_LIMIT=500` 与 `SCAN_MAX_ROUNDS` 约束（ADR-006）。
- 前端：Redis **db 节点选中时**，中心区切成「**key-list（左半：类型/TTL/大小 列 + 过滤框 + 方向键 + 加载更多）｜值查看器（右半，消费 A1）**」的 **Redis 浏览器模式**。该模式仅对 Redis 激活；MySQL 流程（编辑器 + 结果网格）不变。

**A3 控制台增强**
- 命令历史：复用已落库的 `queries` 表，加 `db_type`/Redis 标记与过滤；编辑器加命令提示（常见命令补全）。
- 命令 dump：把当前编辑器内容导出为可重放脚本（`redis-cli < dump`）。
- 复用现有编辑器与 `redis::query`，与 `chatTurn`/LLM 工具无关。

### Phase B — 后续

- **B1 命名空间树**：key-list 按 `:` 折叠为文件夹视图（RDM 招牌），可在「列表/树」间切换；复用 A2 的 `KeyMeta`。
- **B2 值写回**：兑现 ADR-018/019 推迟的 Redis 写回（`SET`/`HSET`/`LPUSH`/`SADD`/`ZADD`/`XADD` 等），与 A1 的类型结构共用，编辑态走前端 overlay。

### Phase C — 显式放弃 / 长期可选

内存分析（MEMORY USAGE 全量扫描）、Pub/Sub、Monitor、Slow log、导入/导出、binary/protobuf/msgpack/Java-Pickle 查看器、Cluster/Sentinel/ACL 高级连接管理。这些与「AI 驱动查询助手」定位偏离，列为可选；当前连接已支持基本 SSH/TLS。

## Consequences

- ✅ **容易**：Redis 查询体验从「命令 + 扁平文本」跃升到 RDM 级（类型感知 + key-list + 命名空间），复用既有 `SCAN`/连接池/Tree 基础设施。
- ✅ **容易（纯增量）**：`RedisResult` 加可选 `value` 字段、新增一个 `list_keys_meta` 命令、新增前端 Redis 浏览器组件；**不改动 MySQL 路径、不改动连接/容器模型、不改动 LLM 工具**。
- ✅ **可逆**：A1 的 `value` 为 `Option`，回退即 `None` 走 `lines`；Redis 浏览器模式是前端 transient 状态，不污染数据模型。
- ⚠️ **风险**：key-list 的 TYPE/TTL/size 若不用 pipeline 会放大往返 → **强制 pipeline**；超大键空间仍受 500 上限（与 RDM「Big Key Loads With Scan」一致）。
- ⚠️ **放弃**：不复制 RDM 的写回/内存分析/Pub-Sub 等重功能（已显式推迟/放弃），保持产品聚焦。
- 🔁 **演进**：若用户后续要 RDM 级面板密度，A2 的 key-list 可升级为带命名空间树（B1）与值写回（B2），均在 A1 结构之上增量。

## 关联 ADR
- ADR-006 有界内存：`KEYS` 禁止、SCAN 游标、`PAGE_LIMIT=500`。
- ADR-007 `DisplayResult::Redis` 联合：本 ADR 在其 `Redis` 变体内增量扩展（`value` 字段），不新增联合变体。
- ADR-014 Tauri/React：前端 Redis 浏览器为新增 React 组件，薄接 Tauri 命令。
- ADR-015/016 连接树：A2 的 key-list 是 Tree 的 Redis db 节点的「展开为浏览器」升级，不改动容器模型。
- ADR-018/019 数据写回：B2 兑现其已推迟的 Redis 写回。
