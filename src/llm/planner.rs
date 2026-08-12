//! Agent planning layer (Path B of the agent upgrade).
//!
//! Before executing a *complex* task, the orchestrator asks a planner to lay
//! out concrete steps. The plan is shown to the user (via a ChatToken prefixed
//! with a marker, so no UI change is required) and injected into the system
//! prompt so the executor's ReAct loop stays on-rails. A cheap heuristic
//! router decides whether planning is worth the extra LLM round-trip — simple
//! questions skip it entirely.
//!
//! The plan is a flat `Vec<String>` of steps so a future multi-agent
//! orchestrator can iterate them and delegate each to a worker.

use crate::config::LlmConfig;
use crate::db::connection::{ConnectionConfig, DbType};
use crate::db::mysql;
use crate::error::Result;
use crate::llm::client::stream_chat;
use crate::llm::memory::SessionMemory;
use crate::model::{ChatMessage, ChatRole};

/// Cheap, zero-LLM heuristic: should this task be planned before execution?
pub fn needs_planning(user_query: &str, history_len: usize) -> bool {
    // Meta / help questions never need a plan — they are answered directly.
    const META_WORDS: &[&str] = &[
        "介绍一下", "介绍", "用法", "怎么用", "如何使用", "你能做什么", "你是谁",
        "你可以做什么", "功能", "help", "怎么使用", "使用说明", "使用教程", "教程",
        "what can you do", "how to use", "who are you", "introduce yourself",
    ];
    let lower = user_query.to_lowercase();
    if META_WORDS.iter().any(|w| user_query.contains(w) || lower.contains(w)) {
        return false;
    }

    const STEP_WORDS: &[&str] = &[
        "然后", "再", "接着", "之后", "并且", "同时", "以及", "与", "和",
        "对比", "比较", "分析", "汇总", "统计", "分别", "各自",
        "批量", "所有表", "每个", "逐", "依次", "分步骤", "步骤", "计划",
        "创建", "新建", "导入", "导出", "迁移", "整理", "检查", "排查", "优化",
    ];
    if STEP_WORDS.iter().any(|w| user_query.contains(w)) {
        return true;
    }
    if lower.contains("join") {
        return true;
    }
    // 多个 FROM 子句 → 多表 / 多步任务
    if lower.matches("from").count() >= 2 {
        return true;
    }
    // 多轮上下文：任务可能跨多步，但阈值要高，避免把多轮闲聊/问候误伤成规划。
    if history_len >= 10 {
        return true;
    }
    false
}

