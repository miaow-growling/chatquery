# Phase 11 — 双击表浏览 + 分页 + 修浏览报错

## 问题根因
1. **浏览报错**：`mysql::browse` 用 `sanitize_ident` 构造标识符，会把表名里的空格/特殊字符全删掉
   （如 `Order Items` → `OrderItems`），导致 `Table '...' doesn't exist`。
   改为 `quote_ident`：去掉反引号后用反引号包裹，既防注入又保留合法名字。
2. **交互混乱**：原单击表既触发 browse 又触发 toggle（展开/收起），双击 = 两次 browse + 两次 toggle，
   状态乱、容易触发无关错误。改为 Navicat 习惯：**单击表展开列、双击表浏览数据**。

## 改动
### 后端（Rust）
- `src/db/mysql.rs`：`browse(cfg, db, table, page, page_size)` 改为分页
  （`LIMIT ? OFFSET ?`，page 0-based，page_size 受 `PAGE_LIMIT=200` 限制）；
  额外 `SELECT COUNT(*)` 取 total；`QueryResult` 增加 `total: Option<usize>`；
  `query()`（任意 SQL）total 置 None；删除 `sanitize_ident`，新增 `quote_ident`。
- `src/mask.rs`：`mask_query_result` 构造 `QueryResult` 补 `total` 字段。
- `src-tauri/src/commands.rs`：`browse_table` 增 `page`/`page_size` 参数，`QueryOutput::Table`
  增加 `total`/`page`/`page_size`（`#[serde(default)]`）；`execute_query` 构造处补 `total:None`。

### 前端
- `types.ts`：`QueryOutput.Table` 增加 `total?`/`page?`/`pageSize?`。
- `api.ts`：`browseTable(connId, db, table, page, pageSize)` 传 `page`/`page_size`。
- `Tree.tsx`：单击表只 toggle 展开列；双击表调 `onBrowseTable(...,0,PAGE_SIZE)` 并保持在展开态；
  列节点双击仍插入编辑器。
- `App.tsx`：`browseTable` 维护 `browseCtx`；`runQuery` 清空 `browseCtx`；结果区底部渲染翻页条
  （第 X/Y 页 · 共 N 行，上一页/下一页边界禁用）。
- `style.css`：新增 `.pager` / `.pager-info` 样式。

## 验证
- 后端 `cargo check`（src-tauri）✅；前端 `npm run build`（TS 零错）✅
- `tauri dev` 重编译 47.8s 后原生窗口弹出运行，无 panic ✅

## 怎么用
1. 展开 连接 → 库 → **表**（单击只看列）
2. **双击表** → 中间结果区显示前 200 行 + 底部翻页条（上一页/下一页）
3. 翻页会按当前 表/库/连接 重新取对应页并刷新 total

> Redis 浏览（key）暂不分页（值结构不统一），后续可单独加。
