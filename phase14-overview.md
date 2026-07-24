# Phase 14 概览：数据写回 MVP（MySQL 表单元格行内编辑）

> 把工具从"只读浏览器"升级为"能改数据"——这是缺口矩阵右上角的头号痛点，也是"只读"变"完整查询工具"的最后一跃。按架构师纪律，本次只做**最小可验证切片**（MySQL 表单元格 UPDATE），把一整套重的写回机制拆成可独立验证的一步。

## 做了什么

### 后端
- **`src/db/mysql.rs`**
  - `QueryResult` 新增 `primary_keys: Vec<String>` 字段。
  - `browse()` 在取总数前，额外查 `INFORMATION_SCHEMA.COLUMNS` 取 `COLUMN_KEY='PRI'` 列填入；无主键则为空。
  - 新增 `apply_edit(cfg, database, table, pk, set)`：把一行所有脏单元格**合成单条参数化 `UPDATE`**（`SET` 带新值，`WHERE` 用**原始主键快照**），在事务里提交。`set` 为空直接 no-op。
- **`src/mask.rs`**：`mask_query_result` 透传 `primary_keys`（脱敏只作用于展示副本，不影响写回路径）。
- **`src-tauri/src/commands.rs`**
  - `QueryOutput::Table` 新增 `primary_keys` 字段（三个构造点：`browse_table` 填真实值，`execute_query`/`explain_query` 填空）。
  - 新增 `apply_edit` 命令 + `PkPair`/`SetPair` DTO，经 `resolve_cfg` 取连接配置后调用 `mysql::apply_edit`。
- **`src-tauri/src/main.rs`**：注册 `apply_edit`。

### 前端
- **`src/types.ts`**：`QueryOutput.Table` 加 `primaryKeys?: string[]`；新增 `EditPayload`。
- **`src/api.ts`**：新增 `api.applyEdit(payload)`。
- **`src/App.tsx`**
  - 编辑态：`edits`（row→col→新值 overlay）、`editing`、`draft`。
  - `editable` 派生：仅当"浏览态 + 结果有主键"时为真；任意 SQL / 无 PK 表 / 视图 / Redis 均只读。
  - 单元格**双击进入编辑**、脏单元格 `.dirty` 高亮、`editable` 类显示编辑光标。
  - 「保存修改」按行分组逐行调用 `apply_edit`，成功刷新并清空 overlay；「撤销修改」清空。
  - 编辑态在切换标签 / 重新查询 / 翻页时自动清空（避免跨标签污染）。
- **`src/style.css`**：`.dirty` / `.editable` / `.cell-edit` / `.hint` 样式，主键列表头 `.pk` 高亮 + 🔑 标记。

## 明确放弃（后续独立 Phase）
1. 新增行 / 删除行（INSERT / DELETE）
2. Redis 写回
3. 视图写回
4. 乐观锁 / 并发冲突检测（当前用快照 WHERE，并发改同一行会静默覆盖）
5. 置 NULL 编辑（空串即空串，不识别 NULL 字面）
6. BLOB / 二进制列编辑

## 验证
- `cargo check src-tauri` ✅
- `cargo test --lib` 16/16 ✅（含 `QueryResult` 字段改动后的既有测试）
- `npm run build` 零类型错误（55 模块）✅

## 你需要做的
**重启 `tauri dev`** 重新编译 Rust——`apply_edit` 命令、`QueryResult.primary_keys`、`browse` 的 PK 查询都必须重编译才生效；前端 Vite 热更不够。

## 体验路径
双击任意 MySQL 表 → 进入浏览网格 → 主键列表头带 🔑 → **双击某单元格**编辑 → 改多处后点「保存修改」→ 数据落库并刷新。无主键的表/视图/任意 SQL 结果保持只读（不会给编辑入口）。

详见 `ARCHITECTURE.md` 的 **ADR-018**。
