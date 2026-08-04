# 可观测三件套 — 完成报告

**Commit**：`d2f2e3d` · **状态**：Now 阶段收官，Rust + 前端全链路闭环

按你确认的推进顺序，把 ADR-AI-1 决策3 与 ADR-AI-4 决策2/3 一次做完。三者是同一件事的
三个面：**出了事查得到、跑太久停得下、花了多少看得见**。没有度量，后续所有优化都是猜。

---

## 1. 写操作审计日志（ADR-AI-1 决策3）

AI 每次触碰写语句都留痕，四类判定：

| 判定 | 触发 | 是否触库 |
|------|------|---------|
| `write-approved` | 用户在确认弹窗点执行 | ✅ |
| `write-rejected` | 用户点拒绝 | ❌ |
| `write-expired` | 300s 无人应答 | ❌ |
| `deny` | DDL / 破坏性语句，不弹窗直接拦 | ❌ |

**只读查询不记录**——审计的价值在于稀缺，把 SELECT 也塞进去等于没有审计。

**解耦方式**：llm crate 不认识 store。定义 `AuditSink = Arc<dyn Fn(&AuditEvent)>`，
命令层注入写库闭包，TUI 注入 no-op。和之前 `KbLoader` 同一套路——依赖方向永远朝内，
换存储不动 llm 一行代码。

**查看**：Chat 面板标题栏 🛡 → 弹窗展示最近 200 条。

## 2. 单 turn 总超时（ADR-AI-4 决策2）

`TURN_TIMEOUT = 300s` 包裹整个 turn future。超时即 `cancel()` + 补发提示与 `ChatDone`。

关键在**补发 `ChatDone`**：后端 timeout 却不发完成信号，前端的 `streaming` 就永远是 true，
输入框永久禁用。这类"半死"状态比直接报错更难查。

## 3. Token 用量统计（ADR-AI-4 决策3）

两家厂商的协议差异被藏进两个纯函数（因此可单测）：

- **OpenAI**：末尾单独一个 `usage` chunk，需开 `stream_options.include_usage`
- **Anthropic**：拆散在 `message_start.input_tokens` 和 `message_delta.output_tokens`，得在 SSE 循环里累加

`Agent.usage` 跨 worker 和 synthesize 累加，所以复杂任务显示的是**整棵调用树**的总成本——
这正是多智能体架构的代价，现在它可见了。

前端在输入框上方显示「⚡ 本轮 N tokens（入 X / 出 Y）· 会话累计 N」。
厂商不上报时显示"未上报"而非 `0`——**未知不等于零**，显示 0 会让人误以为这轮免费。

---

## 顺带修掉两个 bug

**① 事件被静默吞掉**：`commands.rs` 的事件桥接 match 有 `_ => {}` 兜底，新增的
`ChatUsage` 变体编译通过但永远不会 emit。兜底分支让编译器的穷尽性检查失效——
它是这类 bug 的温床。已加 arm，并把教训写进项目记忆。

**② 测试 flaky**：`temp_store()` 改的 `XDG_CONFIG_HOME` 是进程级变量，而测试并行跑，
两个测试互相覆盖对方的临时目录，随机打开错误的库。单独跑必过、全量跑偶挂。
拆出 `env_lock()` 串行化——刻意与 `temp_store()` 分离，因为 Mutex 非重入，
同一测试内建第二个 store 会死锁。

这个 bug 早就潜伏着，是新增测试改变了调度时序才把它抖出来。**flaky 不会自愈，只会变隐蔽。**

---

## 验证

| 项 | 结果 |
|---|------|
| `cargo check --lib --no-default-features` | 零错误零警告 |
| `cargo check --manifest-path src-tauri/...` | 零错误 |
| `cargo test --lib --no-default-features` | **38 passed / 0 failed，连跑 5 次稳定** |
| `tsc --noEmit` + `npm run build` | 通过 |

## 文件

**Rust**：`model.rs`（TokenUsage + ChatUsage）、`llm/mod.rs`（AuditSink）、
`llm/client.rs`（usage 提取 ×2 + 3 单测）、`llm/session.rs`（超时 + 累加 + 审计埋点）、
`store/mod.rs`（audit_log 表 + 2 方法 + 1 单测）、`db/connection.rs`、`db/importexport.rs`（flaky 修复）、
`src-tauri/src/commands.rs`（桥接 arm + `list_audit_logs`）、`main.rs` ×2、`tui/app.rs`

**前端**：`types.ts`、`api.ts`、`App.tsx`、`style.css`

**文档**：`ai-feature-plan.md` §5.1 进度更新、`docs/e2e-checklist.md`（新建）

---

## 下一步

1. **照 `docs/e2e-checklist.md` 走一遍**——单测保逻辑，集成靠手跑。我这边没有显示器，
   这步只能你来。清单里标了每项的判定标准和失败排查表。
2. 知识库随连接导出/导入（yaml 目前不含 kb 内容）
3. Next 阶段：跨轮持久化记忆 / worker 工具子集拆分 / worker 并行调度

⚠️ **`list_audit_logs` 是新命令，必须重启 cargo 才注册**，否则前端报 not found。
