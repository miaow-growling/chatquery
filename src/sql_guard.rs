//! Guard against destructive whole-table writes.
//!
//! `analyze_write_sql` scans a SQL string (single or multi-statement) for
//! `UPDATE` / `DELETE` statements that carry **no** top-level `WHERE` or
//! `LIMIT` clause — i.e. operations that would modify or delete every row of
//! a table. The UI calls this before executing so it can pop a confirmation
//! dialog, and the backend re-checks it as a last line of defense (an
//! unguarded write is rejected unless the caller explicitly passes
//! `allow_risky`).
//!
//! The analysis is deliberately conservative *lexical* scanning, not a full
//! SQL parser: string literals, quoted identifiers and comments are blanked
//! out first, then keywords are matched at top parenthesis depth. False
//! positives (a top-level `WHERE` inside an `UPDATE` that the scanner cannot
//! see) are impossible because subquery `WHERE`s always sit inside parens;
//! the only accepted weakness is `WHERE 1`-style tautologies, which we treat
//! as an explicit user intent.

use serde::Serialize;

/// Which kind of unguarded write a statement is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WriteRiskKind {
    /// `UPDATE t SET ...` with no top-level WHERE/LIMIT — would touch every row.
    UpdateAll,
    /// `DELETE FROM t` with no top-level WHERE/LIMIT — would empty the table.
    DeleteAll,
}

/// A single risky statement, serialized for the Tauri boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRisk {
    pub kind: WriteRiskKind,
    /// Collapsed, length-capped rendering of the original statement.
    pub preview: String,
}

/// Scan `sql` for unguarded UPDATE/DELETE statements. Multi-statement scripts
/// are split on top-level semicolons and every statement is checked, so
/// `SELECT 1; DELETE FROM t;` still reports the DELETE.
pub fn analyze_write_sql(sql: &str) -> Vec<WriteRisk> {
    let mut risks = Vec::new();
    for stmt in split_statements(sql) {
        let trimmed = stmt.trim();
        if trimmed.is_empty() {
            continue;
        }
        let clean = clean_sql(trimmed);
        let toks = tokens(&clean);
        if toks.is_empty() {
            continue;
        }
        let Some(kind) = statement_action(&toks) else {
            continue;
        };
        if !has_guard(&toks) {
            risks.push(WriteRisk {
                kind,
                preview: preview(trimmed),
            });
        }
    }
    risks
}

