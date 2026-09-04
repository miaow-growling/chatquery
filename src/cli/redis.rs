use anyhow::{anyhow, Context, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use crate::cli::conn::resolve_conn;
use crate::db::connection::{ConnectionStore, DbType};
use crate::db::redis;
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct RedisArgs {
    #[command(subcommand)]
    pub action: RedisCommands,
}

#[derive(Subcommand, Debug)]
pub enum RedisCommands {
    /// 匹配查询 Redis 键列表
    Keys(RedisKeysArgs),
    /// 读取指定的 Redis 键值
    Get(RedisGetArgs),
    /// 删除指定的 Redis 键
    Del(RedisDelArgs),
}

#[derive(Args, Debug)]
pub struct RedisKeysArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 键匹配模式（如 "user:*" 或 "*"）
    #[arg(default_value = "*")]
    pub pattern: String,
    /// Redis 数据库编号（默认 0）
    #[arg(long, default_value_t = 0)]
    pub db: u8,
    /// 返回条数上限（默认 50）
    #[arg(long, default_value_t = 50)]
    pub limit: usize,
}

#[derive(Args, Debug)]
pub struct RedisGetArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 键名称
    pub key: String,
    /// Redis 数据库编号（默认 0）
    #[arg(long, default_value_t = 0)]
    pub db: u8,
    /// 反序列化模式 (php | json)
    #[arg(long, value_enum)]
    pub unserialize: Option<UnserializeKind>,
}

#[derive(Args, Debug)]
pub struct RedisDelArgs {
    /// 连接 ID 或名称
    pub conn: String,
    /// 键名称
    pub key: String,
    /// Redis 数据库编号（默认 0）
    #[arg(long, default_value_t = 0)]
    pub db: u8,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnserializeKind {
    Php,
    Json,
}

#[derive(Serialize)]
pub struct RedisGetOutput {
    pub key: String,
    pub lines: Vec<String>,
    pub unserialized: Option<serde_json::Value>,
}

pub async fn handle(args: RedisArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let store = ConnectionStore::load(storage)?;

    match args.action {
        RedisCommands::Keys(k) => {
            let cfg = resolve_conn(&store, &k.conn)?;
            if cfg.db_type != DbType::Redis {
                return Err(anyhow!("目前 Redis 命令仅支持 Redis 连接"));
            }

            let keys = redis::list_keys(&cfg, k.db, &k.pattern, k.limit)
                .await
                .with_context(|| "扫描 Redis 键列表失败")?;

            if json_output {
                println!("{}", serde_json::to_string_pretty(&keys)?);
            } else {
                if keys.is_empty() {
                    println!("未找到匹配的键 (pattern: {})", k.pattern);
                    return Ok(());
                }
                println!("匹配到的键 (前 {} 条):", keys.len());
                for key in keys {
                    println!("  - {}", key);
                }
            }
        }
        RedisCommands::Get(g) => {
            let cfg = resolve_conn(&store, &g.conn)?;
            if cfg.db_type != DbType::Redis {
                return Err(anyhow!("目前 Redis 命令仅支持 Redis 连接"));
            }

            let res = redis::browse_key(&cfg, g.db, &g.key)
                .await
                .with_context(|| format!("读取键 '{}' 失败", g.key))?;

            let raw_content = res.lines.join("\n");
            let mut unserialized_val: Option<serde_json::Value> = None;

            if let Some(kind) = g.unserialize {
                match kind {
                    UnserializeKind::Json => {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw_content) {
                            unserialized_val = Some(v);
                        }
                    }
                    UnserializeKind::Php => {
                        if let Ok(json_str) = try_php_unserialize(&raw_content) {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
                                unserialized_val = Some(v);
                            }
                        }
                    }
                }
            }

            if json_output {
                let out = RedisGetOutput {
                    key: g.key,
                    lines: res.lines,
                    unserialized: unserialized_val,
                };
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                if let Some(ref v) = unserialized_val {
                    println!("=== 反序列化后的结果 ===");
                    println!("{}", serde_json::to_string_pretty(v)?);
                } else {
                    for line in res.lines {
                        println!("{}", line);
                    }
                }
            }
        }
        RedisCommands::Del(d) => {
            let cfg = resolve_conn(&store, &d.conn)?;
            if cfg.db_type != DbType::Redis {
                return Err(anyhow!("目前 Redis 命令仅支持 Redis 连接"));
            }

            let count = redis::delete_key(&cfg, d.db, &d.key)
                .await
                .with_context(|| format!("删除键 '{}' 失败", d.key))?;

            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "key": d.key,
                        "deleted_count": count,
                    }))?
                );
            } else {
                if count > 0 {
                    println!("✓ 键已删除: {} (删除数: {})", d.key, count);
                } else {
                    println!("键不存在或未被删除: {}", d.key);
                }
            }
        }
    }

    Ok(())
}

pub(crate) fn try_php_unserialize(data: &str) -> Result<String> {
    use std::process::Command;
    let current_exe = std::env::current_exe().ok();
    let candidates = [
        std::env::current_dir()
            .ok()
            .map(|p| p.join("php_unserialize.py")),
        current_exe
            .as_ref()
            .and_then(|p| p.parent())
            .map(|p| p.join("php_unserialize.py")),
        current_exe
            .as_ref()
            .and_then(|p| p.parent())
            .map(|p| p.join("../Resources/php_unserialize.py")),
        std::env::current_dir()
            .ok()
            .map(|p| p.join("src-tauri/scripts/php_unserialize.py")),
    ];
    let script = candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .ok_or_else(|| anyhow!("找不到 PHP 反序列化脚本 php_unserialize.py"))?;

    let mut child = Command::new("python3")
        .arg(script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(data.as_bytes());
    }

    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(anyhow!("Python PHP 反序列化失败"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::try_php_unserialize;

    #[test]
    fn bundled_php_parser_returns_json() {
        let output = try_php_unserialize(r#"a:1:{s:3:"foo";s:3:"bar";}"#).unwrap();
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["foo"], "bar");
    }
}
