# Phase 16：表结构 / DDL 查看（ADR-020）

## 做了什么

在数据 CRUD 闭环之后，补齐了**表结构查看**——右键树中的表节点 → "表结构"，结果面板显示列详情、索引、CREATE TABLE DDL。这是 Navicat/TablePlus/DBeaver 的标配功能，属于"低成本·高价值"象限。

附带修复了 Phase 15 引入的 `clearEditState` 递归自调用 bug（`setEdits({})` 被批量替换误伤成 `clearEditState()`，会导致栈溢出）。

## 改动文件

### 后端
| 文件 | 改动 |
|------|------|
| `src/db/mysql.rs` | 新增 `ColumnDetail`/`IndexInfo`/`TableStructure` 结构体；`describe_table()` 查 INFORMATION_SCHEMA（全类型+EXTRA）+ SHOW INDEX + SHOW CREATE TABLE |
| `src-tauri/src/commands.rs` | 新增 `describe_table` Tauri 命令；import 加 `TableStructure` |
| `src-tauri/src/main.rs` | 注册 `describe_table` |

### 前端
| 文件 | 改动 |
|------|------|
| `frontend/src/types.ts` | 加 `ColumnDetail`/`IndexInfo`/`TableStructure` 接口 |
| `frontend/src/api.ts` | 加 `describeTable` 方法 |
| `frontend/src/App.tsx` | 加 `structureView` 状态 + `showStructure` 函数 + `renderStructure()` 渲染；结果面板条件渲染结构视图；`clearEditState` 统一清空；修复递归 bug |
| `frontend/src/Tree.tsx` | `TreeProps` 加 `onShowStructure`；表节点右键加"表结构"项 |
| `frontend/src/style.css` | 加 `.structure-view`/`.struct-table`/`.ddl-block` 等样式 |

### 文档
| 文件 | 改动 |
|------|------|
| `ARCHITECTURE.md` | 新增 ADR-020；待打磨清单移除"表结构/DDL 查看" |

## 交互说明

1. **右键表节点** → "表结构" → 结果面板切换为结构视图
2. **列详情表**：Field | Type（全类型如 `varchar(255)`）| Null | Key | Default | Extra（auto_increment 等）
3. **索引表**：按索引名分组，显示 Name | Columns | Unique
4. **DDL**：`SHOW CREATE TABLE` 原文，`<pre>` 块可滚动、可选中复制
5. **返回数据**：点击"返回数据"按钮回到数据网格视图
6. **自动关闭**：切标签、执行查询、翻页时结构视图自动关闭（`clearEditState` 统一处理）

## 验证

- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `cargo test --lib` 16/16 ✅
- `npm run build` 55 模块零错 ✅

## 仍未做（后续独立 Phase）

- Redis 写回、视图写回
- 乐观锁/并发冲突检测
- 置 NULL 编辑（空串=空字符串而非 NULL）
- BLOB/二进制列编辑
- 批量操作整体事务原子性
- 函数/事件/索引/外键节点（树中展示）
- 连接管理快捷键
- MCP 服务器可视化配置
- Release 体积优化
- 桌面端主题切换
