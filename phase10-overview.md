# Phase 10 — 左侧导航树 + 连接分组 + 表可展开 + 样式美化

> 目标：把 Tauri 桌面端从"扁平连接列表"升级为接近 Navicat 的左侧菜单：连接按**环境→分组**聚合、表可展开看列、点表只读浏览、双击列名插入编辑器，并整体美化样式。

## 范围对齐（与用户确认）
- **点表行为**：只读数据网格（`SELECT * LIMIT N` 看行；双击列名插入编辑器），**无写回**。
- **分组方式**：先按**环境**（生产/测试/开发…），环境下还能再**单独分组** —— 两层分组。
- 树形：`环境 → 分组 → 连接 → 数据库 → 表(展开列) → 视图`；Redis 近似为 `连接 → db(有键的) → key`。

## 后端改动（零重写，仅加函数）
- `ConnectionConfig` 新增 `env` / `group` 字段（`#[serde(default)]`，旧连接自动兼容）；TUI 两处构造点补空值保编译。
- `src/db/mysql.rs`：
  - 抽取 `connect_pool_db(cfg, db)` 复用；
  - `list_databases`（SCHEMATA，排除系统库）、`list_tables`（`TableMeta{name,is_view}`）、`list_columns`（含 `key/nullable/default`）、`browse`（`SELECT * FROM \`db\`.\`tbl\` LIMIT n`，标识符 sanitize 防注入）；
  - `ColumnInfo` 扩展 `key/nullable/default`。
- `src/db/redis.rs`：`list_dbs`（CONFIG GET databases + 各 db DBSIZE）、`list_keys`（SCAN 限长 300）、`browse_key`（按 TYPE 返回 string/hash/list/set/zset）；新增 `connect_to_db(cfg, db)`。
- `src-tauri/src/commands.rs`：`ConnSummary`/`ConnInput` 加 `env`/`group`；新增 7 个命令 `list_databases / list_redis_dbs / list_tables / list_redis_keys / list_columns / browse_table / browse_redis_key`；`main.rs` `generate_handler!` 注册。密码仍不回传。

## 前端改动
- `types.ts` / `api.ts`：扩展类型 + 7 个 invoke 封装。
- **新增 `Tree.tsx`**：按 `env→group→连接` 聚合，连接以下节点**惰性展开**（点击才发请求、按节点 key 缓存）；点表→只读网格；双击列名→插入编辑器；Redis 走 `db→key` 子树。类型徽章（My/Rd/DB/T/V/·/k）+ 连接线观感。
- `App.tsx`：用 `Tree` 替换扁平 `<ul>`；连接表单新增「环境」「分组」输入。
- `editor.ts`：新增 `insert(text)`（光标处插入，供双击列名用）。
- `style.css`：重写 —— 树缩进/类型徽章/连接线、更精致的暗色配色、结果表格 sticky 表头、滚动条样式。

## 验证（全绿）
| 项 | 结果 |
|----|------|
| `cargo check`（src-tauri 桌面路径） | ✅ |
| `cargo check`（根 crate 含 TUI feature） | ✅ |
| 前端 `npm run build`（TS 零错误） | ✅ 581KB / 190KB gzip |
| `tauri dev` 重编译并弹出原生窗口 | ✅ 运行中（任务 `cEgz7d`） |

## 怎么玩
1. 点左上角 **＋** 加连接，填主机/端口/账号，并填**环境**（如 `生产`）和可选的**分组**；保存。
2. 左侧自动按环境聚合；展开连接 → 数据库 → **表** → 展开某表看**列**（PK 有黄色 `PK` 标）。
3. **点表** → 中间结果区显示前 200 行只读数据；**双击列名** → 列名插入到 SQL 编辑器。
4. Redis 连接：展开 → 有键的 `dbN` → key（点击看类型化值）。

## 修复的坑
- `browse` 的 `while let` 漏 `?`（原 `query()` 有）→ 类型推断连锁报错，补 `?`。
- `browse_key` 先 move `lines` 再 `lines.len()` → 先算 `note` 再 move。
- `list_connections` 构造 `ConnSummary` 漏 `env`/`group` 字段 → 补。

## 本阶段未做（后续打磨项）
结果导出 CSV、数据网格**行内编辑（写回）**、表结构/DDL 查看、函数/事件/索引/外键节点、用户管理/导入导出、连接管理快捷键、MCP 可视化配置、Release 体积优化（musl/UPX）、桌面主题切换。

## 文档
- `ARCHITECTURE.md`：新增 **ADR-015**（左树/分组决策 + 范围收敛说明）；「已知限制」更新。
