# ChatQuery 项目长期记忆

## 技术栈与验证
Tauri v2 + React + Vite + TS 桌面 SQL 客户端;Rust library(sqlx MySQL)。
- 验证 lib/desktop:`cargo check --lib --no-default-features`。完整 TUI bin:`cargo check`(default 含 tui)。勿用 `cargo check --no-default-features`(会编译 src/main.rs 的 ratatui → unresolved crate)。
- 前端 HMR + 窗口 Cmd+R 即生效;Rust 改动/新命令需重启 cargo 才注册。

## 反复踩的坑
- 对话框:Tauri webview 不实现 window.prompt/confirm/alert(静默失效)→ 一律走自建 React modal(promptAsync/confirmAsync/dlg)+ toast。
- INFORMATION_SCHEMA 文本列 binary 字符集 → sqlx 报 BINARY,`try_get::<String>` 报错。修复:每文本列 `CAST(col AS CHAR) AS col`。SHOW INDEX/CREATE TABLE 正常无需 CAST。涉及 list_databases/schema/list_tables/describe_table/主键/list_relationships。
- WKWebView 合成崩溃(macOS 致命,窗口瞬关无 JS 报错):诱因(A)objc FFI 回调裸 msg_send! 致 panic_cannot_unwind;(B)滚动容器 sticky-left 单元格 + 大量 backdrop-filter 叠加。规则:结果表禁 sticky-left;sticky 背景必须不透明。
- 事件桥接:`BackendMsg→emit` 的 match 有 `_ => {}` 兜底,新变体被静默吞。新增须三处同步:model.rs 定义 / commands.rs arm / src/main.rs TUI arm。
- 测试并行污染:`std::env::set_var` 进程级,并行测试互覆盖 XDG_CONFIG_HOME → Storage::open 开错库、随机 flaky。修:模块级 static ENV_LOCK + env_lock()(守卫活到测试结束),且与 temp_store() 分离(否则死锁)。验证须连跑 5 次。
- Tauri `listen` 的 unlisten 异步 resolve(08-12):StrictMode 双挂载/HMR 下 effect cleanup 先执行、unlisten 落入已作废数组 → 监听器泄漏叠加,流式 token 被 N 个监听器各 append 一次(输出"你好你好你好"),泄漏的 chat-done 还重复落库。修:disposed 标志 + late-resolving unlisten 立即自注销(safe helper),禁止裸 `.then(u => arr.push(u))`。
- 防"逐词重复"双保险(08-12):流式 token 每个词重复 N 遍 = N 个泄漏监听器;恰好 2 遍 = 同一 turn 被触发 2 次。**React state 守卫防双击不可靠**(双击时第二次调用闭包仍读旧 state)→ 用 ref 同步守卫(发送即置 true,done/error 释放,invoke 成功返回不释放——流式还在跑);后端 chat_turn 加 AtomicBool 串行互斥兜底。

## 架构约定
- 环境/组一等实体(ADR-016);环境绑定单一 db_type(ADR-022),树按环境自身 db_type 归类。
- 分页:仅单条 SELECT 走 query_paged(LIMIT/OFFSET+COUNT);SHOW/EXPLAIN/INSERT/UPDATE/DELETE/多语句回退普通 query。
- 连接池(用户偏好):按连接缓存长生命周期池,LRU MAX_CACHED_POOLS=64 + 每池 MAX_CONN_PER_POOL=4 + idle_timeout=30s + min_connections(0)。key=host:port:user:password:database。禁止 pool.close()(池共享缓存)。勿无限制新建短生命周期池(曾致 EOF/抖动)。
- 大库性能:补全改 setSchemaContext + 懒加载 CompletionSource(search_tables LIMIT 200 / list_columns + 客户端缓存);schema()(AI 补全)仍全量拉列,超大库首用卡一次。树用 FolderView 窗口化(TREE_PAGE=200)+ 过滤,禁一次性渲染几千节点。

## Agent 架构(已落地 A+B+C)
多智能体 C:Orchestrator + worker(Explorer/Executor)。A 地基:ToolRegistry(BuiltinTool 枚举分发)、Agent/SessionMemory、policy N1 护栏(Allow/ConfirmRequired/Deny)、N2 上下文注入。B:needs_planning 启发式 + plan_task 无工具规划(先喷计划卡片再执行)。C:WorkerKind + classify_step 路由;build_worker 独立子 Agent;复杂任务=plan + N×worker + synthesize(串行,共享 TurnControl 整树取消),代价=更多 LLM 调用/延迟(ADR-AI-5 刻意取舍)。
交互控制面(08-03):TurnControl 可取消/写确认 modal(300s 超时)/计划卡片/cancel_turn。**已落地:审计日志(ADR-AI-1.3)、单 turn 超时(ADR-AI-4.2,TURN_TIMEOUT=300s)、token 用量(ADR-AI-4.3,ChatUsage)**(commit d2f2e3d 已 push)。
坑:tokio::select! arm 借用须具名绑定;schemas()/on_delta 闭包具名;BackendMsg 新变体三处同步;错误/ChatDone 须塞回 tx 由桥接顺序 emit(直接 app.emit 会插队截断)。
C 待做:跨轮持久化记忆、复杂度路由升级 LLM 自评、worker 并行调度、Explorer 去写工具。

## 产品定位与编辑器(2026-08-06，2026-08-10 更新)
定位:聚焦"AI 驱动的查询助手",不全面对标 DataGrip/Navicat(不做重投入的 DB 工作台竞品)。
编辑器现状:CodeMirror + MySQL 方言,补全已上下文感知(FROM/JOIN/别名、列类型/PK 标记/注释展示、外键驱动 JOIN 联想)、一键格式化、内联 AI 补全、右键菜单;EXPLAIN 树形可视化已完成。
结果网格:已实现排序(列头 asc/desc/none)、筛选(列级包含/等于/不等于/范围/空值 + 全局搜索)、导出(CSV/Excel/JSON 下拉)、复制为(JSON/INSERT/UPDATE/WHERE IN/CSV)、多结果集分标签。
语句历史:历史/片段弹窗 + 搜索 + 按连接筛选 + 载入/存为片段/删除。
已全部落地(2026-08-10):①结果排序/筛选/导出 ②补全增强 ③多结果集分标签 + 编辑器内语句历史。暂不做可编辑单元格(双击改值→UPDATE)。

Redis 浏览器(08-11):Redis 连接选中后中间区域切换为 Redis 浏览器模式(不再在左侧树展开 key)。浏览器含双栏(key-list 面板 + 类型感知值查看器)+ 控制台标签页。key-list 支持模式过滤 + 分页显示(type/TTL/大小)。MySQL 连接保持原编辑器+结果网格。

## AI 会话体系（08-12，docs/chat-conversation-design.md）
会话是一等实体:conversations/chat_messages 落 SQLite,前端只展示/加载(后端持久化,兼容 TUI)。6 命令 + chat_turn 增 conv_id/conv_refs(均可选)。
- 持久化时机:sendChat 快照 turnItemsRef(绑定 convId 防串台)→ chat-done 时 append → 刷新列表;首条 user 自动标题(前 24 字,仅默认「新会话」时);首次启动自动建默认会话并回放。
- @ 引用(P1):输入词首 @ 弹候选(缓存 list),Enter 选整段/点击钻取单条,随 conv_refs 发送;后端 render_conv_refs 注入(每会话最近 8 条、2000 字/条、12000 字预算,message 级放宽到 400 条窗口)。
- 前端坑:setConvId 异步须先同步 convIdRef 再 loadConvs;[] deps 监听器闭包 stale → 用 ref 读最新值。
