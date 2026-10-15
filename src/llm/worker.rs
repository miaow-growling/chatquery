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

use crate::llm::tools::ToolScope;

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

    /// The capability ceiling for this role. Explorer is read-only because
    /// its whole job is discovery — it must never mutate the database it is
    /// exploring, no matter what the plan asked for.
    pub fn scope(self) -> ToolScope {
        match self {
            WorkerKind::Orchestrator => ToolScope::Full,
            WorkerKind::Explorer => ToolScope::ReadOnly,
            WorkerKind::Executor => ToolScope::Full,
        }
    }

    /// Role-specific prefix appended to the shared system prompt. Empty for the
    /// Orchestrator because it uses the standard single-agent prompt.
    pub fn system_prefix(&self) -> &'static str {
        match self {
            WorkerKind::Orchestrator => "",
            WorkerKind::Explorer => "\
你是本次任务的「探索者」(Explorer)。你的职责是只读地摸清数据库结构和数据规模：\
列出表、查看表结构、采样少量数据、统计行数。\
【硬性限制】你的工具集是只读的——你无法执行任何写操作。若步骤需要修改数据，\
请把该发现作为结论交回，由执行者（Executor）完成，你不要尝试写入。\n",
            WorkerKind::Executor => "\
你是本次任务的「执行者」(Executor)。你严格按照 Orchestrator 给定的计划步骤执行查询取数。\
只使用 execute_query 工具；优先只读查询。不要偏离计划，不要臆造表名或列名。\
把查询结果清晰地整理出来。\n",
        }
    }
}

/// 步骤文本是否包含写意图或破坏性操作意图。
/// 用于防止关键词扫描将写步骤误判为只读 Explorer，导致任务被硬拦截卡死。
pub fn step_looks_mutating(step: &str) -> bool {
    const MUTATING: &[&str] = &[
        "插入", "新增", "写入", "更新", "删除", "清空", "修改", "建表",
        "创建表", "改表", "建索引", "批量写", "导入", "导出到",
        "insert", "update", "delete", "create table", "alter", "drop", "truncate",
    ];
    let lower = step.to_lowercase();
    MUTATING.iter().any(|w| step.contains(w) || lower.contains(w))
}

/// Cheap, zero-LLM heuristic: does this plan step need exploration (read-only
/// discovery) or execution (actually fetching/computing the answer)?
///
/// 具备写意图纠偏：只要步骤包含写操作词汇，一律归为 Executor。
pub fn classify_step(step: &str) -> WorkerKind {
    if step_looks_mutating(step) {
        return WorkerKind::Executor;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_scope_is_read_only_and_executor_is_full() {
        assert_eq!(WorkerKind::Explorer.scope(), ToolScope::ReadOnly);
        assert_eq!(WorkerKind::Executor.scope(), ToolScope::Full);
        assert_eq!(WorkerKind::Orchestrator.scope(), ToolScope::Full);
    }

    #[test]
    fn step_looks_mutating_detects_writes() {
        assert!(step_looks_mutating("往 test 表插入一条记录"));
        assert!(step_looks_mutating("更新用户状态为禁用"));
        assert!(step_looks_mutating("DELETE FROM logs WHERE id > 100"));
        assert!(!step_looks_mutating("查看 test 表结构"));
        assert!(!step_looks_mutating("统计订单表总行数"));
    }

    #[test]
    fn classify_step_respects_mutating_override() {
        // 即便包含"检查"，但如果同时包含"删除"，必须归为 Executor
        assert_eq!(
            classify_step("检查并删除无效测试数据"),
            WorkerKind::Executor
        );
        assert_eq!(
            classify_step("查看用户表字段结构"),
            WorkerKind::Explorer
        );
    }
}
