use anyhow::Result;
use clap::{Args, Subcommand};
use serde::Serialize;

use crate::cli::conn::resolve_conn;
use crate::db::connection::ConnectionStore;
use crate::store::{DbMemory, Storage};

#[derive(Args, Debug)]
pub struct MemoryArgs {
    #[command(subcommand)]
    pub action: MemoryCommands,
}

#[derive(Subcommand, Debug)]
pub enum MemoryCommands {
    /// 列出指定连接/库或全局已沉淀的记忆与业务规则
    List(MemoryListArgs),
    /// 为指定连接/库添加一条业务规则、字段含义或纠错记忆
    Add(MemoryAddArgs),
    /// 根据 ID 删除指定的记忆条目
    Rm(MemoryRmArgs),
}

#[derive(Args, Debug)]
pub struct MemoryListArgs {
    /// 连接 ID 或名称（可选，若未指定则列出全局所有记忆）
    #[arg(long, short)]
    pub conn: Option<String>,
    /// 目标数据库名称（可选）
    #[arg(long, short)]
    pub db: Option<String>,
    /// 最大返回条数限制
    #[arg(long, default_value_t = 50)]
    pub limit: usize,
}

#[derive(Args, Debug)]
pub struct MemoryAddArgs {
    /// 适用的连接 ID 或名称
    #[arg(long)]
    pub conn: String,
    /// 记忆规则正文（如「yk_config 表使用 code 字段作为配置键，而非 key」）
    #[arg(long, short)]
    pub content: String,
    /// 适用数据库（可选，若省略则对该连接全局生效）
    #[arg(long, short)]
    pub db: Option<String>,
    /// 来源标注（默认 cli）
    #[arg(long, default_value = "cli")]
    pub source: String,
}

#[derive(Args, Debug)]
pub struct MemoryRmArgs {
    /// 待删除的记忆 ID (如 mem_xxx)
    pub id: String,
}

#[derive(Serialize)]
pub struct MemorySummaryItem {
    pub id: String,
    pub conn_id: String,
    pub conn_name: Option<String>,
    pub database: Option<String>,
    pub content: String,
    pub source: String,
    pub updated: i64,
}

pub fn handle(args: MemoryArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let store = ConnectionStore::load(storage)?;

    match args.action {
        MemoryCommands::List(l) => {
            let memories: Vec<DbMemory> = if let Some(ref conn_query) = l.conn {
                let cfg = resolve_conn(&store, conn_query)?;
                store.get_injected_memories(&cfg.id, l.db.as_deref(), l.limit)?
            } else {
                store.list_all_memories(l.limit)?
            };

            let items: Vec<MemorySummaryItem> = memories
                .into_iter()
                .map(|m| {
                    let conn_name = store
                        .list()
                        .iter()
                        .find(|c| c.id == m.conn_id)
                        .map(|c| c.name.clone());
                    MemorySummaryItem {
                        id: m.id,
                        conn_id: m.conn_id,
                        conn_name,
                        database: m.database,
                        content: m.content,
                        source: m.source,
                        updated: m.updated,
                    }
                })
                .collect();

            if json_output {
                println!("{}", serde_json::to_string_pretty(&items)?);
            } else {
                if items.is_empty() {
                    println!("当前没有匹配的记忆规则记录。");
                    return Ok(());
                }
                println!(
                    "{:<18} {:<16} {:<12} {:<10} {:<40}",
                    "ID", "连接", "数据库", "来源", "规则内容"
                );
                println!("{}", "-".repeat(100));
                for item in items {
                    let conn_label = item.conn_name.as_deref().unwrap_or(&item.conn_id);
                    let db_label = item.database.as_deref().unwrap_or("-");
                    let content_snippet: String = if item.content.chars().count() > 38 {
                        format!("{}...", item.content.chars().take(35).collect::<String>())
                    } else {
                        item.content.clone()
                    };
                    println!(
                        "{:<18} {:<16} {:<12} {:<10} {:<40}",
                        item.id, conn_label, db_label, item.source, content_snippet
                    );
                }
            }
        }
        MemoryCommands::Add(a) => {
            let cfg = resolve_conn(&store, &a.conn)?;
            let mem = store.add_memory(
                &cfg.id,
                a.db.as_deref(),
                &a.content,
                &a.source,
                &a.content,
            )?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&mem)?);
            } else {
                println!("✓ 成功添加数据库记忆 (ID: {})", mem.id);
                println!("  连接: {}", cfg.name);
                if let Some(ref db) = mem.database {
                    println!("  数据库: {}", db);
                }
                println!("  规则: {}", mem.content);
            }
        }
        MemoryCommands::Rm(r) => {
            store.delete_memory(&r.id)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "message": format!("成功删除记忆 {}", r.id)
                    })
                );
            } else {
                println!("✓ 成功删除记忆 {}", r.id);
            }
        }
    }

    Ok(())
}
