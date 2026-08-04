/// AI agent safety guardrail (ADR-AI-1). Without it `execute_query` runs ANY
/// SQL the model emits — including `DROP` / `DELETE` / schema changes.
///
/// Default posture (Enforce):
/// - read-only statements are allowed,
/// - writes pause the turn and ask the user (see `llm::control::TurnControl`);
///   approving runs the statement, rejecting returns a refusal to the model,
/// - destructive / DDL statements are hard-denied — no prompt, no escape hatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Deny(String),
    ConfirmRequired(String),
}

/// Inspect a SQL statement and decide whether the agent may execute it.
pub fn check_statement(sql: &str) -> PolicyDecision {
    let s = sql.trim();
    if s.is_empty() {
        return PolicyDecision::Deny("空语句".to_string());
    }
    let first = s.split_whitespace().next().unwrap_or("").to_uppercase();
    match first.as_str() {
        "SELECT" | "SHOW" | "EXPLAIN" | "DESCRIBE" | "DESC" | "WITH" | "USE" | "SET" | "CALL" => {
            PolicyDecision::Allow
        }
        "INSERT" | "REPLACE" | "UPDATE" | "DELETE" => {
            PolicyDecision::ConfirmRequired(format!("这是一条写操作（{}），执行前需要你确认。", first))
        }
        "DROP" | "TRUNCATE" | "ALTER" | "CREATE" | "RENAME" | "GRANT" | "REVOKE" => {
            PolicyDecision::Deny(format!("破坏性/DDL 语句 `{}` 被 AI 护栏默认拦截。", first))
        }
        _ => PolicyDecision::Deny(format!("无法识别的语句类型，已被 AI 护栏拦截：{}", first)),
    }
}
