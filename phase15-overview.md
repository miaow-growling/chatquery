# Phase 15：数据写回完善 — INSERT / DELETE 行（ADR-019）

## 做了什么

在 ADR-018（MySQL 单元格 UPDATE）基础上，补齐了 **INSERT（新增行）** 和 **DELETE（删除行）**，让 MySQL 表的 CRUD 在网格内完整闭环。

## 改动文件

### 后端
| 文件 | 改动 |
|------|------|
| `src/db/mysql.rs` | 新增 `insert_row()`（参数化 INSERT，空列省略→DB 默认值）和 `delete_row()`（参数化 DELETE WHERE pk） |
| `src-tauri/src/commands.rs` | 新增 `insert_row` / `delete_row` Tauri 命令（复用 `SetPair`/`PkPair` DTO） |
| `src-tauri/src/main.rs` | 注册两个新命令 |

### 前端
| 文件 | 改动 |
|------|------|
| `frontend/src/api.ts` | 加 `insertRow` / `deleteRow` 方法 |
| `frontend/src/App.tsx` | 新增 `deletes: Set<number>` / `inserts: Record<number,string>[]` 状态；每行 `×`/`↩` 删除标记按钮；「新增行」按钮追加空白插入行；保存修改统一处理 UPDATE→INSERT→DELETE；`clearEditState()` 统一清空 |
| `frontend/src/style.css` | 加 `.row-action-col` / `.row-del-btn` / `.row-deleted` / `.row-insert` / `.insert-cell` |

### 文档
| 文件 | 改动 |
|------|------|
| `ARCHITECTURE.md` | 新增 ADR-019；更新"待打磨"清单 |

## 交互说明

1. **删除行**：编辑态下每行左侧有 `×` 按钮，点击标记删除（行变删除线+半透明），再点 `↩` 取消。
2. **新增行**：点击「新增行」按钮，底部追加一行空白行，所有单元格均为输入框，填入值后点「保存修改」。
3. **保存**：按 UPDATE → INSERT → DELETE 顺序执行，任一失败则停止并保留编辑态。
4. **撤销**：清空所有编辑/删除/新增标记。
5. **INSERT 省略空列**：空单元格不包含在 INSERT 语句中，DB 默认值/AUTO_INCREMENT 自然生效。

## 验证

- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `cargo test --lib` 16/16 ✅
- `npm run build` 55 模块零错 ✅

## 仍未做（后续独立 Phase）

- Redis 写回
- 视图写回
- 乐观锁/并发冲突检测
- 置 NULL 编辑（当前空串=空字符串，非 NULL）
- BLOB/二进制列编辑
- 批量操作整体事务原子性（当前逐行提交）
