pub mod conn;
pub mod env;
pub mod group;
pub mod guard;
pub mod install;
pub mod mcp;
pub mod meta;
pub mod query;
pub mod redis;
pub mod tree;

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use serde::Serialize;
use std::io::IsTerminal;

#[derive(Parser, Debug)]
#[command(
    name = "chatquery",
    about = "本地数据库感知与操作工具 (CLI & MCP 引擎)",
    version
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// 输出格式 (json | table)
    #[arg(long, global = true, value_enum)]
    pub format: Option<OutputFormat>,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputFormat {
    Json,
    Table,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// 环境管理 (Environment: 顶层环境，如开发/测试/生产)
    Env(env::EnvArgs),
    /// 分组管理 (Group: 环境下的业务分组)
    Group(group::GroupArgs),
    /// 数据库连接管理 (Connection)
    Conn(conn::ConnArgs),
    /// 资产拓扑树查看 (数据库类型 -> 环境 -> 分组 -> 连接)
    Tree(tree::TreeArgs),
    /// 表结构与元数据探查 (专为 AI 上下文优化)
    Meta(meta::MetaArgs),
    /// SQL 数据查询与执行诊断 (只读安全保护)
    Query(query::QueryArgs),
    /// Redis 缓存与键值操作 (支持 PHP 反序列化)
    Redis(redis::RedisArgs),
    /// 纯离线 SQL 风险预审 (检测全表修改/毁灭性操作)
    Guard(guard::GuardArgs),
    /// 启动标准 Model Context Protocol (MCP) 服务 (stdio 模式)
    Mcp(mcp::McpArgs),
    /// 命令行快捷工具软链接管理与诊断
    Install,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    ok: bool,
    error_code: String,
    message: String,
}

/// 解析参数并执行子命令。若指定了子命令，执行后返回 Ok(true)；若无子命令，返回 Ok(false)。
pub async fn dispatch(args: Option<Vec<String>>) -> Result<bool> {
    let cli = match args {
        Some(a) => match Cli::try_parse_from(a) {
            Ok(c) => c,
            Err(e) => {
                e.exit();
            }
        },
        None => match Cli::try_parse() {
            Ok(c) => c,
            Err(e) => {
                e.exit();
            }
        },
    };

    let Some(cmd) = cli.command else {
        return Ok(false);
    };

    let is_tty = std::io::stdout().is_terminal();
    let is_json =
        matches!(cli.format, Some(OutputFormat::Json)) || (!is_tty && cli.format.is_none());

    let result = match cmd {
        Commands::Env(a) => env::handle(a, is_json),
        Commands::Group(a) => group::handle(a, is_json),
        Commands::Conn(a) => conn::handle(a, is_json).await,
        Commands::Tree(a) => tree::handle(a, is_json),
        Commands::Meta(a) => meta::handle(a, is_json).await,
        Commands::Query(a) => query::handle(a, is_json).await,
        Commands::Redis(a) => redis::handle(a, is_json).await,
        Commands::Guard(a) => guard::handle(a, is_json),
        Commands::Mcp(a) => mcp::run(a).await,
        Commands::Install => match install::ensure_cli_symlink() {
            Ok(Some(p)) => {
                println!("✓ 命令行工具软链接已配置: {}", p.display());
                let bin_dir = p.parent().unwrap();
                if !install::is_dir_in_path(bin_dir) {
                    eprintln!(
                        "提示: 您的 PATH 环境变量尚未包含 {}，请将其加入 ~/.zshrc 或 ~/.bashrc",
                        bin_dir.display()
                    );
                }
                Ok(())
            }
            Ok(None) => {
                println!("当前平台无需或不支持软链接配置");
                Ok(())
            }
            Err(e) => Err(anyhow::anyhow!("安装软链接失败: {}", e)),
        },
    };

    if let Err(err) = result {
        if is_json {
            let env = ErrorEnvelope {
                ok: false,
                error_code: "COMMAND_ERROR".to_string(),
                message: err.to_string(),
            };
            eprintln!("{}", serde_json::to_string_pretty(&env)?);
        } else {
            eprintln!("错误: {}", err);
        }
        std::process::exit(1);
    }

    Ok(true)
}
