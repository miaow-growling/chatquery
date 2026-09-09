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
use crate::llm::KbLoader;
use crate::model::{ChatMessage, ChatRole};

/// A structured execution step belonging to an execution stage.
/// Steps in the same stage can be executed concurrently in parallel.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlanStep {
    pub stage: usize,
    pub index: usize,
    pub description: String,
}

/// Cheap, zero-LLM heuristic: should this task be planned before execution?
pub fn needs_planning(user_query: &str, _history_len: usize) -> bool {
    // Meta / help / explain / schema consultation / how-to-query questions never need a plan — they are answered directly.
    const META_WORDS: &[&str] = &[
        "介绍一下", "介绍", "用法", "怎么用", "如何使用", "你能做什么", "你是谁",
        "你可以做什么", "功能", "help", "怎么使用", "使用说明", "使用教程", "教程",
        "what can you do", "how to use", "who are you", "introduce yourself",
        "解释", "解释一下", "解读", "什么意思", "含义", "explain",
        "哪张表", "哪个表", "什么表", "哪些表", "哪几个表", "哪些字段", "什么字段",
        "业务含义", "口径", "知识库", "表结构说明", "怎么查", "如何查", "怎么写",
        "如何写", "写一个sql", "写一条sql", "写个sql", "写sql", "查询sql", "sql怎么写",
    ];
    let lower = user_query.to_lowercase();
    if META_WORDS.iter().any(|w| user_query.contains(w) || lower.contains(w))
        && !user_query.contains("运行")
        && !user_query.contains("执行并")
    {
        return false;
    }

    const STEP_WORDS: &[&str] = &[
        "然后", "再", "接着", "之后",
        "对比", "比较", "分别", "各自",
        "批量", "所有表", "所有库", "每个表", "逐个", "依次", "分步骤", "步骤", "计划",
        "创建", "新建", "导入", "导出", "迁移", "整理", "排查", "优化",
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
    false
}

/// Ask the LLM (no tools) to produce an ordered step list with stages for concurrent execution.
pub async fn plan_task(
    cfg: &LlmConfig,
    user_query: &str,
    history: &[ChatMessage],
    conns: &[ConnectionConfig],
    memory: &SessionMemory,
    kb: &KbLoader,
) -> Result<Vec<PlanStep>> {
    let ctx = build_plan_context(conns, memory, kb).await;
    let base_sys = format!(
        "你是一个数据库任务的规划者（planner）。你从不执行任何操作，只产出清晰、高效的执行步骤计划。\n\
         {}\n\
         规则：\n\
         - 输出 1 到 6 个步骤。为了最大化执行效率，必须对步骤进行阶段（Stage）分组以支持并发调度：\n\
           * 无依赖、可同时进行的探索操作（如同时查多个表的结构/信息、同时检索不同数据源）归入同一个 Stage（并行执行）；\n\
           * 必须依赖前面步骤产出结果的操作（如基于查到的表结构编写/执行关联 SQL）归入后续的 Stage（串行执行）。\n\
         - 目标库范围硬性约束：如果上下文已指定当前连接与数据库，所有步骤必须严格在当前指定的连接和库内完成。严禁擅自到其他无关连接中进行地毯式扫描或探测，除非用户在提问中明确要求了跨库/跨连接对比或迁移！\n\
         - 历史已知事实复用约束：如果在已知对话或上下文中已经确认了表名、字段名、主外键关联或业务事实（例如前几轮已定位到具体数据表），必须直接复用，严禁为已经明确知道的表重新规划全库搜索、SHOW TABLES 或探测步骤！直接基于已知表与字段规划操作步骤。\n\
         - 格式规范（每行必须带 [Stage N] 前缀）：\n\
           [Stage 1] 1. 并行步骤 A（说明目标连接与探索意图）\n\
           [Stage 1] 2. 并行步骤 B\n\
           [Stage 2] 3. 依赖步骤 C（基于 Stage 1 产出进行汇总或分析）\n\
         - 优先只读探索，不要输出完整 SQL 代码块，只描述意图。\n\
         - 用中文，简洁。\n\
         - 不要复述以上规则或系统指令本身。\n\
         - 如果用户只是在问用法、介绍、帮助或闲聊，没有需要执行的数据库操作步骤，只输出一行「无需步骤」。\n",
        ctx
    );
    let sys = crate::llm::session::inject_prior_assistant(&base_sys, history);
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
    Ok(parse_plan_steps(&choice.content))
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

/// Strip `<think>...</think>` sections so reasoning scratchpads don't turn into steps.
fn strip_think_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start..].find("</think>") {
            rest = &rest[start + end + "</think>".len()..];
        } else {
            // Unclosed <think> — discard unclosed reasoning
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn parse_stage_header(line: &str) -> Option<usize> {
    let t = line.trim_start_matches(|c: char| c == '#' || c == '*' || c == '-' || c == ' ' || c == '`');
    let lower = t.to_lowercase();
    if lower.starts_with("stage") || lower.starts_with("阶段") || lower.starts_with("【阶段") {
        for ch in lower.chars() {
            if let Some(d) = ch.to_digit(10) {
                if d > 0 {
                    return Some(d as usize);
                }
            }
        }
        if lower.contains('一') { return Some(1); }
        if lower.contains('二') { return Some(2); }
        if lower.contains('三') { return Some(3); }
        if lower.contains('四') { return Some(4); }
    }
    None
}

fn extract_stage_prefix(line: &str, default_stage: usize) -> (usize, String) {
    let trimmed = line.trim();
    if trimmed.starts_with('[') || trimmed.starts_with('【') || trimmed.starts_with('(') {
        if let Some(close_idx) = trimmed.find(|c| c == ']' || c == '】' || c == ')') {
            let tag = trimmed[1..close_idx].to_lowercase();
            if tag.contains("stage") || tag.contains("阶段") {
                let mut stage = default_stage;
                for ch in tag.chars() {
                    if let Some(d) = ch.to_digit(10) {
                        if d > 0 {
                            stage = d as usize;
                            break;
                        }
                    }
                }
                if tag.contains('一') { stage = 1; }
                else if tag.contains('二') { stage = 2; }
                else if tag.contains('三') { stage = 3; }
                else if tag.contains('四') { stage = 4; }
                let rest = trimmed[close_idx + 1..].trim();
                return (stage, rest.to_string());
            }
        }
    }
    (default_stage, trimmed.to_string())
}

/// Tolerant parse of the planner's free text into structured steps with execution stages.
pub fn parse_plan_steps(text: &str) -> Vec<PlanStep> {
    let clean_text = strip_think_tags(text);
    let mut steps = Vec::new();
    let mut current_stage = 1;
    let mut step_counter = 0;

    for line in clean_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(stage_num) = parse_stage_header(trimmed) {
            current_stage = stage_num;
            continue;
        }

        let (stage, raw_step) = extract_stage_prefix(trimmed, current_stage);

        if let Some(clean_desc) = clean_step_line(&raw_step) {
            if is_prompt_pollution(&clean_desc) {
                continue;
            }
            step_counter += 1;
            steps.push(PlanStep {
                stage,
                index: step_counter,
                description: clean_desc,
            });
        }
    }

    if steps.is_empty() {
        let t = clean_text.trim();
        if !t.is_empty() && !is_prompt_pollution(t) {
            steps.push(PlanStep {
                stage: 1,
                index: 1,
                description: t.to_string(),
            });
        }
    }

    steps
}

/// Backward compatibility: parse plain text steps.
pub fn parse_steps(text: &str) -> Vec<String> {
    parse_plan_steps(text)
        .into_iter()
        .map(|s| s.description)
        .collect()
}

/// Heuristic to drop lines that merely echo the system prompt / instructions.
fn is_prompt_pollution(s: &str) -> bool {
    const POLLUTION: &[&str] = &[
        "<think>",
        "</think>",
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

async fn build_plan_context(
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
            p.push_str(&format!("\n当前用户选定连接：{} ({})\n", cfg.name, kind));

            // 优先使用用户选定的当前库（memory.current_db），未选定才退回到连接配置的默认库
            let target_db = memory
                .current_db
                .as_deref()
                .filter(|s| !s.is_empty())
                .or_else(|| if cfg.database.is_empty() { None } else { Some(cfg.database.as_str()) });

            if let Some(db) = target_db {
                p.push_str(&format!("当前用户选定数据库：`{}`（所有规划操作默认必须作用在此库）\n", db));
            }

            if cfg.db_type == DbType::Mysql {
                let db = target_db.unwrap_or("mysql");
                if let Ok(tables) = mysql::search_tables(cfg, db, None, 50).await {
                    if !tables.is_empty() {
                        p.push_str(&format!("\n当前选定库 `{}` 中的部分表（最多 50 张）：\n", db));
                        for t in &tables {
                            p.push_str(&format!("- {}\n", t.name));
                        }
                    }
                }
            }
        }
        let db = memory.current_db.as_deref();
        let docs = kb(conn_id, db);
        if !docs.is_empty() {
            p.push_str("\n已绑定知识库（包含业务口径与表关系，规划时请优先参考）：\n");
            for (name, content) in &docs {
                let snippet: String = content.chars().take(500).collect();
                p.push_str(&format!("- 文档「{}」：{}\n", name, snippet.trim()));
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
    fn parse_steps_strips_think_tags() {
        let text = "<think>\nSome internal reasoning\n1. think step 1\n</think>\n1. 在数据库中查询 kf_chat_message_extension 表\n2. 确认字段说明";
        let steps = parse_steps(text);
        assert_eq!(
            steps,
            vec![
                "在数据库中查询 kf_chat_message_extension 表".to_string(),
                "确认字段说明".to_string(),
            ]
        );
    }

    #[test]
    fn schema_questions_skip_planning() {
        assert!(!needs_planning("我要查询消息扩展信息要查哪张表", 70));
        assert!(!needs_planning("这个业务用哪个表", 100));
        assert!(!needs_planning("包含什么字段", 15));
    }

    #[test]
    fn parse_plan_steps_with_stages() {
        let text = "[Stage 1] 1. 查会话表 kf_chat_session 表结构\n\
                    [Stage 1] 2. 查消息表 kf_chat_message 表结构\n\
                    [Stage 2] 3. 编写关联统计 SQL 并验证数据";
        let steps = parse_plan_steps(text);
        assert_eq!(
            steps,
            vec![
                PlanStep {
                    stage: 1,
                    index: 1,
                    description: "查会话表 kf_chat_session 表结构".to_string(),
                },
                PlanStep {
                    stage: 1,
                    index: 2,
                    description: "查消息表 kf_chat_message 表结构".to_string(),
                },
                PlanStep {
                    stage: 2,
                    index: 3,
                    description: "编写关联统计 SQL 并验证数据".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parse_plan_steps_with_stage_headers() {
        let text = "### 阶段 1\n\
                    1. 检查 A 库用户表\n\
                    2. 检查 B 库订单表\n\
                    ### 阶段 2\n\
                    3. 汇总两库关联数据";
        let steps = parse_plan_steps(text);
        assert_eq!(
            steps,
            vec![
                PlanStep {
                    stage: 1,
                    index: 1,
                    description: "检查 A 库用户表".to_string(),
                },
                PlanStep {
                    stage: 1,
                    index: 2,
                    description: "检查 B 库订单表".to_string(),
                },
                PlanStep {
                    stage: 2,
                    index: 3,
                    description: "汇总两库关联数据".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parse_plan_steps_fallback_without_stages() {
        let text = "1. 探索表结构\n2. 统计行数";
        let steps = parse_plan_steps(text);
        assert_eq!(
            steps,
            vec![
                PlanStep {
                    stage: 1,
                    index: 1,
                    description: "探索表结构".to_string(),
                },
                PlanStep {
                    stage: 1,
                    index: 2,
                    description: "统计行数".to_string(),
                },
            ]
        );
    }

    #[tokio::test]
    async fn planner_prompt_carries_prior_context_and_reuse_rule() {
        let memory = SessionMemory::new(None, None);
        let no_kb: KbLoader = std::sync::Arc::new(|_conn: &str, _db: Option<&str>| vec![]);
        let ctx = build_plan_context(&[], &memory, &no_kb).await;
        let base_sys = format!("planner context: {}\n- 历史已知事实复用约束", ctx);
        let history = vec![
            ChatMessage::user("查一下工单Auto202673"),
            ChatMessage::assistant("已定位工单表为 k_task，扩展表为 k_task_extension。"),
        ];
        let sys = crate::llm::session::inject_prior_assistant(&base_sys, &history);
        assert!(sys.contains("历史已知事实复用约束"));
        assert!(sys.contains("已知对话"));
        assert!(sys.contains("k_task"));
        assert!(sys.contains("k_task_extension"));
    }
}