/// Validate that a SQL statement is strictly a read-only query for MCP execution.
/// Rejects all DML (INSERT, UPDATE, DELETE, REPLACE, etc.), all DDL (CREATE, ALTER, DROP, TRUNCATE, etc.),
/// all DCL/admin commands (GRANT, REVOKE, SET, FLUSH, LOCK, etc.), locking queries (FOR UPDATE),
/// file writing side-effects (INTO OUTFILE/DUMPFILE), and multi-statement scripts.
pub fn validate_mcp_query_safety(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL 语句不能为空".to_string());
    }

    // 1. 检查多语句注入 (多条由分号分隔的语句)
    let stmts = split_statements(trimmed);
    let non_empty_stmts: Vec<&String> = stmts.iter().filter(|s| !s.trim().is_empty()).collect();
    if non_empty_stmts.len() > 1 {
        return Err("MCP 每次仅允许执行单条 SQL 语句，禁止多语句脚本执行".to_string());
    }
    if non_empty_stmts.is_empty() {
        return Err("SQL 语句不能为空".to_string());
    }

    let clean = clean_sql(trimmed);
    let toks = tokens(&clean);
    if toks.is_empty() {
        return Err("无法识别有效的 SQL 关键字".to_string());
    }

    // 2. 确定顶层主动词 (若包含 WITH CTE，需找到 CTE 之后的真正执行动词)
    let first_tok = &toks[0];
    let main_verb = if first_tok.word == "WITH" {
        let mut target_verb = None;
        for t in &toks[1..] {
            if t.depth == 0
                && matches!(
                    t.word.as_str(),
                    "SELECT"
                        | "INSERT"
                        | "UPDATE"
                        | "DELETE"
                        | "REPLACE"
                        | "CREATE"
                        | "ALTER"
                        | "DROP"
                        | "TRUNCATE"
                )
            {
                target_verb = Some(t.word.clone());
                break;
            }
        }
        target_verb.unwrap_or_else(|| "WITH".to_string())
    } else {
        first_tok.word.clone()
    };

    // 3. 严格校验主语句动词是否为合法的只读查询动词
    match main_verb.as_str() {
        "SELECT" | "SHOW" | "EXPLAIN" | "DESC" | "DESCRIBE" => {
            // 合法只读查询主词
        }
        "INSERT" => return Err("MCP 安全限制：禁止数据新增操作 (INSERT)".to_string()),
        "UPDATE" => return Err("MCP 安全限制：禁止数据更新操作 (UPDATE)".to_string()),
        "DELETE" => return Err("MCP 安全限制：禁止数据删除操作 (DELETE)".to_string()),
        "REPLACE" => return Err("MCP 安全限制：禁止数据替换操作 (REPLACE)".to_string()),
        "CREATE" => return Err("MCP 安全限制：禁止任何 DDL 操作 (CREATE)".to_string()),
        "ALTER" => return Err("MCP 安全限制：禁止任何 DDL 操作 (ALTER)".to_string()),
        "DROP" => return Err("MCP 安全限制：禁止任何 DDL 操作 (DROP)".to_string()),
        "TRUNCATE" => return Err("MCP 安全限制：禁止任何 DDL 操作 (TRUNCATE)".to_string()),
        "RENAME" => return Err("MCP 安全限制：禁止任何 DDL 操作 (RENAME)".to_string()),
        "GRANT" | "REVOKE" => {
            return Err("MCP 安全限制：禁止权限管理操作 (GRANT/REVOKE)".to_string())
        }
        "LOCK" | "UNLOCK" => {
            return Err("MCP 安全限制：禁止加锁/解锁表操作 (LOCK/UNLOCK)".to_string())
        }
        "FLUSH" | "RESET" | "KILL" => {
            return Err("MCP 安全限制：禁止系统维护与连接控制操作 (FLUSH/RESET/KILL)".to_string())
        }
        "SET" => return Err("MCP 安全限制：禁止修改会话或系统变量配置 (SET)".to_string()),
        "CALL" => return Err("MCP 安全限制：禁止调用存储过程 (CALL)".to_string()),
        "LOAD" => return Err("MCP 安全限制：禁止数据导入加载操作 (LOAD)".to_string()),
        "HANDLER" | "DO" => return Err(format!("MCP 安全限制：禁止 {} 语句", main_verb)),
        other => {
            return Err(format!(
                "MCP 安全限制：仅允许数据查询操作，拒绝执行 '{}' 语句",
                other
            ))
        }
    }

    // 4. 深度扫描：即使是 SELECT，也必须禁止副作用与锁定子句
    for i in 0..toks.len() {
        if toks[i].word == "INTO" && i + 1 < toks.len() {
            let next = &toks[i + 1].word;
            if next == "OUTFILE" || next == "DUMPFILE" {
                return Err(
                    "MCP 安全限制：禁止导出文件到服务器文件系统的操作 (INTO OUTFILE/DUMPFILE)"
                        .to_string(),
                );
            }
        }
        if toks[i].word == "FOR" && i + 1 < toks.len() {
            let next = &toks[i + 1].word;
            if next == "UPDATE" || next == "SHARE" {
                return Err(
                    "MCP 安全限制：禁止加锁查询 (FOR UPDATE / FOR SHARE)，请使用普通无锁 SELECT"
                        .to_string(),
                );
            }
        }
        if toks[i].word == "LOCK" && i + 3 < toks.len() {
            if toks[i + 1].word == "IN" && toks[i + 2].word == "SHARE" && toks[i + 3].word == "MODE"
            {
                return Err("MCP 安全限制：禁止锁定查询 (LOCK IN SHARE MODE)".to_string());
            }
        }
    }

    // 5. 扫描是否含有顶层未闭合的 DDL 或写入关键字
    for t in &toks {
        if t.depth == 0
            && matches!(
                t.word.as_str(),
                "DROP" | "TRUNCATE" | "ALTER" | "RENAME" | "INSERT" | "DELETE" | "UPDATE"
            )
            && main_verb != "EXPLAIN"
            && main_verb != "SHOW"
        {
            if main_verb == "SELECT"
                && (t.word == "INSERT" || t.word == "DELETE" || t.word == "UPDATE")
            {
                return Err(format!(
                    "MCP 安全限制：SELECT 语句中包含写入操作 '{}'",
                    t.word
                ));
            }
        }
    }

    Ok(())
}

