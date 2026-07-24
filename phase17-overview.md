# Phase 17 — SQL 格式化 + 表关系视图（ER 简版）

> ADR-021 | 参考：Chat2DB (OtterMind/Chat2DB)

## 做了什么

对照 Chat2DB（4071 次提交的成熟 AI DB 客户端）分析后发现两个缺失功能，都属于"低成本·高价值"象限：

### 1. SQL 格式化（纯前端）

所有 DB 工具的标配功能，我们居然还没有。

- 引入 `sql-formatter` npm 包（~50KB gzip）
- `editor.ts` 的 `EditorHandle` 加 `formatSql()` 方法
  - 有选区时只格式化选区
  - 无选区时格式化全文
  - 语言固定 mysql，关键字大写，缩进 2 空格
  - catch 异常后静默失败，不破坏编辑器内容
- `App.tsx` 编辑器工具栏加"格式化"按钮

### 2. 表关系视图（ER 简版）

能直观看到数据库中所有外键依赖，对理解陌生数据库结构极有帮助。

**后端**：
- `src/db/mysql.rs`：新增 `ForeignKeyInfo` 结构体 + `list_relationships(cfg, db)`
  - 查 `INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL`
  - 返回 `{constraint_name, table_name, column_name, referenced_table, referenced_column}`

**Tauri 命令**：
- `list_relationships` 注册于 `main.rs`

**前端**：
- `types.ts`：加 `ForeignKeyInfo` 接口
- `api.ts`：加 `listRelationships` 方法
- `App.tsx`：
  - `relationshipView` 状态
  - `renderRelationships()`：渲染外键关系表（Constraint | 子表 | 子列 | → | 父表 | 父列）
  - `showRelationships()`：调 API 加载数据
  - 结果面板支持三种视图：数据 / 表结构 / 表关系
- `Tree.tsx`：数据库节点右键加"表关系"菜单项
- `style.css`：加 `.fk-arrow` 样式

## 设计取舍

- **SQL 格式化器对非标准语法（存储过程、DELIMITER）可能出错** — `formatSql` catch 异常后静默失败，不破坏编辑器内容。未来可考虑切换到更强大的格式化器。
- **表关系视图是列表形式而非图形化 ER 图** — 没有自动布局的节点/连线。列表对查看足够，图形化留给后续可选增强（需要引入图布局库如 dagre/d3）。
- **两个功能完全正交**，互不依赖。`relationshipView` 和 `structureView` 都是 transient state，由 `clearEditState()` 统一清空。

## 验证

- `cargo check` ✅
- `cargo test --lib` 16/16 ✅
- `npm run build` 145 模块零错 ✅

## 文件变更

| 文件 | 变更 |
|------|------|
| `frontend/src/editor.ts` | 加 `formatSql()` 方法 + import sql-formatter |
| `frontend/src/App.tsx` | 加格式化按钮 + `relationshipView` 状态 + `renderRelationships()` + `showRelationships()` |
| `frontend/src/Tree.tsx` | db 节点右键加"表关系"菜单项 + `onShowRelationships` prop |
| `frontend/src/types.ts` | 加 `ForeignKeyInfo` 接口 |
| `frontend/src/api.ts` | 加 `listRelationships` 方法 |
| `frontend/src/style.css` | 加 `.fk-arrow` 样式 |
| `src/db/mysql.rs` | 加 `ForeignKeyInfo` 结构体 + `list_relationships()` 函数 |
| `src-tauri/src/commands.rs` | 加 `list_relationships` 命令 |
| `src-tauri/src/main.rs` | 注册 `list_relationships` |
| `ARCHITECTURE.md` | ADR-021 |
