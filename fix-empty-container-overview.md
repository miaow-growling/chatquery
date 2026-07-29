# 修复：新建环境 / 新建组保存后左侧树不显示

## 根因
不是没保存，是**前端渲染把空容器过滤掉了**。

`Tree.tsx` 的 `buildRoots` 里有一行 `if (groups.length === 0) continue;`：
它只在「某个环境在当前数据库类型下至少有一条连接」时才渲染该环境；
而新建的环境 / 组**本来就是空容器（没有任何连接）**，于是被整段跳过，
左侧树根本不渲染它。

讽刺的是，同一文件第 13 行的注释写明：
> "Environments and groups are first-class entities (ADR-016), so empty ones render naturally with no connections."
实现却和意图相反。后端 `create_environment` / `create_group` 其实早就成功持久化了，
`refresh()` 也拉到了新数据 —— 只是渲染层没把空环境画出来。

## 改动
文件：`frontend/src/Tree.tsx`、`frontend/src/style.css`

1. **显示依据从「有无连接」改为「容器本身是否存在」**
   - 有该类型连接的环境 → 照常嵌套在 `MySQL / Redis` 节点下（其内部空组也照常显示）。
   - 完全没有任何连接的真实环境（排除 `__ungrouped` 合成环境）→ 在侧栏顶层单独渲染为一个环境节点。
   - 这样「新建环境」「新建组（空）」点保存后立刻可见。

2. **空容器点开后加「暂无连接」占位**（`.tree-empty-child`），避免你点开空环境以为又坏了。

## 验证
`npm run build` 通过（146 模块，0 错误）。

## 生效方式
纯前端改动，无需重启 Rust。窗口内按 `Cmd + R` 刷新即可。
刷新后：点 `＋ → 新建环境`，输入名称确定，左侧立刻出现该环境（点开显示「暂无连接」）；
右键它 `新建组` 同样立即出现。

## 顺带澄清
上一轮修的「点击无反应」是 Tauri 桌面端没有原生 `window.prompt`；
这一轮是「点了有反应、但保存后不显示」—— 两件事是不同根因，现已都修好。
