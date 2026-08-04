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
    const STEP_WORDS: &[&str] = &[
        "然后", "再", "接着", "之后", "并且", "同时", "以及", "与", "和",
        "对比", "比较", "分析", "汇总", "统计", "分别", "各自",
        "先", "批量", "所有表", "每个", "逐", "依次", "分步骤", "步骤", "计划",
        "创建", "新建", "导入", "导出", "迁移", "整理", "检查", "排查", "优化",
    ];
    if STEP_WORDS.iter().any(|w| user_query.contains(w)) {
        return true;
    }
    let lower = user_query.to_lowercase();
    if lower.contains("join") {
        return true;
    }
    // 多个 FROM 子句 → 多表 / 多步任务
    if lower.matches("from").count() >= 2 {
        return true;
    }
    // 多轮上下文：任务可能跨多步
    if history_len >= 4 {
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
         - 用中文，简洁。\n",
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
            steps.push(s);
        }
    }
    if steps.is_empty() {
        let t = text.trim();
        if !t.is_empty() {
            steps.push(t.to_string());
        }
    }
    steps
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