/// True when the statement carries a top-level WHERE or LIMIT — both MySQL
/// UPDATE and DELETE accept LIMIT, so either one bounds the operation.
fn has_guard(toks: &[Token]) -> bool {
    toks.iter()
        .any(|t| t.depth == 0 && (t.word == "WHERE" || t.word == "LIMIT"))
}

/// Determine the action verb of a statement from its top-level tokens.
/// `UPDATE t ...` / `DELETE t ...` are direct; `WITH cte AS (...) UPDATE ...`
/// resolves to the last top-level UPDATE/DELETE (the CTE itself never mutates
/// data). Everything else (SELECT/INSERT/SHOW/...) yields `None`.
fn statement_action(toks: &[Token]) -> Option<WriteRiskKind> {
    let first = toks.iter().find(|t| t.depth == 0)?;
    match first.word.as_str() {
        "UPDATE" => Some(WriteRiskKind::UpdateAll),
        "DELETE" => Some(WriteRiskKind::DeleteAll),
        "WITH" => toks
            .iter()
            .filter(|t| t.depth == 0)
            .rev()
            .find(|t| t.word == "UPDATE" || t.word == "DELETE")
            .map(|t| {
                if t.word == "DELETE" {
                    WriteRiskKind::DeleteAll
                } else {
                    WriteRiskKind::UpdateAll
                }
            }),
        _ => None,
    }
}

/// A keyword token with the parenthesis depth at which it appeared.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    word: String,
    depth: usize,
}

/// Lex `clean` SQL (already stripped of literals/comments) into word tokens,
/// tagging each with its parenthesis depth so subquery clauses can be ignored.
fn tokens(clean: &str) -> Vec<Token> {
    let chars: Vec<char> = clean.chars().collect();
    let mut toks = Vec::new();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '(' {
            depth += 1;
            i += 1;
        } else if c == ')' {
            depth = depth.saturating_sub(1);
            i += 1;
        } else if c.is_ascii_alphabetic() {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            toks.push(Token {
                word: word.to_ascii_uppercase(),
                depth,
            });
            // A keyword only matches on a word boundary; `wherever` must not
            // count as `WHERE`. The lexer already stops at non-alphanumerics,
            // so a boundary is implied unless the next char is `_` — which is
            // handled by the loop above.
        } else {
            i += 1;
        }
    }
    toks
}

