use crate::config::LlmConfig;
use crate::db::connection::{ConnectionConfig, DbType};
use crate::db::mysql;
use crate::error::Result;
use crate::llm::client::{stream_chat, ToolCall};
use crate::llm::control::TurnControl;
use crate::llm::KbLoader;
use crate::llm::{AuditEvent, AuditSink};
use crate::llm::memory::SessionMemory;
use crate::llm::planner::{needs_planning, plan_task};
use crate::llm::policy::{check_statement, PolicyDecision};
use crate::llm::tools::{build_registry, ToolContext, ToolRegistry};
use crate::llm::worker::{classify_step, WorkerKind};
use crate::mcp::host::McpHostManager;
use crate::model::{
    BackendMsg, ChatMessage, ChatRole, ConfirmRequest, ConversationRef, SqlReference, TokenUsage,
    ToolCallBrief,
};
use futures::future::join_all;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

/// Bound the tool-call round trips so a misbehaving model can't loop forever.
const MAX_TOOL_ITERS: usize = 5;

/// How long a write confirmation waits for the user before it self-refuses.
const CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Upper bound on a single turn's wall-clock time (ADR-AI-4 决策2). A stuck
/// stream or runaway worker drops the future instead of wedging the turn.
const TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// A single agent: owns its tool registry, working memory, and (in the
/// multi-agent topology) a `role`. The chat uses one `Agent` for a simple
/// task; a complex task is handled by an Orchestrator that spawns Explorer /
/// Executor workers — each a fresh `Agent` with its own context window and a
/// role-scoped system prompt.

/// Accumulate token usage across streaming calls; `None` means the provider
/// didn't report usage for that call, so the running total is left unchanged.
fn add_usage(a: TokenUsage, b: Option<TokenUsage>) -> TokenUsage {
    match b {
        Some(b) => TokenUsage {
            prompt_tokens: a.prompt_tokens + b.prompt_tokens,
            completion_tokens: a.completion_tokens + b.completion_tokens,
            total_tokens: a.total_tokens + b.total_tokens,
        },
        None => a,
    }
}
pub struct Agent {
    cfg: LlmConfig,
    conns: Vec<ConnectionConfig>,
    mcp: Option<Arc<McpHostManager>>,
    registry: ToolRegistry,
    memory: SessionMemory,
    role: WorkerKind,
    /// Side channel for cancellation and write-confirmation (ADR-AI-4).
    /// Shared by the orchestrator and every worker it spawns, so cancelling
    /// the turn stops the whole tree.
    ctl: TurnControl,
    /// Injected knowledge-base loader (ADR-AI-6). Lets the agent read docs
    /// bound to the active connection/db without depending on the store.
    kb: KbLoader,
    /// Audit sink for write-operation guardrail events (ADR-AI-1 决策3).
    audit: AuditSink,
    /// Cumulative token usage for the turn (ADR-AI-4 决策3).
    usage: TokenUsage,
}

impl Agent {
    /// Build the default (single-agent / Orchestrator) agent for a turn.
    pub async fn build(
        cfg: LlmConfig,
        conns: Vec<ConnectionConfig>,
        mcp: Option<Arc<McpHostManager>>,
        conn_id: &str,
        ctl: TurnControl,
        kb: KbLoader,
        audit: AuditSink,
    ) -> Self {
        let registry = build_registry(mcp.as_deref()).await;
        let memory = SessionMemory::new(Some(conn_id.to_string()), None);
        Self {
            cfg,
            conns,
            mcp,
            registry,
            memory,
            role: WorkerKind::Orchestrator,
            ctl,
            kb,
            audit,
            usage: TokenUsage::default(),
        }
    }

    /// Build a delegated worker with a specific role. It gets its own registry
    /// (a scoped subset in future) and a fresh working memory, so its tool
    /// output never bleeds into the Orchestrator's context. The control plane
    /// is *shared* — one cancel stops every worker.
    pub async fn build_worker(
        role: WorkerKind,
        cfg: LlmConfig,
        conns: Vec<ConnectionConfig>,
        mcp: Option<Arc<McpHostManager>>,
        conn_id: &str,
        ctl: TurnControl,
        kb: KbLoader,
        audit: AuditSink,
    ) -> Self {
        let registry = build_registry(mcp.as_deref()).await;
        let memory = SessionMemory::new(Some(conn_id.to_string()), None);
        Self {
            cfg,
            conns,
            mcp,
            registry,
            memory,
            role,
            ctl,
            kb,
            audit,
            usage: TokenUsage::default(),
        }
    }

