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

/// Redis 命令只读白名单。Redis 没有统一的 SQL 语法，按命令首词白名单判定。
/// 只读命令直接放行；其余（写/管理/危险命令）一律视为写操作或破坏性操作进入护栏。
pub fn redis_command_is_read_only(cmd: &str) -> bool {
    let c = cmd.trim();
    if c.is_empty() {
        return false;
    }
    let first = c
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase();

    matches!(
        first.as_str(),
        "GET"
            | "MGET"
            | "HGET"
            | "HMGET"
            | "HGETALL"
            | "HKEYS"
            | "HVALS"
            | "HLEN"
            | "HEXISTS"
            | "LRANGE"
            | "LLEN"
            | "LINDEX"
            | "LPOS"
            | "LRANK"
            | "SMEMBERS"
            | "SCARD"
            | "SISMEMBER"
            | "SRANDMEMBER"
            | "SMISMEMBER"
            | "ZRANGE"
            | "ZRANGEBYSCORE"
            | "ZCARD"
            | "ZSCORE"
            | "ZCOUNT"
            | "ZRANK"
            | "ZREVRANGE"
            | "ZREVRANK"
            | "ZREVRANGEBYSCORE"
            | "ZMSCORE"
            | "EXISTS"
            | "TTL"
            | "PTTL"
            | "TYPE"
            | "KEYS"
            | "SCAN"
            | "DBSIZE"
            | "RANDOMKEY"
            | "GETRANGE"
            | "SUBSTR"
            | "STRLEN"
            | "GETBIT"
            | "MSTRLEN"
            | "OBJECT"
            | "MEMORY"
            | "INFO"
            | "PING"
            | "ECHO"
            | "TIME"
            | "COMMAND"
            | "COMMANDDOCS"
            | "BITCOUNT"
            | "BITPOS"
            | "LCS"
    )
}

/// Redis 语句策略分级：
/// - 只读命令 → Allow
/// - 危险管理/破坏性命令（FLUSHALL / FLUSHDB / CONFIG / SHUTDOWN 等）→ Deny（硬拦截，无弹窗）
/// - 写命令与其余未知命令（SET / DEL / EXPIRE 等）→ ConfirmRequired（需用户显式确认）
pub fn redis_statement_policy(cmd: &str) -> PolicyDecision {
    let first = cmd.split_whitespace().next().unwrap_or("").to_uppercase();
    if first.is_empty() {
        return PolicyDecision::Deny("空命令".to_string());
    }
    if redis_command_is_read_only(cmd) {
        return PolicyDecision::Allow;
    }
    const DANGEROUS: &[&str] = &[
        "FLUSHALL", "FLUSHDB", "CONFIG", "SHUTDOWN", "DEBUG", "SCRIPT",
        "FAILOVER", "REPLICAOF", "SLAVEOF", "CLUSTER", "RESTORE", "MIGRATE",
    ];
    if DANGEROUS.contains(&first.as_str()) {
        return PolicyDecision::Deny(format!(
            "危险 Redis 命令 `{}` 被 AI 护栏默认拦截。",
            first
        ));
    }
    PolicyDecision::ConfirmRequired(format!(
        "这是一条 Redis 写命令（{}），执行前需要你确认。",
        first
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redis_read_only_whitelist_covers_common_reads() {
        for c in ["GET k", "HGETALL h", "ZRANGE z 0 -1", "SCAN 0", "TTL k", "TYPE k", "PING"] {
            assert!(redis_command_is_read_only(c), "{} 应判为只读", c);
        }
    }

    #[test]
    fn redis_write_commands_are_not_read_only() {
        for c in ["SET k v", "DEL k", "FLUSHALL", "EXPIRE k 1", "LPUSH l v", "HSET h f v"] {
            assert!(!redis_command_is_read_only(c), "{} 不应判为只读", c);
        }
    }

    #[test]
    fn redis_dangerous_commands_are_denied_without_prompt() {
        assert!(matches!(redis_statement_policy("FLUSHALL"), PolicyDecision::Deny(_)));
        assert!(matches!(redis_statement_policy("CONFIG SET dir /tmp"), PolicyDecision::Deny(_)));
        assert!(matches!(redis_statement_policy("SHUTDOWN NOSAVE"), PolicyDecision::Deny(_)));
    }

    #[test]
    fn redis_write_requires_confirmation() {
        assert!(matches!(redis_statement_policy("SET k v"), PolicyDecision::ConfirmRequired(_)));
        assert!(matches!(redis_statement_policy("DEL key1"), PolicyDecision::ConfirmRequired(_)));
    }

    #[test]
    fn mysql_policy_regression_not_broken() {
        assert!(matches!(check_statement("SELECT 1"), PolicyDecision::Allow));
        assert!(matches!(check_statement("DELETE FROM t"), PolicyDecision::ConfirmRequired(_)));
        assert!(matches!(check_statement("DROP TABLE t"), PolicyDecision::Deny(_)));
    }
}
