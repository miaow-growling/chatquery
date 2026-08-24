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
}
