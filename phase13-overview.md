# Phase 13 概览：查询可用性补齐（ADR-017）

把 ChatQuery 从"能看的只读浏览器"推进到"能干活"——收割优先级矩阵左上角（低成本·高价值）的四件能力。

## 做了什么

| 能力 | 后端 | 前端 |
|---|---|---|
| **结果导出 CSV** | —（纯前端） | 表结果「导出 CSV」按钮，RFC-4180 引号转义 + UTF-8 BOM（Excel 不乱码），Blob 下载 |
| **查询历史 / 片段** | `queries` 表 + `log_query`/`list_queries`/`save_query`/`delete_query` | 历史面板（载入 / 命名 / 删除），每成功执行自动记历史，「存为片段」命名保存 |
| **EXPLAIN 执行计划** | `explain_query`（MySQL 前缀 `EXPLAIN `，Redis 返回提示） | 「执行计划」按钮，结果进同一结果区 |
| **多标签 + 运行选中** | — | `QueryTab` 状态（每标签独立 sql/结果/浏览上下文）；有选区只跑选区，否则跑全文 |

## 关键设计

- **单编辑器实例 + 多标签**：CodeMirror 实例只挂载一次，切换标签用 `replaceValue` 同步内容；输入经 updateListener 写回**活动标签**。靠 `activeTabIdRef` 保证写回目标正确（先改 ref 再 replaceValue，避免竞态）。
- **历史与片段同表**：`name` 为 NULL = 自动记录的历史；非 NULL = 用户命名片段。面板统一展示，历史条目可一键命名为片段。
- **EXPLAIN 复用执行路径**：只是给 SQL 加 `EXPLAIN ` 前缀走既有 `mysql::query`，零新依赖。

## 验证

- `cargo test --lib`：16/16 通过
- `cargo check src-tauri`：通过
- `npm run build`：零类型错误（55 模块）

> **必须重启 `tauri dev`** 重新编译 Rust，才能加载新建的 `queries` 表并注册新命令。前端 Vite 热更不够。

## 取舍（按架构师规矩）

- **得**：查询不再丢、能看执行计划、能导出、多标签并行——工具首次具备"日常可用性"。
- **舍**：历史表暂未做容量裁剪（仅 `list` 限 200 条，老数据仍堆积，后续加 prune）；EXPLAIN 仅 MySQL；**数据写回未做**（矩阵右上角最大痛点，独立重 Phase）。
- **可逆**：全部新增能力，未改动连接/容器模型，历史表独立于主数据流。

## 下一步候选（矩阵右上角）

1. **数据写回**（行内编辑 + 增删改）：需事务 + 类型校验 + 失败回滚机制
2. **SSH 隧道 / SSL**：连真实生产库前提
3. **Postgres / SQLite** 支持
4. **DDL 查看 / 表设计**、**网格内筛选排序**
