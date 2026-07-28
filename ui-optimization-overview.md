# ChatQuery · UI 体验与美观优化

> 将 `frontend/src/style.css` 整体对齐团队既有设计系统（`ui-design/assets/tokens.css` + `components.css`），
> 修复主题 bug，并强化结果表格的数据可读性。纯前端改动，未触及 JSX 结构与后端。

## 做了什么

### 1. 视觉体系统一（设计令牌驱动）
- 完整引入设计令牌：品牌蓝 `#6b8aff`(暗) / `#4f7cff`(亮)、语义色（success/warning/danger/info）、阴影阶梯、圆角、4px 间距、Inter/JetBrains Mono 字体栈（带系统回退）、动效曲线、focus ring。
- 暗色为 `:root` 默认，亮色走 `[data-theme="light"]`，与 `App.tsx` 的主题切换逻辑完全一致。

### 2. 修复既有主题 Bug（之前会影响亮色模式）
- 聊天气泡 `.msg.user` / `.msg.assistant` 硬编码 `#1e2a3a` / `#2a2330` → 改为 token，亮暗自适应。
- `.cell-edit` 引用未定义的 `--bg-1` → 改用 `--bg-surface`。
- `.result-table td.editable:hover` 引用未定义的 `--accent-soft` → 已定义并修复虚线描边。
- 字体 `--mono` 未定义 → 补 `--font-mono` 别名。

### 3. 体验层打磨
- **按钮层级统一**：原先「格式化 / 存为片段 / 历史 / 执行计划」与「执行」全用 accent 实心，无主次；现次要按钮为 subtle/ghost 风格，主操作为品牌实心，hover/active 有反馈。
- **过渡与微交互**：tree 行、tab、按钮、菜单、弹窗均加入 hover/active/focus 过渡；弹窗/下拉/右键菜单加入 `pop-in`，模态 `modal-in`，toast `toast-in` 入场动画；`prefers-reduced-motion` 自动降级。
- **结果表格可读性**
  - 字面 `NULL` → 弱化斜体（`<span class="cell--null">`）。
  - 纯数字 → 等宽字体（`<span class="cell--null">`→`cell--num`）。
  - 表头 sticky、斑马纹、行 hover、行/列选中高亮、dirty 单元 warning 底色、插入行 success 底色，均用 token 重做。
- **细节**：分页器、状态栏发光点、历史列表、设置厂商下拉、DB 切换弹窗、右键菜单、滚动条（细滚动条 + 主题色）全部按设计系统重做；focus-visible 统一用品牌色 focus ring（WCAG AA）。

## 验证
- `npm run build` ✅（`tsc` 通过 + Vite 打包，CSS 32.9 kB / gzip 6.45 kB）。
- 全局排查确认无残留未定义 CSS 变量。
- 注意：JS bundle >500kB 的告警为 CodeMirror 既有体积，与本改动无关。

## 改动文件
- `frontend/src/style.css` — 整体重写（保留全部类名）
- `frontend/src/App.tsx` — `renderData` 中 NULL / 数字单元格包裹（`cell--null` / `cell--num`）

## 未做（如需可继续）
- 面板可拖拽分隔条（sidebar / 编辑器 / 结果 / chat 宽度可调）。
- 顶部栏（brand logo + ⌘K 命令面板，设计系统已定义 `.topbar`/`.palette`，需小幅 JSX 调整）。
- 连接项卡片化（设计系统的 `.conn-item` 比现有 tree 行更精致，需调整 `Tree.tsx` 结构）。