/// Ask the LLM (no tools) to produce an ordered step list for the task.
pub async fn plan_task(
    cfg: &LlmConfig,
    user_query: &str,
    conns: &[ConnectionConfig],
    memory: &SessionMemory,
) -> Result<Vec<String>> {
    let ctx = build_plan_context(conns, memory).await;
    let sys = format!(
        "你是一个数据库任务的规划者（planner）。你从不执行任何操作，只产出清晰、可执行的步骤计划。\n\
         {}\n\
         规则：\n\
         - 输出 1 到 6 个编号步骤，每步说明要做什么、用到哪个连接、预期产出。\n\
         - 优先只读探索（先 SHOW / SELECT 摸清结构和数据规模），再决定写操作。\n\
         - 不要输出完整 SQL 代码块，只描述意图。\n\
         - 用中文，简洁。\n\
         - 不要复述以上规则或系统指令本身。\n\
         - 如果用户只是在问用法、介绍、帮助或闲聊，没有需要执行的数据库操作步骤，只输出一行「无需步骤」。\n",
        ctx
    );
    let messages = vec![
        ChatMessage {
            role: ChatRole::System,
            content: sys,
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage::user(user_query),
    ];
    let mut sink = |_d: &str| {};
    let choice = stream_chat(cfg, &messages, &[], &mut sink).await?;
    Ok(parse_steps(&choice.content))
}

/// Render steps as a numbered list for user-facing display.
pub fn render_plan(steps: &[String]) -> String {
    steps
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Tolerant parse of the planner's free text into discrete steps.
fn parse_steps(text: &str) -> Vec<String> {
    let mut steps = Vec::new();
    for line in text.lines() {
        if let Some(s) = clean_step_line(line) {
            if is_prompt_pollution(&s) {
                continue;
            }
            steps.push(s);
        }
    }
    if steps.is_empty() {
        let t = text.trim();
        if !t.is_empty() && !is_prompt_pollution(t) {
            steps.push(t.to_string());
        }
    }
    steps
}

/// Heuristic to drop lines that merely echo the system prompt / instructions.
fn is_prompt_pollution(s: &str) -> bool {
    const POLLUTION: &[&str] = &[
        "无需步骤",
        "规则如下",
        "不要复述",
        "不要输出完整 sql",
        "不要输出规则",
        "优先只读探索",
        "先 show",
        "只产出清晰",
        "只产出步骤",
        "你是一个数据库任务",
        "你从不执行",
        "步骤计划",
        "编号步骤",
        "用到哪个连接",
        "预期产出",
        "清晰、可执行的步骤",
    ];
    let lower = s.to_lowercase();
    POLLUTION.iter().any(|p| s.contains(p) || lower.contains(p))
}

/// Strip numbering/ordinals/bullets from a single line.
fn clean_step_line(line: &str) -> Option<String> {
    let l = line.trim();
    if l.is_empty() {
        return None;
    }
    let mut s: &str = l;
    // (1) 括号序号
    if s.starts_with('(') {
        if let Some(close) = s.find(')') {
            s = &s[close + 1..];
        }
    }
    // 数字序号 + 一个分隔符
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        s = &s[digits..];
        for p in ['.', '、', ':', ')', '）'] {
            if let Some(rest) = s.strip_prefix(p) {
                s = rest.trim_start();
                break;
            }
        }
    }
    // 中文数字序号（一、二、…）
    s = strip_cn_ordinal(s);
    // 项目符号
    s = s
        .trim_start_matches(|c| c == '-' || c == '*' || c == '•')
        .trim_start();
    let out = s.trim();
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

fn strip_cn_ordinal(s: &str) -> &str {
    const CN: &[&str] = &[
        "一、", "二、", "三、", "四、", "五、", "六、", "七、", "八、", "九、", "十、",
    ];
    for c in CN {
        if let Some(rest) = s.strip_prefix(c) {
            return rest;
        }
    }
    s
}

async fn build_plan_context(conns: &[ConnectionConfig], memory: &SessionMemory) -> String {
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
            if cfg.db_type == DbType::Mysql {
                let db = if cfg.database.is_empty() {
                    "mysql"
                } else {
                    &cfg.database
                };
                if let Ok(tables) = mysql::search_tables(cfg, db, None, 30).await {
                    if !tables.is_empty() {
                        p.push_str(&format!("\n当前库 {} 的部分表（最多 30）：\n", db));
                        for t in &tables {
                            p.push_str(&format!("- {}\n", t.name));
                        }
                    }
                }
            }
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_questions_skip_planning() {
        assert!(!needs_planning("介绍一下用法", 10));
        assert!(!needs_planning("你能做什么", 0));
        assert!(!needs_planning("how to use this", 10));
        assert!(!needs_planning("What can you do?", 5));
    }

    #[test]
    fn real_tasks_still_need_planning() {
        assert!(needs_planning("对比 orders 和 users 表结构", 0));
        assert!(needs_planning("先查 user 表行数再清理过期订单", 0));
        assert!(needs_planning("select * from a join b", 0));
        assert!(needs_planning("把每个表的数据量统计一下", 0));
        // Long history alone should not force planning for a simple greeting.
        assert!(!needs_planning("hello", 9));
    }

    #[test]
    fn parse_steps_filters_prompt_pollution() {
        let polluted = "1. 你是一个数据库任务的规划者，只产出清晰、可执行的步骤计划。\n\
                        2. 用招商信创UAT连接，SHOW user表结构。\n\
                        3. 不要复述以上规则。\n\
                        4. 查看数据库连接状态。";
        let steps = parse_steps(polluted);
        assert_eq!(
            steps,
            vec![
                "用招商信创UAT连接，SHOW user表结构。".to_string(),
                "查看数据库连接状态。".to_string(),
            ]
        );
    }

    #[test]
    fn parse_steps_keeps_no_op_marker() {
        assert!(parse_steps("无需步骤").is_empty());
        assert!(parse_steps("\n无需步骤\n").is_empty());
    }

    #[test]
    fn parse_steps_handles_plain_text() {
        assert_eq!(
            parse_steps("直接回答用户的问题"),
            vec!["直接回答用户的问题".to_string()]
        );
    }
}