    pub async fn run(
        &mut self,
        history: &[ChatMessage],
        refs: &[SqlReference],
        conv_ctx: Option<&str>,
        tx: &UnboundedSender<BackendMsg>,
    ) -> Result<()> {
        // 复杂度路由：复杂任务走多智能体（Orchestrator 规划 → 委派 Worker →
        // 综合）；简单任务零额外开销，直接单 ReAct 循环。
        let last_user = history
            .iter()
            .rev()
            .find(|m| m.role == ChatRole::User)
            .map(|m| m.content.clone())
            .unwrap_or_default();

        // Editor SQL the user attached to this turn, plus the cross-conversation
        // background block (@-mentions). Rendered once and folded into the
        // *last user message* rather than the system prompt: they are per-turn
        // evidence, and recency is what keeps the model from reasoning about
        // SQL that scrolled out of the conversation.
        let refs_block = render_refs(refs, &self.conns);
        let block = merge_blocks(refs_block.as_deref(), conv_ctx);
        // The planning heuristic sees the user's own words only — a 40-line
        // pasted statement would otherwise make "解释这段 SQL" look like a
        // multi-step research task and buy the user a needless plan + workers.
        let planning_seed = last_user.clone();
        let last_user = prepend_refs(&last_user, block.as_deref());

        if !needs_planning(&planning_seed, history.len()) {
            let system = build_system_prompt(&self.conns, &self.memory, None, &self.kb).await;
            let mut messages = Vec::new();
            if !system.is_empty() {
                messages.push(ChatMessage::system(system));
            }
            messages.extend(history.iter().cloned());
            attach_refs_to_last_user(&mut messages, block.as_deref());
            self.react(messages, tx).await?;
            return Ok(());
        }

        // 复杂任务：先规划（失败则安全降级为直接 ReAct）。规划输入带上引用的
        // SQL——否则「优化这段 SQL」只能规划出空泛步骤。
        let plan: Vec<String> = match plan_task(&self.cfg, &last_user, &self.conns, &self.memory).await {
            Ok(steps) if !steps.is_empty() => steps,
            _ => {
                let system = build_system_prompt(&self.conns, &self.memory, None, &self.kb).await;
                let mut messages = Vec::new();
                if !system.is_empty() {
                    messages.push(ChatMessage::system(system));
                }
                messages.extend(history.iter().cloned());
                attach_refs_to_last_user(&mut messages, block.as_deref());
                self.react(messages, tx).await?;
                return Ok(());
            }
        };

        // The plan travels as its own structured event, not as prose in the
        // token stream — the UI renders it as a distinct card so it reads as
        // "what I'm about to do", not as part of the answer.
        let _ = tx.send(BackendMsg::ChatPlan(plan.clone()));

        // 逐步委派给对应角色的 Worker。串行执行：计划步骤之间通常存在依赖，
        // 且串行能稳定控制延迟与成本（后续可升级为可并行步骤的并发调度）。
        let conn_id = self.memory.current_conn.clone().unwrap_or_default();
        let mut shared_context = String::new();
        for (idx, step) in plan.iter().enumerate() {
            if self.ctl.is_cancelled() {
                return Ok(());
            }
            let role = classify_step(step);
            let _ = tx.send(BackendMsg::ChatToken(format!(
                "\n— 步骤 {}：{}\n",
                idx + 1,
                step
            )));
            let mut worker = Agent::build_worker(
                role,
                self.cfg.clone(),
                self.conns.clone(),
                self.mcp.clone(),
                &conn_id,
                self.ctl.clone(),
                self.kb.clone(),
                self.audit.clone(),
            )
            .await;
            let wsys = build_worker_system(role, &self.conns, &self.memory, &plan, idx + 1, step, &shared_context, &self.kb).await;
            let mut wmsg = Vec::new();
            if !wsys.is_empty() {
                wmsg.push(ChatMessage::system(wsys));
            }
            wmsg.push(ChatMessage::user(&last_user));
            if let Some(result) = worker.react(wmsg, tx).await? {
                shared_context.push_str(&format!(
                    "步骤 {}（{}）：{}\n\n",
                    idx + 1,
                    role.label(),
                    result
                ));
                let note: String = result.chars().take(80).collect();
                self.memory.note_result(&format!("{}: {}", role.label(), note));
            }
        }

        if self.ctl.is_cancelled() {
            return Ok(());
        }
        // Orchestrator 综合所有 Worker 的结果，给用户一个面向结论的回答。
        if let Some(u) = self.synthesize(&last_user, &plan, &shared_context, tx).await? {
            self.usage = add_usage(self.usage, Some(u));
        }
        Ok(())
    }

