# Redis 浏览器移入中间区域 — 实施总结 (2026-08-11)

## 问题
Redis 键列表之前放在左侧边栏树中，成千上万个 key 会撑爆侧栏，不可用。

## 改造方案
根据连接类型动态切换中间区域布局：
- **MySQL 连接** → 保持原编辑器 + 结果网格
- **Redis 连接** → 显示 Redis 浏览器（key-list 双栏 + 控制台）

## 改动文件

| 文件 | 改动 |
|------|------|
| `frontend/src/Tree.tsx` | 移除 `rediskey` 节点类型；移除 `redisdb` 懒加载；移除 `keyTypeIcon`/`fmtTtl`/`fmtSize` 辅助函数 |
| `frontend/src/RedisBrowser.tsx` | **新建**。双栏布局：左侧 key 列表（模式过滤 + 分页 + type/TTL/size），右侧类型感知值查看器；含"浏览器"/"控制台"标签页 |
| `frontend/src/App.tsx` | 添加 `isRedisConn` 检测；引入 RedisBrowser；中间区域按连接类型条件渲染 |
| `frontend/src/style.css` | Redis 浏览器双栏布局、key 表格、控制台样式；更新 redis-kv-table/redis-list-view 表格化样式 |

## 验证

| 检查项 | 结果 |
|--------|------|
| `tsc --noEmit` | ✅ |
| `vite build` | ✅ |
| `cargo check` | ✅ |
