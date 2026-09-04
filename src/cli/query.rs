use anyhow::{anyhow, Context, Result};
use clap::{Args, Subcommand};
use serde::Serialize;
use std::time::Instant;

use crate::cli::conn::resolve_conn;
use crate::db::connection::{ConnectionStore, DbType};
use crate::db::mysql::{self, is_read_query};
use crate::mask::mask_query_result;
use crate::sql_guard;
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct QueryArgs {
    #[command(subcommand)]
    pub action: QueryCommands,
}

#[derive(Subcommand, Debug)]
pub enum QueryCommands {
    /// 执行 SQL 查询
    Run(QueryRunArgs),
    /// 查看 SQL 执行计划与索引分析
    Explain(QueryExplainArgs),
}

#[derive(Args, Debug)]
pub struct QueryRunArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 待执行的 SQL 语句
    pub sql: String,
    /// 数据库名称
    #[arg(long)]
    pub db: Option<String>,
    /// 最大返回行数限制（默认 50）
    #[arg(long, default_value_t = 50)]
    pub limit: usize,
    /// 允许写操作（默认只读，禁止 INSERT/UPDATE/DELETE/DROP）
    #[arg(long)]
    pub allow_write: bool,
    /// 开启数据脱敏（掩盖手机号、身份证、密码等）
    #[arg(long)]
    pub mask: bool,
}

#[derive(Args, Debug)]
pub struct QueryExplainArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 待分析的 SELECT SQL 语句
    pub sql: String,
    /// 数据库名称
    #[arg(long)]
    pub db: Option<String>,
}

#[derive(Serialize)]
pub struct QueryRunOutput {
    pub ok: bool,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub affected_rows: u64,
    pub total_rows: Option<usize>,
    pub elapsed_ms: u128,
}

pub fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    if max_chars <= 3 {
        return ".".repeat(max_chars);
    }
    let prefix: String = value.chars().take(max_chars - 3).collect();
    format!("{}...", prefix)
}

pub async fn handle(args: QueryArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let store = ConnectionStore::load(storage)?;

    match args.action {
        QueryCommands::Run(r) => {
            let cfg = resolve_conn(&store, &r.conn)?;
            if cfg.db_type != DbType::Mysql {
                return Err(anyhow!("目前 SQL 查询仅支持 MySQL 连接"));
            }
            let target_db = r.db.as_deref().or(if cfg.database.is_empty() {
                None
            } else {
                Some(&cfg.database)
            });

            let trimmed_sql = r.sql.trim();
            if !mysql::is_single_statement(trimmed_sql) {
                return Err(anyhow!("安全拦截：CLI 每次只允许执行一条 SQL 语句"));
            }
            let is_read = is_read_query(trimmed_sql);
            let write_risks = sql_guard::analyze_write_sql(trimmed_sql);
            let keyword = mysql::statement_keyword(trimmed_sql);
            if matches!(keyword.as_str(), "DROP" | "TRUNCATE") {
                return Err(anyhow!("安全拦截：CLI 禁止执行 DROP/TRUNCATE 等不可逆操作"));
            }

            if !r.allow_write && (!is_read || !write_risks.is_empty()) {
                return Err(anyhow!(
                    "安全拦截：默认只读模式拒绝执行修改语句。若确认执行写操作，请附加 --allow-write 参数"
                ));
            }

            let start = Instant::now();
            let raw_res = if is_read {
                // 读取语句默认启用分页/limit 保护
                mysql::query_paged(&cfg, trimmed_sql, target_db, 0, r.limit, r.allow_write)
                    .await
                    .with_context(|| "执行查询失败")?
            } else {
                mysql::query(&cfg, trimmed_sql, target_db, r.allow_write)
                    .await
                    .with_context(|| "执行修改失败")?
            };
            let elapsed_ms = start.elapsed().as_millis();

            let res = if r.mask {
                mask_query_result(&raw_res)
            } else {
                raw_res
            };

            if json_output {
                let out = QueryRunOutput {
                    ok: true,
                    columns: res.columns,
                    rows: res.rows,
                    affected_rows: res.affected.unwrap_or(0),
                    total_rows: res.total,
                    elapsed_ms,
                };
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                if !is_read {
                    println!(
                        "✓ 执行成功，影响行数: {} (耗时: {}ms)",
                        res.affected.unwrap_or(0),
                        elapsed_ms
                    );
                    return Ok(());
                }

                if res.columns.is_empty() {
                    println!("查询结果为空 (耗时: {}ms)", elapsed_ms);
                    return Ok(());
                }

                // 计算每列最大宽度
                let mut widths: Vec<usize> = res
                    .columns
                    .iter()
                    .map(|c| c.chars().count().max(4))
                    .collect();
                for row in &res.rows {
                    for (i, cell) in row.iter().enumerate() {
                        if i < widths.len() {
                            widths[i] = widths[i].max(cell.chars().count()).min(40);
                        }
                    }
                }

                // 打印表头
                let header = res
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(i, c)| format!("{:<width$}", c, width = widths[i]))
                    .collect::<Vec<_>>()
                    .join(" | ");
                println!("{}", header);

                let separator = widths
                    .iter()
                    .map(|w| "-".repeat(*w))
                    .collect::<Vec<_>>()
                    .join("-+-");
                println!("{}", separator);

                // 打印行
                for row in &res.rows {
                    let line = row
                        .iter()
                        .enumerate()
                        .map(|(i, cell)| {
                            let width = widths.get(i).cloned().unwrap_or(10);
                            let truncated = truncate_chars(cell, width);
                            format!("{:<width$}", truncated, width = width)
                        })
                        .collect::<Vec<_>>()
                        .join(" | ");
                    println!("{}", line);
                }

                let total_info = match res.total {
                    Some(total) => format!("，总记录约 {} 行", total),
                    None => String::new(),
                };
                println!(
                    "\n(返回 {} 行数据{}，耗时: {}ms)",
                    res.rows.len(),
                    total_info,
                    elapsed_ms
                );
            }
        }
        QueryCommands::Explain(e) => {
            let cfg = resolve_conn(&store, &e.conn)?;
            if cfg.db_type != DbType::Mysql {
                return Err(anyhow!("目前 EXPLAIN 分析仅支持 MySQL 连接"));
            }
            let target_db = e.db.as_deref().or(if cfg.database.is_empty() {
                None
            } else {
                Some(&cfg.database)
            });

            let explain_sql = format!("EXPLAIN {}", e.sql.trim());
            let res = mysql::query(&cfg, &explain_sql, target_db, false)
                .await
                .with_context(|| "获取执行计划失败")?;

            if json_output {
                let out = serde_json::json!({
                    "columns": res.columns,
                    "rows": res.rows,
                });
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("=== SQL 执行计划 (EXPLAIN) ===");
                for row in &res.rows {
                    for (i, col) in res.columns.iter().enumerate() {
                        let val = row.get(i).map(|s| s.as_str()).unwrap_or("");
                        println!("  {:<16}: {}", col, val);
                    }
                    println!("{}", "-".repeat(40));
                }
            }
        }
    }

    Ok(())
}