    /// Generic ReAct loop. Given messages that already include the system
    /// prompt and any history/tool results, stream LLM turns until the model
    /// stops calling tools. Returns the final assistant text (used by the
    /// Orchestrator to collect worker output).
    async fn react(
        &mut self,
        mut messages: Vec<ChatMessage>,
        tx: &UnboundedSender<BackendMsg>,
    ) -> Result<Option<String>> {
        let mut last_assistant: Option<String> = None;
        // Tag a worker's first streamed token with its role so the transcript
        // shows who is talking (the Orchestrator's own text stays untagged).
        let mut tagged = false;
        let role = self.role;
        let ctl = self.ctl.clone();

        for _ in 0..MAX_TOOL_ITERS {
            if ctl.is_cancelled() {
                break;
            }
            // `select!` borrows its arms for the whole statement, so the
            // schema vec and the delta sink need real bindings (not temporaries).
            let schemas = self.registry.schemas();
            let mut on_delta = |d: &str| {
                if role != WorkerKind::Orchestrator && !tagged {
                    let _ = tx.send(BackendMsg::ChatToken(format!("[{}] {}", role.label(), d)));
                    tagged = true;
                } else {
                    let _ = tx.send(BackendMsg::ChatToken(d.to_string()));
                }
            };
            // Race the stream against cancellation: dropping the `stream_chat`
            // future tears down the HTTP body reader, so a cancel lands within
            // one chunk instead of one full completion.
            let choice = tokio::select! {
                biased;
                _ = ctl.cancelled() => break,
                r = stream_chat(&self.cfg, &messages, &schemas, &mut on_delta) => r?,
            };
            self.usage = add_usage(self.usage, choice.usage);

            if choice.tool_calls.is_empty() {
                if !choice.content.trim().is_empty() {
                    last_assistant = Some(choice.content.clone());
                    messages.push(ChatMessage::assistant(choice.content.clone()));
                }
                break;
            }

            // Persist the assistant message carrying tool calls (required for the API round-trip).
            let tcs: Vec<ToolCallBrief> = choice
                .tool_calls
                .iter()
                .map(|t| ToolCallBrief {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    arguments: t.arguments.clone(),
                })
                .collect();
            messages.push(ChatMessage {
                role: ChatRole::Assistant,
                content: choice.content.clone(),
                tool_calls: Some(tcs),
                tool_call_id: None,
            });

            // Execute tool calls in parallel; the policy gate runs per-call
            // before any DB hit (so destructive SQL is refused without touching
            // the server).
            let ctx = ToolContext {
                conns: &self.conns,
                mcp: self.mcp.as_deref(),
                kb_loader: self.kb.clone(),
            };
            let mut futures = Vec::new();
            for tc in &choice.tool_calls {
                futures.push(exec_with_policy(
                    tc,
                    &self.registry,
                    &ctx,
                    &self.conns,
                    &ctl,
                    &self.audit,
                    tx,
                ));
            }
            let results = join_all(futures).await;
            for (tc, (summary, detail)) in choice.tool_calls.iter().zip(results.into_iter()) {
                let _ = tx.send(BackendMsg::ChatTool(format!("{} → {}", tc.name, summary)));
                messages.push(ChatMessage {
                    role: ChatRole::Tool,
                    content: detail,
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                });
                self.memory.note_result(&summary);
            }
        }

        Ok(last_assistant)
    }

    /// Orchestrator-only step: write a user-facing synthesis from the worker
    /// results. One extra tool-free LLM call — the cost of turning raw query
    /// dumps into a coherent answer.
    async fn synthesize(
        &self,
        user_query: &str,
        plan: &[String],
        shared_context: &str,
        tx: &UnboundedSender<BackendMsg>,
    ) -> Result<Option<TokenUsage>> {
        let _ = tx.send(BackendMsg::ChatToken("\n📊 综合结论：\n".to_string()));
        let mut p = String::new();
        p.push_str("你是 Orchestrator。多个 Worker 已经按计划完成了任务，下面是它们各自产出的结果。\n");
        p.push_str("\n## 执行计划：\n");
        for (i, s) in plan.iter().enumerate() {
            p.push_str(&format!("{}. {}\n", i + 1, s));
        }
        p.push_str(&format!("\n## 用户原始问题：\n{}\n", user_query));
        p.push_str(&format!("\n## Worker 产出结果：\n{}\n", shared_context));
        p.push_str(
            "\n请综合以上结果，用中文给用户一个清晰、面向结论的回答。说明关键发现、数据规模、\
             以及任何需要注意的点。不要重复完整 SQL，除非对结论必要。\n",
        );
        let messages = vec![ChatMessage::system(p)];
        let mut on_delta = |d: &str| {
            let _ = tx.send(BackendMsg::ChatToken(d.to_string()));
        };
        let choice = tokio::select! {
            biased;
            _ = self.ctl.cancelled() => return Ok(None),
            r = stream_chat(&self.cfg, &messages, &[], &mut on_delta) => r?,
        };
        let _ = tx.send(BackendMsg::ChatToken("\n".to_string()));
        Ok(choice.usage)
    }
}