/// Replace string literals (`'…'` / `"…"`), backtick identifiers and all
/// comment forms (`-- `, `#`, `/* … */`) with spaces, keeping the character
/// count identical so offset math stays trivial. Parentheses and semicolons
/// survive — they are the only syntax this analysis cares about.
fn clean_sql(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out: Vec<char> = chars.clone();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' | '"' | '`' => {
                let q = c;
                out[i] = ' ';
                i += 1;
                while i < chars.len() {
                    let c2 = chars[i];
                    if c2 == '\\' && i + 1 < chars.len() {
                        out[i] = ' ';
                        out[i + 1] = ' ';
                        i += 2;
                        continue;
                    }
                    if c2 == q {
                        out[i] = ' ';
                        i += 1;
                        break;
                    }
                    out[i] = ' ';
                    i += 1;
                }
            }
            '-' if i + 1 < chars.len()
                && chars[i + 1] == '-'
                && (i + 2 >= chars.len()
                    || chars[i + 2] == ' '
                    || chars[i + 2] == '\t'
                    || chars[i + 2] == '\n'
                    || chars[i + 2] == '\r') =>
            {
                out[i] = ' ';
                out[i + 1] = ' ';
                i += 2;
                while i < chars.len() && chars[i] != '\n' {
                    out[i] = ' ';
                    i += 1;
                }
            }
            '#' => {
                while i < chars.len() && chars[i] != '\n' {
                    out[i] = ' ';
                    i += 1;
                }
            }
            '/' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                out[i] = ' ';
                out[i + 1] = ' ';
                i += 2;
                while i + 1 < chars.len() {
                    if chars[i] == '*' && chars[i + 1] == '/' {
                        out[i] = ' ';
                        out[i + 1] = ' ';
                        i += 2;
                        break;
                    }
                    out[i] = ' ';
                    i += 1;
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    out.into_iter().collect()
}

/// Split `sql` on top-level semicolons (literals/comments already neutralized
/// by `clean_sql`, so only parenthesis depth matters here).
fn split_statements(sql: &str) -> Vec<String> {
    let clean = clean_sql(sql);
    // `clean` is char-for-char aligned with `sql`, but NOT byte-aligned:
    // multibyte chars inside literals/comments are blanked to single-byte
    // spaces. The enumerate() index below is therefore a CHAR index and must
    // never slice `sql` directly — doing so panics on a non-char boundary
    // (e.g. Chinese column aliases) and takes the whole app down.
    let sql_chars: Vec<char> = sql.chars().collect();
    let mut stmts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (i, c) in clean.chars().enumerate() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => {
                stmts.push(sql_chars[start..i].iter().collect());
                start = i + 1;
            }
            _ => {}
        }
    }
    if start < sql_chars.len() {
        stmts.push(sql_chars[start..].iter().collect());
    }
    stmts
}

