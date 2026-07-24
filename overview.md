# 概览：本地数据库终端工具架构设计

## 做了什么
为「替代 Navicat 的本地终端数据库工具」输出了完整架构设计基线（`ARCHITECTURE.md`），覆盖目标约束、模块划分、5 份 ADR、资源预算与分阶段路线图。

## 关键决策（已与用户确认）
- **语言**：Rust 单二进制（资源小、无 GC）
- **LLM**：云端 OpenAI 兼容流式 API（算力外推，主程序零额外内存）
- **UI**：完整交互式 TUI（ratatui）
- **MCP**：stdio 子进程按需拉起（进程隔离、崩溃不影响主程序）

## 架构形态
模块化单体（单二进制） + 内部 bounded context 模块：连接管理 / QueryEngine（MySQL·Redis 适配器）/ LLMChat / MCPHost / TUI / 编排层。本地 SQLite 持久化配置与历史。

## 核心权衡
「资源小」通过三道隔离实现：LLM 算力上云、MCP 进程外置、原生编译。代价是 LLM 需网络与 Key（SQL 会上云，需脱敏选项），且 Rust 开发曲线较陡。

## 下一步
Phase 1–5 均已完成。后续可选项：TUI 主题切换、结果脱敏（SQL 上云时字段遮蔽）、连接增删改 UI、OS keychain 替代自管理密钥文件。

## 当前进度（2026-07-22）
- **Phase 1–4 已完成**（见上版概览）：脚手架 + TUI + MySQL/Redis 适配器（SCAN/拦截 KEYS）+ 模块化重构 + LLM 流式对话 + MCP 子进程集成，编译零警告，专项测试全绿，release 实测 3.1MB。
- **Phase 5（打磨）已完成并编译零警告、测试 7 项全绿、release 实测 3.2MB**：
  - **连接配置加密（ADR-010）**：新增 `src/crypto.rs`，AES-256-GCM 加密整条连接记录，密钥独立存 `~/.config/chatquery/key`（0600）；加载时旧明文记录自动重写加密。已验证 `app.db` 中无任何明文 JSON / 密码子串。
  - **Redis 引号解析**：`tokenize` 支持单/双引号 + 反斜杠转义，`SET k "a b"` 正确解析；含单测。
  - **结果/转录滚动**：`PgUp`/`PgDn` 滚动、`End` 回到底部（`Table`/`List` 用切片窗口渲染，因 ratatui 0.29 移除 `.scroll()` 构建器）。
  - **结果导出**：`Ctrl+E` 把当前结果导出（Table→CSV 带字段转义，Redis→TXT）；`mysql::to_csv` 含单测。
- 踩坑新增：ratatui 0.29 移除 `Table::scroll`/`List::scroll`（改 stateful 或切片窗口）；aes-gcm/getrandom/base64 新增依赖仅 +0.1MB。
- 待做：主题切换、脱敏选项、连接管理 UI、OS keychain。