/// Cap the SQL carried by a single reference. A runaway document (someone
/// referencing a 5000-line migration file) would otherwise blow the context
/// window and the token bill; truncating degrades the answer, dropping the
/// turn breaks it.
const MAX_REF_SQL_CHARS: usize = 8000;

/// Render attached editor SQL as one context block, resolving each reference's
/// connection id to a human name so the model can say (and use) "跑在 prod-1 /
/// orders 上" without another lookup.
///
/// Returns `None` when there is nothing to attach — callers then skip injection
/// entirely, keeping the zero-reference path byte-identical to before.
fn render_refs(refs: &[SqlReference], conns: &[ConnectionConfig]) -> Option<String> {
    if refs.is_empty() {
        return None;
    }
    let mut p = String::from(
        "[用户引用的 SQL]\n以下 SQL 来自用户的查询编辑器，是本次提问的对象。\
         若需要执行，请使用每段标注的连接与库（以引用为准，不要改用其他连接）。\n",
    );
    for (i, r) in refs.iter().enumerate() {
        let conn_name = conns
            .iter()
            .find(|c| c.id == r.conn_id)
            .map(|c| c.name.as_str())
            .unwrap_or("未知连接");
        let scope = match r.scope.as_str() {
            "statement" => "单条语句",
            "full" => "整个查询",
            _ => "片段",
        };
        let db = r.db.as_deref().unwrap_or("默认库");
        p.push_str(&format!(
            "\n引用 {} · 连接：{} · 库：{} · 范围：{}\n```sql\n",
            i + 1,
            conn_name,
            db,
            scope
        ));
        if r.sql.chars().count() > MAX_REF_SQL_CHARS {
            let head: String = r.sql.chars().take(MAX_REF_SQL_CHARS).collect();
            p.push_str(&head);
            p.push_str("\n-- …（引用过长已截断）\n");
        } else {
            p.push_str(&r.sql);
            p.push('\n');
        }
        p.push_str("```\n");
    }
    Some(p)
}

/// Put the reference block in front of the user's own words.
fn prepend_refs(text: &str, block: Option<&str>) -> String {
    match block {
        Some(b) => format!("{}\n{}", b, text),
        None => text.to_string(),
    }
}

/// Concatenate the editor-SQL block and the cross-conversation block into one
/// per-turn attachment (docs/chat-conversation-design.md §6.2: the two share
/// the injection point, each `None` degrades to the other).
fn merge_blocks(a: Option<&str>, b: Option<&str>) -> Option<String> {
    match (a, b) {
        (Some(x), Some(y)) => Some(format!("{}\n{}", x, y)),
        (Some(x), None) => Some(x.to_string()),
        (None, Some(y)) => Some(y.to_string()),
        (None, None) => None,
    }
}

/// Render cross-conversation references (@-mentions) into one background
/// context block (docs/chat-conversation-design.md §6.2).
///
/// `load` is provided by the command layer: given a reference it returns the
/// target conversation's title and trailing messages as (role, content) pairs,
/// ascending by seq. Rendering here — not in the command layer — keeps the
/// truncation budget in one testable place.
///
/// Budget (per design): 8 user/assistant messages per conversation, 2000 chars
/// per message, 12000 chars total; overruns are truncated, never dropped.
/// Returns `None` when nothing can be injected (no refs, empty targets).
pub fn render_conv_refs(
    conv_refs: &[ConversationRef],
    mut load: impl FnMut(&ConversationRef) -> Option<(String, Vec<(String, String)>)>,
) -> Option<String> {
    const PER_CONV_MSGS: usize = 8;
    const PER_MSG_CHARS: usize = 2000;
    const TOTAL_CHARS: usize = 12000;
    if conv_refs.is_empty() {
        return None;
    }
    let mut p = String::new();
    for r in conv_refs {
        let Some((title, pairs)) = load(r) else { continue };
        // Keep only user/assistant, the most recent PER_CONV_MSGS, chronologically.
        let msgs: Vec<(String, String)> = pairs
            .into_iter()
            .filter(|(role, _)| role == "user" || role == "assistant")
            .rev()
            .take(PER_CONV_MSGS)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if msgs.is_empty() {
            continue;
        }
        let header = if r.scope == "message" {
            format!(
                "[引用自会话「{}」的一条消息]\n以下内容来自另一会话，仅作背景参考（数据可能已变化）：\n",
                title
            )
        } else {
            format!(
                "[引用的历史会话「{}」]\n以下内容来自另一会话，仅作背景参考（数据可能已变化）：\n",
                title
            )
        };
        p.push_str(&header);
        for (role, content) in &msgs {
            let label = if role == "user" { "用户" } else { "AI" };
            let trimmed: String = content.chars().take(PER_MSG_CHARS).collect();
            p.push_str(&format!("- {}：{}\n", label, trimmed));
        }
    }
    if p.is_empty() {
        return None;
    }
    Some(p.chars().take(TOTAL_CHARS).collect())
}

