use anyhow::{anyhow, Context, Result};
use clap::{Args, Subcommand};
use serde::Serialize;

use crate::cli::conn::resolve_conn;
use crate::db::connection::{ConnectionStore, DbType};
use crate::db::mysql::{self, ColumnInfo, TableMeta};
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct MetaArgs {
    #[command(subcommand)]
    pub action: MetaCommands,
}

#[derive(Subcommand, Debug)]
pub enum MetaCommands {
    /// 列出指定连接中的所有数据表
    Tables(MetaTablesArgs),
    /// 模糊搜索数据表与字段
    Search(MetaSearchArgs),
    /// 查看单张或多张表的详细字段信息
    Schema(MetaSchemaArgs),
    /// 生成专为 AI Prompt 优化的极简表结构上下文 (Token 节省模式)
    PromptCtx(MetaPromptCtxArgs),
}

#[derive(Args, Debug)]
pub struct MetaTablesArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 数据库名称（默认使用连接中配置的默认数据库）
    #[arg(long)]
    pub db: Option<String>,
    /// 模糊过滤模式（如 *order*）
    #[arg(long, short)]
    pub filter: Option<String>,
}

#[derive(Args, Debug)]
pub struct MetaSearchArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 搜索关键词（表名或字段名）
    pub keyword: String,
    /// 数据库名称
    #[arg(long)]
    pub db: Option<String>,
}

#[derive(Args, Debug)]
pub struct MetaSchemaArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 数据表名称（支持传入一个或多个）
    #[arg(required = true)]
    pub tables: Vec<String>,
    /// 数据库名称
    #[arg(long)]
    pub db: Option<String>,
}

#[derive(Args, Debug)]
pub struct MetaPromptCtxArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 数据表名称（支持传入一个或多个）
    #[arg(required = true)]
    pub tables: Vec<String>,
    /// 数据库名称
    #[arg(long)]
    pub db: Option<String>,
}

#[derive(Serialize)]
pub struct TableSummaryItem {
    pub name: String,
    pub is_view: bool,
    pub comment: Option<String>,
}

#[derive(Serialize)]
pub struct TableSchemaOutput {
    pub table: String,
    pub columns: Vec<ColumnInfo>,
}

