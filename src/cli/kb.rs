use anyhow::{anyhow, Result};
use clap::{Args, Subcommand};
use serde::Serialize;
use std::fs;

use crate::cli::conn::resolve_conn;
use crate::db::connection::ConnectionStore;
use crate::store::{preview_of, Storage};

#[derive(Args, Debug)]
pub struct KbArgs {
    #[command(subcommand)]
    pub action: KbCommands,
}

#[derive(Subcommand, Debug)]
pub enum KbCommands {
    /// 列出知识库文档（可按连接和数据库过滤）
    List(KbListArgs),
    /// 新增知识库文档并可同时绑定至连接与数据库
    Add(KbAddArgs),
    /// 在指定连接或库的知识库中按关键词检索
    Search(KbSearchArgs),
    /// 根据 ID 删除知识库文档
    Rm(KbRmArgs),
}

#[derive(Args, Debug)]
pub struct KbListArgs {
    /// 筛选连接 ID 或名称（可选）
    #[arg(long, short)]
    pub conn: Option<String>,
    /// 筛选数据库（可选）
    #[arg(long, short)]
    pub db: Option<String>,
}

#[derive(Args, Debug)]
pub struct KbAddArgs {
    /// 文档标题
    #[arg(long, short)]
    pub name: String,
    /// 文档内容（直接在命令行传入）
    #[arg(long, short)]
    pub content: Option<String>,
    /// 从指定文件路径读取内容（Markdown 或纯文本文件）
    #[arg(long, short)]
    pub file: Option<String>,
    /// 绑定的连接 ID 或名称（可选）
    #[arg(long)]
    pub conn: Option<String>,
    /// 绑定的数据库（可选，需配合 --conn 使用）
    #[arg(long)]
    pub db: Option<String>,
}

#[derive(Args, Debug)]
pub struct KbSearchArgs {
    /// 检索关键词
    pub query: String,
    /// 目标连接 ID 或名称
    #[arg(long, short)]
    pub conn: String,
    /// 目标数据库（可选）
    #[arg(long, short)]
    pub db: Option<String>,
}

#[derive(Args, Debug)]
pub struct KbRmArgs {
    /// 待删除的文档 ID (如 kb_xxx)
    pub id: String,
}

#[derive(Serialize)]
pub struct KbDocSummaryItem {
    pub id: String,
    pub name: String,
    pub preview: String,
    pub bindings_count: usize,
    pub created: i64,
    pub updated: i64,
}

pub fn handle(args: KbArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let mut store = ConnectionStore::load(storage)?;

    match args.action {
        KbCommands::List(l) => {
            if let Some(ref conn_query) = l.conn {
                let cfg = resolve_conn(&store, conn_query)?;
                let docs = store.get_injected_kb_docs(&cfg.id, l.db.as_deref())?;
                let items: Vec<KbDocSummaryItem> = docs
                    .into_iter()
                    .map(|d| KbDocSummaryItem {
                        id: d.id,
                        name: d.name,
                        preview: preview_of(Some(&d.content)),
                        bindings_count: 1,
                        created: d.created,
                        updated: d.updated,
                    })
                    .collect();

                if json_output {
                    println!("{}", serde_json::to_string_pretty(&items)?);
                } else {
                    if items.is_empty() {
                        println!("该连接/库下没有绑定的知识库文档。");
                        return Ok(());
                    }
                    println!("{:<18} {:<24} {:<40}", "ID", "文档标题", "内容预览");
                    println!("{}", "-".repeat(85));
                    for item in items {
                        println!("{:<18} {:<24} {:<40}", item.id, item.name, item.preview);
                    }
                }
            } else {
                let docs = store.list_kb_docs()?;
                let mut items = Vec::new();
                for d in docs {
                    let bindings = store.get_kb_bindings(&d.id).unwrap_or_default();
                    items.push(KbDocSummaryItem {
                        id: d.id,
                        name: d.name,
                        preview: preview_of(Some(&d.content)),
                        bindings_count: bindings.len(),
                        created: d.created,
                        updated: d.updated,
                    });
                }

                if json_output {
                    println!("{}", serde_json::to_string_pretty(&items)?);
                } else {
                    if items.is_empty() {
                        println!("当前没有知识库文档。可使用 `chatquery kb add` 添加。");
                        return Ok(());
                    }
                    println!("{:<18} {:<24} {:<8} {:<40}", "ID", "文档标题", "绑定数", "内容预览");
                    println!("{}", "-".repeat(95));
                    for item in items {
                        println!(
                            "{:<18} {:<24} {:<8} {:<40}",
                            item.id, item.name, item.bindings_count, item.preview
                        );
                    }
                }
            }
        }
        KbCommands::Add(a) => {
            let content_text = if let Some(c) = a.content {
                c
            } else if let Some(f) = a.file {
                fs::read_to_string(&f).map_err(|e| anyhow!("读取文件 '{}' 失败: {}", f, e))?
            } else {
                return Err(anyhow!("必须提供 --content 内容或 --file 文件路径"));
            };

            let conn_id = if let Some(ref conn_query) = a.conn {
                let cfg = resolve_conn(&store, conn_query)?;
                Some(cfg.id)
            } else {
                None
            };

            let kb_id = store.add_kb_doc_with_binding(
                &a.name,
                &content_text,
                conn_id.as_deref(),
                a.db.as_deref(),
            )?;

            if json_output {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "id": kb_id,
                        "name": a.name,
                        "bound_conn": a.conn,
                        "bound_db": a.db,
                    })
                );
            } else {
                println!("✓ 成功创建知识库文档 (ID: {})", kb_id);
                println!("  标题: {}", a.name);
                if let Some(ref c) = a.conn {
                    println!("  绑定连接: {}", c);
                    if let Some(ref d) = a.db {
                        println!("  绑定数据库: {}", d);
                    }
                }
            }
        }
        KbCommands::Search(s) => {
            let cfg = resolve_conn(&store, &s.conn)?;
            let text = store.search_kb_docs(&cfg.id, s.db.as_deref(), &s.query)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::json!({
                        "query": s.query,
                        "connection": cfg.name,
                        "database": s.db,
                        "result": text,
                    })
                );
            } else {
                println!("{}", text);
            }
        }
        KbCommands::Rm(r) => {
            store.delete_kb_doc(&r.id)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": true,
                        "message": format!("成功删除知识库文档 {}", r.id)
                    })
                );
            } else {
                println!("✓ 成功删除知识库文档 {}", r.id);
            }
        }
    }

    Ok(())
}