/// Fold the reference block into the most recent user message of an
/// already-assembled request. Mutating the copy (not the stored history) keeps
/// references strictly per-turn.
fn attach_refs_to_last_user(messages: &mut [ChatMessage], block: Option<&str>) {
    let Some(b) = block else { return };
    if let Some(m) = messages.iter_mut().rev().find(|m| m.role == ChatRole::User) {
        m.content = format!("{}\n{}", b, m.content);
    }
}

/// Run a full LLM turn using a freshly-built orchestrator agent. Kept as the
/// command entry point so `chat_turn` doesn't need to know about `Agent`.
///
/// `ctl` is the turn's control plane: the caller keeps a clone so it can
/// cancel the turn or answer a write-confirmation while this future runs.
///
/// `refs` is SQL the user attached from the editor for *this* turn; pass an
/// empty slice for hosts that have no editor (the TUI).
///
/// `conv_ctx` is the rendered cross-conversation background block (@-mentions,
/// docs/chat-conversation-design.md §6.2); `None` when nothing was referenced.
pub async fn run_turn(
    cfg: &LlmConfig,
    conns: Vec<ConnectionConfig>,
    mcp: Option<Arc<McpHostManager>>,
    history: &[ChatMessage],
    refs: &[SqlReference],
    conv_ctx: Option<String>,
    conn_id: &str,
    tx: &UnboundedSender<BackendMsg>,
    ctl: TurnControl,
    kb: KbLoader,
    audit: AuditSink,
) -> Result<()> {
    let mut agent = Agent::build(cfg.clone(), conns, mcp, conn_id, ctl.clone(), kb, audit).await;
    // ADR-AI-4 决策2: bound a single turn's wall-clock time so a stuck stream
    // or runaway worker can't wedge the turn (and its registry slot) forever.
    let result = tokio::time::timeout(TURN_TIMEOUT, agent.run(history, refs, conv_ctx.as_deref(), tx)).await;
    match result {
        Ok(out) => {
            out?;
            let _ = tx.send(BackendMsg::ChatUsage(agent.usage));
            if ctl.is_cancelled() {
                let _ = tx.send(BackendMsg::ChatToken("\n⏹ 已取消。\n".to_string()));
            }
        }
        Err(_) => {
            ctl.cancel();
            let _ = tx.send(BackendMsg::ChatToken(
                "\n⏱ 单轮已超出时间上限，已停止。\n".to_string(),
            ));
        }
    }
    Ok(())
}

/// Connection / active-db context block. Shared by the Orchestrator prompt and
/// every worker prompt so they all see the same ground truth without
/// duplicating the schema fetch.
async fn context_block(
    conns: &[ConnectionConfig],
    memory: &SessionMemory,
    kb: &KbLoader,
) -> String {
    let mut p = String::new();
    p.push_str("可用连接：\n");
    for c in conns {
        let kind = match c.db_type {
            DbType::Mysql => "MySQL",
            DbType::Redis => "Redis",
        };
        p.push_str(&format!("- {} ({})\n", c.name, kind));
    }
    if let Some(conn_id) = &memory.current_conn {
        if let Some(cfg) = conns.iter().find(|c| &c.id == conn_id) {
            let kind = match cfg.db_type {
                DbType::Mysql => "MySQL",
                DbType::Redis => "Redis",
            };
            p.push_str(&format!("\n当前连接：{} ({})\n", cfg.name, kind));
            if cfg.db_type == DbType::Mysql {
                let db = if cfg.database.is_empty() {
                    "mysql"
                } else {
                    &cfg.database
                };
                if let Ok(tables) = mysql::search_tables(cfg, db, None, 100).await {
                    if !tables.is_empty() {
                        p.push_str(&format!("该库（{}）中的部分表（最多 100 张）：\n", db));
                        for t in &tables {
                            p.push_str(&format!(
                                "- {}{}\n",
                                t.name,
                                if t.is_view { " [视图]" } else { "" }
                            ));
                        }
                    }
                }
            }
        }
        // ADR-AI-6: inject knowledge-base docs bound to the active connection/db.
        let db = memory
            .current_db
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                conns
                    .iter()
                    .find(|c| &c.id == conn_id)
                    .and_then(|c| {
                        if c.database.is_empty() {
                            None
                        } else {
                            Some(c.database.clone())
                        }
                    })
            });
        let docs = kb(conn_id, db.as_deref());
        if !docs.is_empty() {
            p.push_str("\n## 知识库（已绑定当前连接/库，辅助理解业务口径）：\n");
            let mut total = 0usize;
            const PER_DOC: usize = 2000;
            const TOTAL_CAP: usize = 6000;
            for (name, content) in &docs {
                if total >= TOTAL_CAP {
                    break;
                }
                let take: String = content.chars().take(PER_DOC).collect();
                total += take.chars().count();
                p.push_str(&format!("- 文档「{}」：{}\n", name, take));
            }
            if total >= TOTAL_CAP {
                p.push_str("(知识库较大，仅注入部分；需要更多片段可用 search_knowledge 工具检索)\n");
            }
        }
    }
    p
}

