use anyhow::Result;
use clap::Args;
use serde::Serialize;

use crate::sql_guard::{self, WriteRisk};

#[derive(Args, Debug)]
pub struct GuardArgs {
    /// 待检查的 SQL 语句文本
    pub sql: String,
}

#[derive(Serialize)]
pub struct GuardOutput {
    pub safe: bool,
    pub is_destructive: bool,
    pub risks: Vec<WriteRisk>,
    pub warnings: Vec<String>,
}

fn normalize_sql_tokens(sql: &str) -> String {
    let block_comments = regex::Regex::new(r"(?s)/\*.*?\*/").expect("valid block comment regex");
    let line_comments =
        regex::Regex::new(r"(?m)(--[^\n]*|#[^\n]*)").expect("valid line comment regex");
    let without_blocks = block_comments.replace_all(sql, " ");
    let without_comments = line_comments.replace_all(&without_blocks, " ");
    without_comments
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

pub fn handle(args: GuardArgs, json_output: bool) -> Result<()> {
    let sql = args.sql.trim();
    let risks = sql_guard::analyze_write_sql(sql);

    let mut warnings = Vec::new();
    let normalized = normalize_sql_tokens(sql);
    if normalized.contains("DROP TABLE") || normalized.contains("DROP DATABASE") {
        warnings.push("检测到 DROP 操作，具有不可逆毁灭性风险".to_string());
    }
    if normalized.contains("TRUNCATE TABLE") {
        warnings.push("检测到 TRUNCATE 清表操作，具有不可逆清空风险".to_string());
    }

    let is_destructive = !warnings.is_empty();
    let safe = risks.is_empty() && warnings.is_empty();

    if json_output {
        let out = GuardOutput {
            safe,
            is_destructive,
            risks,
            warnings,
        };
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        if safe {
            println!("✓ SQL 风险检测通过：未发现无 WHERE 的全表修改或毁灭性 DDL。");
        } else {
            eprintln!("⚠️ SQL 风险警报！");
            for r in &risks {
                eprintln!("  - [高风险] {:?}: {}", r.kind, r.preview);
            }
            for w in &warnings {
                eprintln!("  - [高危操作] {}", w);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_sql_tokens;

    #[test]
    fn normalizes_comments_and_newlines_for_destructive_ddl() {
        assert!(normalize_sql_tokens("DROP /* cleanup */\n TABLE users").contains("DROP TABLE"));
        assert!(normalize_sql_tokens("TRUNCATE\nTABLE users").contains("TRUNCATE TABLE"));
    }
}
