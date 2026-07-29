# 修复：新建环境 / 新建组点击无反应

## 现象
桌面端点击「＋ → 新建环境 / 新建组」(以及删除连接、重命名等)无反应。

## 根因
Tauri v2 的 webview 默认不实现 `window.prompt` / `confirm` / `alert`。这些调用在桌面窗口里静默 no-op：
- `newEnvironment` / `newGroup` 靠 `window.prompt()` 取名称，拿到 `null` 后直接 `return`，所以"点了没反应"。
- 删除类靠 `confirm()`，同样失效。

后端命令 (`create_environment` / `create_group` 等) 本身正常 —— 是纯前端对话框在桌面环境失效。

## 修复
- `frontend/src/App.tsx`：新增 `dlg` state + `promptAsync` / `confirmAsync` / `closeDlg`(promise 化 modal)；
  全部 `window.prompt` → `await promptAsync`、`confirm(` → `await confirmAsync(`、`alert(` → `showToast`(复用既有 toast)。
  在 App 根容器内、toast 之前渲染 modal。
- `frontend/src/style.css`：复用既有 `.modal*` 样式(连接表单同款)，仅补 `.modal-msg`。

## 生效方式
纯前端改动，无需重编译 Rust。vite HMR 即时生效，在 ChatQuery 窗口内按 `Cmd+R` 刷新即可。

## 验证
`npm run build` 通过(146 模块，0 错误)。