/// Construct the system prompt with current connection/db context (ADR-AI-2).
/// Lists up to 100 tables of the active DB so the model has real schema
/// awareness without dumping an 8000-table schema.
async fn build_system_prompt(
    conns: &[ConnectionConfig],
    memory: &SessionMemory,
    plan: Option<&[String]>,
    kb: &KbLoader,
) -> String {
    let mut p = context_block(conns, memory, kb).await;
    p.push_str(
        "\n规则：\n\
         - 只使用 execute_query 工具，并指定已知连接名。\n\
         - 优先只读查询；不要臆造表名或列名。\n\
         - 当前库若绑定了知识库，相关内容已包含在上方上下文中；如需更具体的片段，可用 search_knowledge 工具按关键词检索。\n\
         - 写操作（INSERT/UPDATE/DELETE/REPLACE）会先弹窗请用户确认，确认后才真正执行；\
         写之前请先用只读查询确认影响范围，并且必须带精确的 WHERE 条件。\n\
         - DDL 与破坏性语句（DROP/TRUNCATE/ALTER/CREATE 等）一律被护栏拦截，请告知用户手动执行。\n",
    );
    if let Some(steps) = plan {
        p.push_str("\n## 本次执行计划（必须严格按以下步骤顺序执行，不要偏离或跳步）：\n");
        for (i, s) in steps.iter().enumerate() {
            p.push_str(&format!("{}. {}\n", i + 1, s));
        }
    }
    p
}

/// Build a role-scoped system prompt for a delegated worker.
async fn build_worker_system(
    role: WorkerKind,
    conns: &[ConnectionConfig],
    memory: &SessionMemory,
    plan: &[String],
    step_idx: usize,
    step: &str,
    shared_context: &str,
    kb: &KbLoader,
) -> String {
    let mut p = String::new();
    p.push_str(role.system_prefix());
    p.push_str(&context_block(conns, memory, kb).await);
    p.push_str("\n## 本次任务计划（全局目标）：\n");
    for (i, s) in plan.iter().enumerate() {
        let mark = if i + 1 == step_idx { " ← 你负责这一步" } else { "" };
        p.push_str(&format!("{}. {}{}\n", i + 1, s, mark));
    }
    p.push_str(&format!("\n## 你负责的第 {} 步：\n{}\n", step_idx, step));
    if !shared_context.is_empty() {
        p.push_str(&format!(
            "\n## 前序步骤的结果（供你参考，步骤间可能有依赖）：\n{}\n",
            shared_context
        ));
    }
    p.push_str(
        "\n规则：只使用 execute_query 工具；优先只读查询；不要臆造表名或列名；\
         当前库若绑定了知识库，相关内容已包含在上下文里，需要更具体的片段可用 search_knowledge 检索；\
         写操作会先请用户确认（写前先查清影响范围并带精确 WHERE）；\
         DDL 与破坏性语句会被护栏拦截，请告知用户手动执行。\n",
    );
    p
}

