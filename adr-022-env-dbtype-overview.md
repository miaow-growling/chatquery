# ADR-022: 环境绑定数据库类型

## Status
Accepted

## Context
用户新建环境后，环境出现在连接树**第一级（顶层）**，且新建时没有任何"选 MySQL 还是 Redis"的提示。
根因：环境是 ADR-016 引入的一等容器，**本身不绑定数据库类型**，设计意图是"一个环境可同时容纳 MySQL 和 Redis 连接"。
树的顶层按连接的**实际类型**分组（`MySQL ▸ 环境 ▸ 分组 ▸ 连接`），而新建的环境是空容器、没有任何连接，
无法归属任何类型，于是被上一轮"空环境渲染"修复放到顶层第一级。

## Decision
环境**绑定单一数据库类型**（用户在两个方案中选定此方案）。具体落地：
- `Container` 增加 `db_type: Option<DbType>` 字段（`serde(default)`，缺失的旧数据按 MySQL 处理）。
- SQLite `containers` 表通过幂等迁移新增 `db_type TEXT` 列（`open()` 中 PRAGMA 检查后 `ALTER TABLE`）。
- `create_environment` 命令新增 `db_type` 参数；新建环境弹窗让用户选 MySQL/Redis。
- 树的 `buildRoots` 改为按**环境自身 `db_type`** 归类，空环境也能落到对应类型下；删除"顶层空环境"分支。
- `__ungrouped` 合成环境仍按连接类型拆分，保持兼容。

## Consequences
- 容易：新建环境时清晰选择类型，环境直接出现在对应根（`MySQL` / `Redis`）下，空环境不再"流浪"到顶层。
- 容易：数据模型与 UI 行为一致，符合大多数 SQL 客户端的直觉。
- 放弃：一个环境不再能同时容纳 MySQL + Redis 连接（混用需建两个环境）。这是用户明确接受的权衡。
- 兼容：旧数据（无 `db_type` 列/字段）加载时按 MySQL 渲染，无需手动迁移。

## 改动文件
- 后端：`src/db/container.rs`、`src/store/mod.rs`、`src/db/connection.rs`、`src-tauri/src/commands.rs`
- 前端：`frontend/src/types.ts`、`frontend/src/api.ts`、`frontend/src/App.tsx`、`frontend/src/Tree.tsx`、`frontend/src/style.css`
- 验证：`cargo check --lib` + `npm run build` 均通过；后端已重启（pid 91600），窗口内 `Cmd+R` 后新建环境会弹出类型选择。