/// One-line, length-capped rendering of a statement for the confirm dialog.
fn preview(s: &str) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut p = collapsed;
    if p.chars().count() > 100 {
        p = p.chars().take(100).collect::<String>() + " …";
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(sql: &str) -> Vec<WriteRiskKind> {
        analyze_write_sql(sql)
            .into_iter()
            .map(|r| r.kind)
            .collect()
    }

    #[test]
    fn flags_unguarded_update_and_delete() {
        assert_eq!(kinds("UPDATE users SET name='x'"), vec![WriteRiskKind::UpdateAll]);
        assert_eq!(kinds("delete from users"), vec![WriteRiskKind::DeleteAll]);
        assert_eq!(kinds("DELETE   FROM users  "), vec![WriteRiskKind::DeleteAll]);
        assert_eq!(kinds("UPDATE LOW_PRIORITY IGNORE t SET a=1"), vec![WriteRiskKind::UpdateAll]);
    }

    #[test]
    fn splits_multibyte_sql_on_char_boundaries() {
        // Regression: split_statements used the char index from clean.chars()
        // as a BYTE index into `sql`. With multibyte chars (中文别名) before
        // the semicolon this panicked at a non-char boundary and crashed the
        // whole app (main-thread abort).
        let sql = "SELECT org.name AS 公司, proj.name AS 末级项目 FROM k_task t;\nSELECT 1";
        let stmts = split_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].contains("公司"));
        assert!(!stmts[0].contains(';'));
        assert_eq!(stmts[1].trim(), "SELECT 1");

        // Literal containing multibyte text followed by a semicolon inside it
        // must not split — clean_sql blanks the literal first.
        let q = "SELECT '中文；分号' AS x; UPDATE t SET a=1 WHERE id=2";
        let stmts2 = split_statements(q);
        assert_eq!(stmts2.len(), 2);
        assert!(stmts2[0].contains("中文；分号"));
    }

    #[test]
    fn allows_guarded_statements() {
        assert!(kinds("UPDATE users SET name='x' WHERE id=1").is_empty());
        assert!(kinds("UPDATE users SET name='x' WHERE id IN (SELECT id FROM banned)").is_empty());
        assert!(kinds("DELETE FROM users WHERE id=1").is_empty());
        assert!(kinds("DELETE FROM logs WHERE created < NOW()").is_empty());
        assert!(kinds("DELETE FROM logs LIMIT 100").is_empty());
        assert!(kinds("UPDATE users SET name='x' LIMIT 5").is_empty());
        assert!(kinds("DELETE t1 FROM t1 JOIN t2 ON t1.id=t2.id WHERE t2.flag=1").is_empty());
    }

    #[test]
    fn ignores_where_inside_subqueries_and_literals() {
        // WHERE lives inside the SET subquery → still a full-table update.
        assert_eq!(
            kinds("UPDATE t SET a=(SELECT max(b) FROM x WHERE c=1)"),
            vec![WriteRiskKind::UpdateAll]
        );
        // The word "where" appears only inside a string literal.
        assert_eq!(
            kinds("UPDATE t SET a='where is the bug'"),
            vec![WriteRiskKind::UpdateAll]
        );
        // DELETE with a subquery-derived guard is fine (top-level WHERE exists).
        assert!(kinds("DELETE FROM t WHERE id IN (SELECT id FROM x WHERE y=2)").is_empty());
    }

    #[test]
    fn ignores_non_target_statements() {
        assert!(kinds("SELECT * FROM users").is_empty());
        assert!(kinds("SHOW TABLES").is_empty());
        assert!(kinds("INSERT INTO users VALUES (1)").is_empty());
        assert!(kinds("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a=2").is_empty());
        assert!(kinds("CREATE TABLE t (id INT)").is_empty());
        assert!(kinds("TRUNCATE TABLE t").is_empty());
    }

    #[test]
    fn handles_with_prefix() {
        assert_eq!(
            kinds("WITH cte AS (SELECT 1) UPDATE t SET a=1"),
            vec![WriteRiskKind::UpdateAll]
        );
        assert_eq!(
            kinds("WITH cte AS (SELECT 1) DELETE FROM t"),
            vec![WriteRiskKind::DeleteAll]
        );
        assert!(kinds("WITH cte AS (SELECT 1) UPDATE t SET a=1 WHERE id=1").is_empty());
    }

    #[test]
    fn handles_comments_and_leading_whitespace() {
        assert_eq!(kinds("-- cleanup old rows\nDELETE FROM t"), vec![WriteRiskKind::DeleteAll]);
        assert_eq!(kinds("# purge\nDELETE FROM t"), vec![WriteRiskKind::DeleteAll]);
        assert_eq!(kinds("/* heavy */ UPDATE t SET a=1"), vec![WriteRiskKind::UpdateAll]);
        // Commented-out risky statement must NOT be flagged.
        assert!(kinds("-- DELETE FROM t").is_empty());
        assert!(kinds("/* DELETE FROM t */ SELECT 1").is_empty());
    }

    #[test]
    fn scans_multi_statement_scripts() {
        assert_eq!(
            kinds("SELECT 1; DELETE FROM t; UPDATE x SET a=1 WHERE id=2"),
            vec![WriteRiskKind::DeleteAll]
        );
        // Semicolon inside a string literal does not split the statement.
        assert_eq!(
            kinds("UPDATE t SET a='x; y'"),
            vec![WriteRiskKind::UpdateAll]
        );
    }

    #[test]
    fn preview_is_collapsed_and_capped() {
        let r = analyze_write_sql("UPDATE\n  very_long_table_name\nSET a = 1").remove(0);
        assert!(r.preview.starts_with("UPDATE very_long_table_name SET a = 1"));
        assert!(r.preview.chars().count() <= 105);
    }

    #[test]
    fn mcp_safety_allows_valid_read_queries() {
        assert!(validate_mcp_query_safety("SELECT * FROM users").is_ok());
        assert!(validate_mcp_query_safety("SELECT id, name FROM `order` WHERE status = 1 LIMIT 50").is_ok());
        assert!(validate_mcp_query_safety("SHOW TABLES").is_ok());
        assert!(validate_mcp_query_safety("SHOW CREATE TABLE users").is_ok());
        assert!(validate_mcp_query_safety("EXPLAIN SELECT * FROM users").is_ok());
        assert!(validate_mcp_query_safety("DESCRIBE users").is_ok());
        assert!(validate_mcp_query_safety("DESC users").is_ok());
        assert!(validate_mcp_query_safety("WITH t AS (SELECT 1 AS a) SELECT * FROM t").is_ok());
        assert!(validate_mcp_query_safety("/* comment */ SELECT 1").is_ok());
        assert!(validate_mcp_query_safety("-- note\nSELECT 1").is_ok());
    }

    #[test]
    fn mcp_safety_rejects_dml_writes() {
        assert!(validate_mcp_query_safety("INSERT INTO users (id) VALUES (1)").is_err());
        assert!(validate_mcp_query_safety("UPDATE users SET name = 'foo' WHERE id = 1").is_err());
        assert!(validate_mcp_query_safety("DELETE FROM users WHERE id = 1").is_err());
        assert!(validate_mcp_query_safety("REPLACE INTO users VALUES (1, 'bar')").is_err());
        assert!(validate_mcp_query_safety("CALL my_proc()").is_err());
        assert!(validate_mcp_query_safety("LOAD DATA INFILE 'foo' INTO TABLE t").is_err());
        assert!(validate_mcp_query_safety("WITH t AS (SELECT 1) DELETE FROM users").is_err());
        assert!(validate_mcp_query_safety("WITH t AS (SELECT 1) UPDATE users SET a=1").is_err());
    }

    #[test]
    fn mcp_safety_rejects_all_ddl() {
        assert!(validate_mcp_query_safety("DROP TABLE users").is_err());
        assert!(validate_mcp_query_safety("DROP DATABASE test_db").is_err());
        assert!(validate_mcp_query_safety("CREATE TABLE users (id int)").is_err());
        assert!(validate_mcp_query_safety("ALTER TABLE users ADD COLUMN age int").is_err());
        assert!(validate_mcp_query_safety("TRUNCATE TABLE users").is_err());
        assert!(validate_mcp_query_safety("RENAME TABLE users TO old_users").is_err());
        assert!(validate_mcp_query_safety("/* hidden */ DROP TABLE users").is_err());
    }

    #[test]
    fn mcp_safety_rejects_admin_and_locks() {
        assert!(validate_mcp_query_safety("GRANT ALL ON *.* TO root").is_err());
        assert!(validate_mcp_query_safety("REVOKE ALL ON *.* FROM root").is_err());
        assert!(validate_mcp_query_safety("SET GLOBAL max_connections = 100").is_err());
        assert!(validate_mcp_query_safety("FLUSH PRIVILEGES").is_err());
        assert!(validate_mcp_query_safety("LOCK TABLES users WRITE").is_err());
    }

    #[test]
    fn mcp_safety_rejects_side_effects_and_multistatements() {
        assert!(validate_mcp_query_safety("SELECT * FROM users INTO OUTFILE '/tmp/hack'").is_err());
        assert!(validate_mcp_query_safety("SELECT * FROM users INTO DUMPFILE '/tmp/hack'").is_err());
        assert!(validate_mcp_query_safety("SELECT * FROM users FOR UPDATE").is_err());
        assert!(validate_mcp_query_safety("SELECT * FROM users FOR SHARE").is_err());
        assert!(validate_mcp_query_safety("SELECT * FROM users LOCK IN SHARE MODE").is_err());
        assert!(validate_mcp_query_safety("SELECT 1; DROP TABLE users;").is_err());
        assert!(validate_mcp_query_safety("SELECT 1; DELETE FROM users;").is_err());
    }
}