/// Execute a tool call, running the safety guardrail first for `execute_query`
/// on MySQL: read-only runs straight through, DDL / destructive statements are
/// hard-denied, and writes pause here until the user answers the confirmation
/// prompt the UI raised.
///
/// A rejection is fed back to the model as a *tool result*, not an error — the
/// model needs to see "the user said no" so it can explain itself instead of
/// blindly retrying.
async fn exec_with_policy(
    tc: &ToolCall,
    reg: &ToolRegistry,
    ctx: &ToolContext<'_>,
    conns: &[ConnectionConfig],
    ctl: &TurnControl,
    audit: &AuditSink,
    tx: &UnboundedSender<BackendMsg>,
) -> (String, String) {
    if tc.name == "execute_query" {
        let args: Value = serde_json::from_str(&tc.arguments).unwrap_or(Value::Null);
        let conn_name = args
            .get("connection")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(cfg) = conns.iter().find(|c| c.name == conn_name) {
            if cfg.db_type == DbType::Mysql {
                // Build a reusable audit emitter so every guardrail decision
                // (deny / approve / reject / expire) lands in the same store.
                let conn_id = cfg.id.clone();
                let db = args.get("db").and_then(|v| v.as_str()).map(|s| s.to_string());
                let emit = |decision: &'static str| {
                    audit(&AuditEvent {
                        conn_id: conn_id.clone(),
                        conn_name: conn_name.to_string(),
                        db: db.clone(),
                        sql: query.to_string(),
                        decision,
                    });
                };
                match check_statement(query) {
                    PolicyDecision::Allow => {}
                    PolicyDecision::Deny(reason) => {
                        emit("deny");
                        return ("已拦截".into(), format!("AI 护栏拒绝执行：{}", reason));
                    }
                    PolicyDecision::ConfirmRequired(reason) => {
                        if ctl.is_cancelled() {
                            return ("已取消".into(), "会话已取消，未执行。".into());
                        }
                        let (id, rx) = ctl.register_confirm();
                        let _ = tx.send(BackendMsg::ChatConfirm(ConfirmRequest {
                            id,
                            turn_id: ctl.turn_id().to_string(),
                            connection: conn_name.to_string(),
                            sql: query.to_string(),
                            reason,
                        }));
                        // Bounded wait. If the webview reloads (or the user
                        // walks away) nobody will ever answer, and an
                        // unbounded await would wedge the turn — and its entry
                        // in the turn registry — forever. Timing out reads as
                        // a refusal, which is the safe default.
                        let answer = tokio::time::timeout(CONFIRM_TIMEOUT, rx).await;
                        match answer.unwrap_or(Ok(false)) {
                            Ok(true) => {
                                emit("write-approved");
                                let _ = tx.send(BackendMsg::ChatTool(
                                    "写操作已获用户确认，正在执行".to_string(),
                                ));
                            }
                            Ok(false) => {
                                emit("write-rejected");
                                return (
                                    "用户拒绝".into(),
                                    "用户拒绝执行这条写操作。不要重试，也不要改写后再次尝试；\
                                     请向用户说明影响，并给出可供其手动执行的 SQL。"
                                        .into(),
                                );
                            }
                            Err(_) => {
                                emit("write-expired");
                                return (
                                    "确认失效".into(),
                                    "确认请求未获响应（会话已结束、被取消或超时），语句未执行。".into(),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    reg.call(tc, ctx).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(scope: &str, sql: &str) -> SqlReference {
        SqlReference {
            conn_id: "c1".into(),
            tab_id: None,
            db: Some("shop".into()),
            scope: scope.into(),
            sql: sql.into(),
        }
    }

    /// No references must leave the prompt byte-identical to the old path —
    /// this is what makes the feature free for everyone who doesn't use it.
    #[test]
    fn no_refs_is_a_no_op() {
        assert!(render_refs(&[], &[]).is_none());
        assert_eq!(prepend_refs("hi", None), "hi");
        let mut msgs = vec![ChatMessage::user("hi")];
        attach_refs_to_last_user(&mut msgs, None);
        assert_eq!(msgs[0].content, "hi");
    }

    #[test]
    fn renders_provenance_and_sql() {
        let block = render_refs(&[r("statement", "SELECT 1")], &[]).unwrap();
        assert!(block.contains("单条语句"));
        assert!(block.contains("库：shop"));
        assert!(block.contains("SELECT 1"));
        // An unresolvable connection degrades instead of panicking.
        assert!(block.contains("未知连接"));
    }

    #[test]
    fn unknown_scope_degrades() {
        let block = render_refs(&[r("weird", "SELECT 1")], &[]).unwrap();
        assert!(block.contains("片段"));
    }

    /// Oversized SQL is truncated, never dropped: a partial statement still
    /// answers "what is this query doing", a missing one answers nothing.
    #[test]
    fn oversized_sql_is_truncated() {
        let huge = "x".repeat(MAX_REF_SQL_CHARS + 500);
        let block = render_refs(&[r("full", &huge)], &[]).unwrap();
        assert!(block.contains("引用过长已截断"));
        assert!(block.len() < huge.len() + 500);
    }

    /// The block lands on the LAST user message — recency is the point.
    #[test]
    fn attaches_to_last_user_message() {
        let mut msgs = vec![
            ChatMessage::user("第一问"),
            ChatMessage::assistant("答"),
            ChatMessage::user("第二问"),
        ];
        attach_refs_to_last_user(&mut msgs, Some("[BLOCK]"));
        assert_eq!(msgs[0].content, "第一问");
        assert!(msgs[2].content.starts_with("[BLOCK]"));
        assert!(msgs[2].content.contains("第二问"));
    }

    fn conv(scope: &str, conv_id: &str) -> ConversationRef {
        ConversationRef {
            conv_id: conv_id.into(),
            scope: scope.into(),
            message_id: None,
        }
    }

    /// A loader that synthesizes a conversation with the given message pairs.
    fn pairs(msgs: &[(&str, &str)]) -> Vec<(String, String)> {
        msgs.iter()
            .map(|(r, c)| (r.to_string(), c.to_string()))
            .collect()
    }

    fn fake_load(
        conv_id: &str,
        msg_pairs: Vec<(String, String)>,
    ) -> Box<dyn FnMut(&ConversationRef) -> Option<(String, Vec<(String, String)>)> + '_> {
        let id = conv_id.to_string();
        Box::new(move |r: &ConversationRef| {
            if r.conv_id == id {
                Some(("订单会话".to_string(), msg_pairs.clone()))
            } else {
                None
            }
        })
    }

    /// No references ⇒ None; unknown conversation ⇒ skipped; a referenced
    /// conversation with no user/assistant messages ⇒ skipped.
    #[test]
    fn conv_refs_no_op_when_empty_or_unresolvable() {
        assert!(render_conv_refs(&[], fake_load("a", vec![])).is_none());
        let mut load = fake_load("a", pairs(&[("tool", "SELECT 1")]));
        assert!(render_conv_refs(&[conv("session", "a")], &mut load).is_none());
        let mut load = fake_load("a", pairs(&[("user", "hi")]));
        assert!(render_conv_refs(&[conv("session", "ghost")], &mut load).is_none());
    }

    /// Filters to user/assistant, keeps the most recent 8, renders the
    /// "数据可能已变化" disclaimer and the title.
    #[test]
    fn conv_refs_formats_and_filters() {
        let mut load = fake_load(
            "a",
            pairs(&[
                ("user", "订单问题"),
                ("assistant", "我先查一下"),
                ("tool", "不要出现"),
                ("assistant", "结论：库存不足"),
                ("user", "那怎么办"),
                ("assistant", "补货"),
            ]),
        );
        let block = render_conv_refs(&[conv("session", "a")], &mut load).unwrap();
        assert!(block.contains("引用的历史会话「订单会话」"));
        assert!(block.contains("数据可能已变化"));
        assert!(block.contains("- 用户：订单问题"));
        assert!(block.contains("- AI：结论：库存不足"));
        assert!(!block.contains("不要出现"));
    }

    /// More than 8 user/assistant messages: only the last 8 survive, in order.
    #[test]
    fn conv_refs_keeps_last_eight_in_order() {
        let mut msgs: Vec<(String, String)> = (1..=10)
            .map(|i| ("user".to_string(), format!("问题{i}")))
            .collect();
        msgs.push(("assistant".to_string(), "总结".to_string()));
        let mut load = fake_load("a", msgs);
        let block = render_conv_refs(&[conv("session", "a")], &mut load).unwrap();
        // Only the last 8 survive (4..=10 + 总结). Note: bare "问题1" would
        // match "问题10" — anchor on the trailing newline instead.
        assert!(!block.contains("问题1\n"));
        assert!(!block.contains("问题2\n"));
        assert!(!block.contains("问题3\n"));
        assert!(block.contains("问题4\n"));
        assert!(block.contains("问题10\n"));
        // Chronological: 问题4 appears before 问题10.
        assert!(block.find("问题4").unwrap() < block.find("问题10").unwrap());
    }

    /// Per-message truncation (2000 chars) and total budget (12000 chars).
    #[test]
    fn conv_refs_budget_truncates() {
        let long = "长".repeat(3000);
        let mut load = fake_load("a", pairs(&[("assistant", &long)]));
        let block = render_conv_refs(&[conv("session", "a")], &mut load).unwrap();
        assert!(block.chars().count() <= 12000);
        // The 3000-char message was cut to 2000 inside the block.
        assert!(block.contains(&"长".repeat(2000)));
        assert!(!block.contains(&"长".repeat(2001)));
    }

    /// Editor-SQL block and conversation block coexist through merge_blocks.
    #[test]
    fn merge_blocks_combines_or_degrades() {
        assert_eq!(merge_blocks(None, None), None);
        assert_eq!(merge_blocks(Some("A"), None).as_deref(), Some("A"));
        assert_eq!(merge_blocks(None, Some("B")).as_deref(), Some("B"));
        let merged = merge_blocks(Some("A"), Some("B")).unwrap();
        assert!(merged.starts_with("A"));
        assert!(merged.contains("B"));
    }
}
