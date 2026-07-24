# Phase 18 — 参考 Chat2DB 的四项 UI 改进

> 参考项目 [OtterMind/Chat2DB](https://github.com/OtterMind/Chat2DB)（成熟 AI DB 客户端，4071 次提交）。
> 策略：**借模式不借像素**——只学它验证过的通用 DB 工具交互模式，不抄品牌化结构。

## 做了什么（纯前端，零 Rust 改动）

### 1. 底部状态栏 / 控制台
- `App.tsx` 新增 `runInfo` 状态；`runQuery` / `browseTable` / `browseRedisKey` / `explainQuery` 用 `performance.now()` 计耗时。
- 成功按结果形状判断（`'rows' in result` → 返回行数；redis `note` 存在 → 错误）显示：
  - `✓ 12ms · 返回 100 行` / `✓ 12ms · 返回 100 行 (已截断, 请加 LIMIT)`（warn 色）
  - `✗ 12ms · 错误信息`（err 色）
- `main` 底部渲染 `.status-bar`：状态点 + 文案 + 当前连接名。

### 2. 结果子标签
- 新增 `resultTab: 'data' | 'structure' | 'relation'` 状态，结果面板头部改为标签条（**数据 / 表结构 / 表关系**）。
- body 按 `resultTab` 切换；"表结构/表关系"无缓存数据时从当前 `browseCtx` 懒加载。
- `clearEditState` 一并重置 `resultTab`；`showStructure` / `showRelationships` 错误改写状态栏而非清空结果面板。

### 3. 可折叠 AI 面板
- 新增 `chatOpen` 状态（localStorage 持久化）。
- `.app.chat-collapsed` → grid 第三列收窄到 30px，渲染 `.chat-rail` 重开按钮；展开时头部有收起按钮。

### 4. 明暗主题切换
- 新增 `theme` 状态（localStorage 持久化），切换 `<html data-theme>` 驱动 CSS 变量。
- `style.css` 新增 `:root[data-theme="light"]` 亮色变量集。
- `editor.ts` 加 `themeConf` Compartment + `setTheme(dark)`，用 `@codemirror/theme-one-dark` 切换编辑器主题。
  - **附带修复**：此前 `basicSetup` 默认亮色，编辑器长期"亮底暗壳"不一致，现默认暗色与 app 统一。

## 验证
- `npm run build` ✅（146 模块，tsc + vite 零错）
- 无 Rust 改动，`cargo` 无需重编
- 需重启 `tauri dev` 让前端热更新（或直接重新打开窗口）

## 设计取舍
- **不抄顶部菜单栏**：与 Tauri 桌面形态不符，侧栏 + 下拉已覆盖。
- **不做法图形化 ER 图**：仍为列表（列表对查看足够，图形化布局留给后续）。
- **亮色主题次要不一致**：`.msg.assistant` / `.msg.tool` 等少量硬编码暗底气泡未在亮色下重算——可接受的低优先级项。
- 全部为前端 UI 状态，不侵入数据模型 / 命令层 / 类型契约，完全可逆。

## 仍未做（见 ADR-022 放弃项）
多数据库支持（Postgres/SQLite）、数据可视化图表、Redis/视图写回、乐观锁、置 NULL 编辑、图形化 ER 图、CSV 导入。
