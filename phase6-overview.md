# Phase 6 — 连接管理内置于 TUI

## 做了什么
此前连接只能靠 `chatquery add` CLI 落库，TUI 里连接面板只有上下选择。作为 Navicat 替代品，这是最大的体验割裂点（且 CLI 参数密码会进 shell 历史）。Phase 6 把连接的**全生命周期搬进 TUI**。

## 改动
- **存储层**（`db/connection.rs` + `store/mod.rs`）
  - `ConnectionStore::update`（按 id 插入/替换）、`ConnectionStore::remove`
  - `Storage::delete_connection`（DELETE WHERE id）
  - 密码仍走 ADR-010 AES-256-GCM 加密落盘，复用既有 `upsert`/`load`。
- **TUI 状态**（`tui/app.rs`）
  - 新增 `ConnForm`：7 字段（名称/类型/主机/端口/用户/密码/库），`db_type` 用 ← → 切换封闭枚举；文本字段复用单个 `TextArea`，切换字段时在「字段缓冲 ↔ textarea」间搬运。
  - `App.form: Option<ConnForm>`、`App.confirm_delete: Option<usize>`。
  - `Connections` 焦点：`a` 新增 / `e` 编辑 / `d` 删除（二次 `y` 确认）/ `Enter` 或 `Tab` 进查询。表单内 `Ctrl+S` 保存、`Esc` 取消；名称/主机为空时不保存。
- **UI 渲染**（`tui/ui.rs`）
  - 覆盖式表单弹窗（active 字段把 `TextArea` 放在标签右侧）+ 删除确认居中弹窗。
  - 连接面板标题补按键提示。

## 验证
- `cargo build`：零警告。
- `cargo test`：7 项全绿（回归通过）。
- CLI `add --help` 仍可用，未破坏既有落库路径。

## 决策记录
- 新增 **ADR-011**：为什么把连接管理内置 TUI 而非扩展 CLI（避免密码进 shell 历史、体验闭环、表单内存可控）。
- 权衡：表单为单行字段、非全屏编辑器；多行/复杂值暂不支持（当前连接字段均为单行，足够）。

## 剩余
- TUI 主题切换
- 结果脱敏（SQL 上云时的字段遮蔽）
