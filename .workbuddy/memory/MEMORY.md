# ChatQuery 项目长期记忆

## 技术栈
Tauri v2 + React + Vite + TypeScript 桌面 SQL 客户端；Rust library crate (sqlx MySQL)。
- 前端 dev: vite :1420；后端: `cargo run --manifest-path src-tauri/Cargo.toml --no-default-features`。
- 前端改动走 vite HMR，窗口内 `Cmd+R` 刷新即生效；Rust 改动需重启 cargo。

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
