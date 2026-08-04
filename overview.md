# 知识库功能（ADR-AI-6）实现概览

## 已完成
全链路实现「上传知识库 → 绑定连接/数据库 → AI 查询时自动参考」功能，分后端（前一轮已完成）与前端（本轮）两部分。

### 后端（前一轮，三套 `cargo check` 全绿）
- `src/store/mod.rs`：`kb_docs` + `kb_bindings` 两张表（明文，零新依赖）、CRUD、绑定 junction 表（`(kb_id, conn_id, database)` 主键，database 可空=整条连接）。
- `src/llm/`：`KbLoader` 类型别名 + `SearchKnowledge` 工具（主动检索兜底）+ `context_block` 被动注入（每库≤2000字/总≤6000字）。检索逻辑收敛于 `get_injected_kb_docs` 与 `SearchKnowledge` 两点。
- `src-tauri/`：`add_kb_doc` / `update_kb_doc` / `list_kb_docs` / `delete_kb_doc` / `set_kb_bindings` 五条命令；`AppState.store` 改为 `Arc<Mutex<ConnectionStore>>` 以克隆进 spawned future 构造 'static 闭包。

### 前端（本轮，Task #175/176/177）
- `types.ts`：新增 `KbDocDto` / `KbBindingDto` / `KbBindingInput`。
- `api.ts`：封装 5 条 invoke。
- `App.tsx`：设置面板新增「知识库」tab（两栏布局）。
  - 左：文档列表（点击编辑 / 新建 / 显示绑定数与字数）。
  - 右：编辑器（名称、内容 textarea、`CertPickButton` 文件导入复用、绑定编辑器）。
  - 绑定编辑器：选连接 → 可选具体库（`listDatabases` 懒加载进缓存，空=整条连接）；新建文档需先保存拿回 id 才能绑定。删除走自建 `confirmAsync` modal（避开 Tauri 无 `window.confirm` 陷阱）。
- `style.css`：`.kb-*` 样式。
- 验证：`tsc --noEmit` 0 错；`npm run build` 成功（chunk>500kB 警告为既有，非本次引入）。

### 决策状态
`ai-feature-plan.md` 中 **ADR-AI-6 由 Proposed 转 Accepted**（2026-07-30 全链路落地）。

## 准确率策略（五道防线）
1. 绑定隔离——只注入与当前连接/库相关的知识，防跨库噪声。
2. schema 对齐——知识库与真实表结构一起进上下文。
3. 双通道检索——被动注入（小库全量）+ 主动 `search_knowledge`（大库兜底）。
4. 真跑 SQL 闭环——模型基于知识生成的 SQL 实际执行并返回结果。
5. 可观测纠偏——模型可见执行结果，错误可自纠。

## 已知取舍（诚实告知）
- 字面匹配会 miss 语义改写；超大库截断（≤6000字）可能丢信息；垃圾进垃圾出。
- 检索逻辑收敛在两点，将来换向量库/FTS5 上层零改动（可逆）。

## 后续演进（非本次）
写操作审计日志、单 turn 超时与 token 统计、跨轮持久化记忆、worker 并行、Explorer 去写工具、向量库升级 RAG、所有改动 git commit。