pub async fn handle(args: MetaArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let store = ConnectionStore::load(storage)?;

    match args.action {
        MetaCommands::Tables(t) => {
            let cfg = resolve_conn(&store, &t.conn)?;
            if cfg.db_type != DbType::Mysql {
                return Err(anyhow!("目前元数据探查仅支持 MySQL 连接"));
            }
            let target_db =
                t.db.as_deref()
                    .or(if cfg.database.is_empty() {
                        None
                    } else {
                        Some(&cfg.database)
                    })
                    .ok_or_else(|| anyhow!("连接中未配置默认数据库，请使用 --db 指定数据库名称"))?;

            let tables = mysql::list_tables(&cfg, target_db).await?;
            let filter_lower = t
                .filter
                .as_ref()
                .map(|f| f.trim_matches('*').to_lowercase());

            let matched: Vec<TableMeta> = tables
                .into_iter()
                .filter(|tbl| {
                    if let Some(ref flt) = filter_lower {
                        tbl.name.to_lowercase().contains(flt)
                            || tbl
                                .comment
                                .as_deref()
                                .map(|c| c.to_lowercase().contains(flt))
                                .unwrap_or(false)
                    } else {
                        true
                    }
                })
                .collect();

            if json_output {
                let out: Vec<TableSummaryItem> = matched
                    .iter()
                    .map(|m| TableSummaryItem {
                        name: m.name.clone(),
                        is_view: m.is_view,
                        comment: m.comment.clone(),
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                if matched.is_empty() {
                    println!("未找到匹配的数据表");
                    return Ok(());
                }
                println!("{:<36} {:<10} {:<30}", "表名", "类型", "表注释");
                println!("{}", "-".repeat(80));
                for m in matched {
                    let type_label = if m.is_view { "视图" } else { "基础表" };
                    let comment_label = m.comment.as_deref().unwrap_or("-");
                    println!("{:<36} {:<10} {:<30}", m.name, type_label, comment_label);
                }
            }
        }
        MetaCommands::Search(s) => {
            let cfg = resolve_conn(&store, &s.conn)?;
            if cfg.db_type != DbType::Mysql {
                return Err(anyhow!("目前元数据探查仅支持 MySQL 连接"));
            }
            let target_db =
                s.db.as_deref()
                    .or(if cfg.database.is_empty() {
                        None
                    } else {
                        Some(&cfg.database)
                    })
                    .ok_or_else(|| anyhow!("连接中未配置默认数据库，请使用 --db 指定数据库名称"))?;

            let all_tables = mysql::list_tables(&cfg, target_db).await?;
            let kw = s.keyword.to_lowercase();

            let mut matched_tables: Vec<(String, Option<String>)> = Vec::new();

            for tbl in &all_tables {
                let hit_name = tbl.name.to_lowercase().contains(&kw);
                let hit_comment = tbl
                    .comment
                    .as_deref()
                    .map(|c| c.to_lowercase().contains(&kw))
                    .unwrap_or(false);
                if hit_name || hit_comment {
                    matched_tables.push((tbl.name.clone(), tbl.comment.clone()));
                }
            }

            let matched_columns = mysql::search_columns_in_db(&cfg, target_db, &kw, 100).await?;

            if json_output {
                let res = serde_json::json!({
                    "keyword": s.keyword,
                    "matched_tables": matched_tables.iter().map(|(t, cm)| serde_json::json!({
                        "table": t,
                        "comment": cm,
                    })).collect::<Vec<_>>(),
                    "matched_columns": matched_columns.iter().map(|(t, c, cm)| serde_json::json!({
                        "table": t,
                        "column": c,
                        "comment": cm,
                    })).collect::<Vec<_>>(),
                });
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                println!("=== 搜索结果: \"{}\" ===", s.keyword);
                if !matched_tables.is_empty() {
                    println!("\n[命中的数据表]:");
                    for (t, cm) in matched_tables {
                        let comment_str = cm.map(|text| format!(" ({})", text)).unwrap_or_default();
                        println!("  - {}{}", t, comment_str);
                    }
                }
                if !matched_columns.is_empty() {
                    println!("\n[命中的字段/注释]:");
                    for (t, c, cm) in matched_columns {
                        let comment_str = cm.map(|text| format!(" ({})", text)).unwrap_or_default();
                        println!("  - {}.{}{}", t, c, comment_str);
                    }
                }
            }
        }
        MetaCommands::Schema(sc) => {
            let cfg = resolve_conn(&store, &sc.conn)?;
            if cfg.db_type != DbType::Mysql {
                return Err(anyhow!("目前元数据探查仅支持 MySQL 连接"));
            }
            let target_db = sc
                .db
                .as_deref()
                .or(if cfg.database.is_empty() {
                    None
                } else {
                    Some(&cfg.database)
                })
                .ok_or_else(|| anyhow!("连接中未配置默认数据库，请使用 --db 指定数据库名称"))?;

            let mut results = Vec::new();
            for table_name in &sc.tables {
                let columns = mysql::list_columns(&cfg, target_db, table_name)
                    .await
                    .with_context(|| format!("获取表 '{}' 结构失败", table_name))?;
                results.push(TableSchemaOutput {
                    table: table_name.clone(),
                    columns,
                });
            }

            if json_output {
                println!("{}", serde_json::to_string_pretty(&results)?);
            } else {
                for item in results {
                    println!("\n=== 表: {} ===", item.table);
                    println!(
                        "{:<24} {:<16} {:<6} {:<8} {:<16} {:<20}",
                        "字段名", "类型", "Key", "Null", "默认值", "注释"
                    );
                    println!("{}", "-".repeat(95));
                    for c in item.columns {
                        println!(
                            "{:<24} {:<16} {:<6} {:<8} {:<16} {:<20}",
                            c.name,
                            c.data_type,
                            c.key,
                            c.nullable,
                            c.default.as_deref().unwrap_or("-"),
                            c.comment.as_deref().unwrap_or("")
                        );
                    }
                }
            }
        }
        MetaCommands::PromptCtx(p) => {
            let cfg = resolve_conn(&store, &p.conn)?;
            if cfg.db_type != DbType::Mysql {
                return Err(anyhow!("目前 Prompt 上下文生成仅支持 MySQL 连接"));
            }
            let target_db =
                p.db.as_deref()
                    .or(if cfg.database.is_empty() {
                        None
                    } else {
                        Some(&cfg.database)
                    })
                    .ok_or_else(|| anyhow!("连接中未配置默认数据库，请使用 --db 指定数据库名称"))?;

            let all_tables = mysql::list_tables(&cfg, target_db).await.unwrap_or_default();
            let mut markdown_buf = String::new();

            for table_name in &p.tables {
                let columns = mysql::list_columns(&cfg, target_db, table_name)
                    .await
                    .with_context(|| format!("获取表 '{}' 结构失败", table_name))?;

                let comment_suffix = all_tables
                    .iter()
                    .find(|t| t.name == *table_name)
                    .and_then(|t| t.comment.as_deref())
                    .filter(|cm| !cm.trim().is_empty())
                    .map(|cm| format!(" ({})", cm.trim()))
                    .unwrap_or_default();

                markdown_buf.push_str(&format!("### Table `{}`{}\n", table_name, comment_suffix));
                for c in columns {
                    let mut flags: Vec<String> = Vec::new();
                    if c.key == "PRI" {
                        flags.push("PK".to_string());
                    } else if c.key == "UNI" {
                        flags.push("UNIQUE".to_string());
                    } else if c.key == "MUL" {
                        flags.push("INDEX".to_string());
                    }
                    if c.nullable == "NO" && c.key != "PRI" {
                        flags.push("NOT NULL".to_string());
                    }
                    if let Some(ref d) = c.default {
                        flags.push(format!("DEFAULT '{}'", d));
                    }

                    let flag_str = if flags.is_empty() {
                        String::new()
                    } else {
                        format!(", {}", flags.join(", "))
                    };

                    let comment_str = match c.comment {
                        Some(ref cm) if !cm.trim().is_empty() => format!(" ({})", cm.trim()),
                        _ => String::new(),
                    };

                    markdown_buf.push_str(&format!(
                        "- `{}`: {}{}{}\n",
                        c.name, c.data_type, flag_str, comment_str
                    ));
                }
                markdown_buf.push('\n');
            }

            // 附带关联的业务规则与历史纠错记忆
            let memories = store
                .get_injected_memories(&cfg.id, Some(target_db), 50)
                .unwrap_or_default();
            if !memories.is_empty() {
                markdown_buf.push_str("## 数据库业务规则与历史纠错记忆（必须严格遵守）：\n");
                for (i, m) in memories.iter().enumerate() {
                    markdown_buf.push_str(&format!("{}. {}\n", i + 1, m.content));
                }
                markdown_buf.push('\n');
            }

            // 附带关联的业务知识库文档
            let kb_docs = store
                .get_injected_kb_docs(&cfg.id, Some(target_db))
                .unwrap_or_default();
            if !kb_docs.is_empty() {
                markdown_buf.push_str("## 关联业务知识库：\n");
                let mut total = 0usize;
                const PER_DOC: usize = 2000;
                const TOTAL_CAP: usize = 6000;
                for doc in &kb_docs {
                    if total >= TOTAL_CAP {
                        break;
                    }
                    let take: String = doc.content.chars().take(PER_DOC).collect();
                    total += take.chars().count();
                    markdown_buf.push_str(&format!("- 文档「{}」：{}\n", doc.name, take));
                }
                markdown_buf.push('\n');
            }

            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "context_markdown": markdown_buf.trim(),
                    }))?
                );
            } else {
                println!("{}", markdown_buf.trim());
            }
        }
    }

    Ok(())
}
