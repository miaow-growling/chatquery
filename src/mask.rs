//! Result masking before query results leave the machine (Phase 7).
//!
//! When the LLM tool `execute_query` runs a query, the result is shipped to a
//! *cloud* model. Sending raw PII (phone, email, ID card, tokens...) to a third
//! party is a leak. This module produces a **masked copy** of the result that
//! is fed to the model only — the local TUI still shows the real data, because
//! the user owns their own terminal.
//!
//! Two complementary strategies:
//! 1. **Column-name rules**: a column whose name contains a sensitive keyword
//!    (password, token, phone, email, id_card, ...) is masked wholesale.
//! 2. **Value-pattern rules**: any value matching a sensitive regex (mobile,
//!    email, CN ID card, long digit run) is masked wherever it appears, even in
//!    an otherwise-normal column (e.g. a `remark` containing a phone number).
//!
//! A single combined regex is used for value masking so matches are
//! non-overlapping and never cascade on already-masked text.
//!
//! Masking is **on by default** (fail-safe). Disable with
//! `CHATQUERY_MASK_RESULTS=0|off|false|no`.

use crate::db::mysql::QueryResult;
use crate::db::redis::RedisResult;
use std::sync::OnceLock;

/// Sensitive column-name keywords (case-insensitive substring match).
const SENSITIVE_COLUMN_KEYWORDS: &[&str] = &[
    "password", "passwd", "pwd", "token", "secret", "credential", "apikey", "api_key",
    "phonenumber", "phone", "mobile", "tel", "email", "mail", "idnumber", "idcard",
    "id_card", "ssn", "bankcard", "bank_card", "card_no", "cardnum", "creditcard",
    "credit_card", "salt", "hash",
];

/// Returns true if a column name looks sensitive.
pub fn sensitive_column(name: &str) -> bool {
    let n = name.to_lowercase();
    SENSITIVE_COLUMN_KEYWORDS.iter().any(|k| n.contains(k))
}

/// Single combined value pattern (mobile | email | CN id card | long digit run).
fn value_pattern() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"1[3-9]\d{9}|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}|\d{17}[\dXx]|\b\d{13,19}\b",
        )
        .unwrap()
    })
}

/// Mask a matched value: keep a little context, hide the middle.
fn mask_internal(m: &str) -> String {
    let chars: Vec<char> = m.chars().collect();
    let n = chars.len();
    if n <= 2 {
        return "*".repeat(n.max(1));
    }
    if n <= 7 {
        let head: String = chars[..1].iter().collect();
        let tail: String = chars[n - 1..].iter().collect();
        format!("{}{}{}", head, "*".repeat(n - 2), tail)
    } else {
        let head: String = chars[..3].iter().collect();
        let tail: String = chars[n - 4..].iter().collect();
        format!("{}{}{}", head, "*".repeat(n - 7), tail)
    }
}

/// Mask any value-pattern occurrences inside a string (normal columns and
/// Redis lines, which have no schema).
pub fn mask_value(s: &str) -> String {
    if s.is_empty() {
        return s.to_string();
    }
    value_pattern()
        .replace_all(s, |caps: &regex::Captures| mask_internal(&caps[0]))
        .into_owned()
}

/// Mask a whole value unconditionally (sensitive-named columns).
fn mask_whole(v: &str) -> String {
    if v.is_empty() {
        return v.to_string();
    }
    mask_internal(v)
}

/// Produce a masked copy of a MySQL result.
pub fn mask_query_result(r: &QueryResult) -> QueryResult {
    let sensitive: Vec<bool> = r.columns.iter().map(|c| sensitive_column(c)).collect();
    let rows = r
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .enumerate()
                .map(|(i, v)| {
                    if sensitive.get(i).copied().unwrap_or(false) {
                        mask_whole(v)
                    } else {
                        mask_value(v)
                    }
                })
                .collect()
        })
        .collect();
    QueryResult {
        columns: r.columns.clone(),
        rows,
        truncated: r.truncated,
        total: r.total,
        primary_keys: r.primary_keys.clone(),
        affected: r.affected,
        last_insert_id: r.last_insert_id,
    }
}

/// Produce a masked copy of a Redis result (value-level only).
pub fn mask_redis_result(r: &RedisResult) -> RedisResult {
    let lines = r.lines.iter().map(|l| mask_value(l)).collect();
    RedisResult {
        command: r.command.clone(),
        lines,
        truncated: r.truncated,
        note: r.note.clone(),
        value: r.value.clone(),
        ttl: r.ttl,
        size: r.size,
    }
}

/// Whether masking is active. Default true; opt out via env.
pub fn masking_enabled() -> bool {
    match std::env::var("CHATQUERY_MASK_RESULTS") {
        Ok(v) => !matches!(v.to_lowercase().as_str(), "0" | "off" | "false" | "no"),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_name_rules() {
        assert!(sensitive_column("user_password"));
        assert!(sensitive_column("apiKey"));
        assert!(sensitive_column("id_card"));
        assert!(sensitive_column("phone_number"));
        assert!(!sensitive_column("user_name"));
        assert!(!sensitive_column("order_id"));
    }

    #[test]
    fn masks_phone_in_value() {
        assert_eq!(mask_value("13812345678"), "138****5678");
    }

    #[test]
    fn masks_email_partially() {
        let out = mask_value("contact alice@example.com please");
        assert!(out.starts_with("contact "));
        assert!(!out.contains("alice@"));
        assert!(!out.contains("example"));
    }

    #[test]
    fn masks_id_card() {
        assert_eq!(mask_value("11010519491231002X"), "110***********002X");
    }

    #[test]
    fn masks_long_digit_run() {
        let out = mask_value("card 6222021234567890 end");
        assert!(out.contains("622*********7890"));
    }

    #[test]
    fn masks_sensitive_column_wholly() {
        let r = QueryResult {
            columns: vec!["id".into(), "user_password".into(), "note".into()],
            rows: vec![vec!["7".into(), "s3cr3t".into(), "call 13812345678".into()]],
            truncated: false,
            total: None,
            primary_keys: vec![],
            affected: None,
            last_insert_id: None,
        };
        let m = mask_query_result(&r);
        // password column fully masked (prefix/suffix preserved)
        assert_eq!(m.rows[0][1], "s****t");
        // note column: only the embedded phone is masked, text preserved
        assert!(m.rows[0][2].contains("call "));
        assert!(!m.rows[0][2].contains("13812345678"));
        // id column untouched
        assert_eq!(m.rows[0][0], "7");
    }

    #[test]
    fn masking_default_on() {
        std::env::remove_var("CHATQUERY_MASK_RESULTS");
        assert!(masking_enabled());
    }
}
