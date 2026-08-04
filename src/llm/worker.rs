//! Worker roles for the multi-agent (Path C) topology.
//!
//! An Orchestrator plans a complex task, then delegates each plan step to a
//! *worker* — a narrowly-scoped agent carrying a role-specific system prompt
//! and (in future) a scoped tool subset. Each worker runs its own ReAct loop
//! in an isolated context window, so a long multi-step task never pollutes a
//! single conversation with thousands of tokens of intermediate tool output.
//!
//! Today both worker roles share the same tool set; the only difference is the
//! system prompt's framing and the emitted `[Explorer]` / `[Executor]` label
//! the UI shows. The registry split is deliberately wired but left open for
//! when we add write/optimize tools that only some roles should hold.

/// The role an `Agent` plays in a turn.
///
/// `Orchestrator` is the default (single-agent) role; `Explorer` and
/// `Executor` are the delegated workers spun up by a complex-task turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerKind {
    Orchestrator,
    Explorer,
    Executor,
}

impl WorkerKind {
    /// Short label shown to the user in streamed output, e.g. `[Explorer]`.
    pub fn label(&self) -> &'static str {
        match self {
            WorkerKind::Orchestrator => "Orchestrator",
            WorkerKind::Explorer => "Explorer",
            WorkerKind::Executor => "Executor",
        }
    }

    /// Role-specific prefix appended to the shared system prompt. Empty for the
    /// Orchestrator because it uses the standard single-agent prompt.
    pub fn system_prefix(&self) -> &'static str {
        match self {
            WorkerKind::Orchestrator => "",
            WorkerKind::Explorer => "\
你是本次任务的「探索者」(Explorer)。你的职责是只读地摸清数据库结构和数据规模：\
列出表、查看表结构、采样少量数据、统计行数。不要做写操作或破坏性操作。\
优先用 SHOW / SELECT 探查，把关键发现讲清楚，供执行者使用。\n",
            WorkerKind::Executor => "\
你是本次任务的「执行者」(Executor)。你严格按照 Orchestrator 给定的计划步骤执行查询取数。\
只使用 execute_query 工具；优先只读查询。不要偏离计划，不要臆造表名或列名。\
把查询结果清晰地整理出来。\n",
        }
    }
}

/// Cheap, zero-LLM heuristic: does this plan step need exploration (read-only
/// discovery) or execution (actually fetching/computing the answer)?
///
/// A keyword scan is enough — the two roles currently share the same tools, so
/// a misclassification only changes the framing/label, never correctness. A
/// future upgrade can let the planner emit explicit role tags instead.
pub fn classify_step(step: &str) -> WorkerKind {
    const EXPLORE_WORDS: &[&str] = &[
        "探索", "探查", "了解", "查看", "结构", "规模", "列出", "列举", "采样",
        "确认", "摸清", "有哪些", "是什么", "统计行数", "检查",
    ];
    if EXPLORE_WORDS.iter().any(|w| step.contains(w)) {
        return WorkerKind::Explorer;
    }
    let s = step.to_lowercase();
    if s.contains("show") || s.contains("describe") {
        return WorkerKind::Explorer;
    }
    WorkerKind::Executor
}
