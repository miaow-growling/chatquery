use anyhow::{anyhow, Context, Result};
use clap::{Args, Subcommand};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use url::Url;

use crate::cli::env::{resolve_env_id, CliDbType};
use crate::cli::group::{resolve_group_id, resolve_group_id_in_env};
use crate::db::connection::{ConnectionConfig, ConnectionStore, DbType};
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct ConnArgs {
    #[command(subcommand)]
    pub action: ConnCommands,
}

#[derive(Subcommand, Debug)]
pub enum ConnCommands {
    /// 列出所有连接（出于安全，不包含明文密码）
    List(ConnListArgs),
    /// 添加一个数据库连接
    Add(ConnAddArgs),
    /// 测试连接连通性
    Test(ConnTestArgs),
    /// 删除指定连接
    Rm(ConnRmArgs),
    /// 导入外部连接配置（支持 Navicat XML/JSON、DataGrip dataSources.xml、URL 列表、YAML/JSON 备份）
    Import(ConnImportArgs),
    /// 导出本地连接配置（支持 YAML/JSON 格式，可带密码加密）
    Export(ConnExportArgs),
}

#[derive(Args, Debug)]
pub struct ConnImportArgs {
    /// 待导入的配置文件路径（支持 Navicat XML/JSON、DataGrip dataSources.xml、URL 列表、YAML/JSON 备份）
    pub file: String,
}

#[derive(Args, Debug)]
pub struct ConnExportArgs {
    /// 导出保存的目标文件路径（若不传则输出至控制台）
    #[arg(long, short)]
    pub out: Option<String>,
    /// 是否以明文导出密码（默认使用 system-key 加密导出）
    #[arg(long)]
    pub plaintext: bool,
}

#[derive(Args, Debug)]
pub struct ConnListArgs {
    /// 按环境筛选（环境名称或 ID）
    #[arg(long)]
    pub env: Option<String>,
    /// 按分组筛选（分组名称或 ID）
    #[arg(long)]
    pub group: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub struct ConnAddArgs {
    /// 连接名称
    #[arg(long)]
    pub name: String,
    /// 连接 URL / DSN（支持 mysql://user:pass@host:port/db 或 redis://:pass@host:port/db）
    #[arg(long)]
    pub url: Option<String>,
    /// 数据库类型 (mysql | redis)
    #[arg(long, value_enum)]
    pub r#type: Option<CliDbType>,
    /// 主机地址
    #[arg(long)]
    pub host: Option<String>,
    /// 端口
    #[arg(long)]
    pub port: Option<u16>,
    /// 用户名
    #[arg(long)]
    pub user: Option<String>,
    /// 密码
    #[arg(long)]
    pub password: Option<String>,
    /// 默认数据库 / Redis DB 序号
    #[arg(long)]
    pub database: Option<String>,

    /// 所属环境名称或 ID
    #[arg(long)]
    pub env: Option<String>,
    /// 所属分组名称或 ID
    #[arg(long)]
    pub group: Option<String>,
    /// 若指定的环境或分组不存在，自动创建（适合 AI 自动化执行）
    #[arg(long)]
    pub create_parents: bool,

    /// 添加前先测试连通性，连通失败则不添加并报错
    #[arg(long)]
    pub test: bool,

    // SSH 跳板机
    #[arg(long)]
    pub ssh_host: Option<String>,
    #[arg(long, default_value_t = 22)]
    pub ssh_port: u16,
    #[arg(long)]
    pub ssh_user: Option<String>,
    #[arg(long)]
    pub ssh_key: Option<String>,
    #[arg(long)]
    pub ssh_password: Option<String>,

    // SSL
    #[arg(long, default_value = "")]
    pub ssl_mode: String,
    #[arg(long, default_value = "")]
    pub ssl_ca: String,
    #[arg(long, default_value = "")]
    pub client_cert: String,
    #[arg(long, default_value = "")]
    pub client_key: String,
}

#[derive(Args, Debug)]
pub struct ConnTestArgs {
    /// 连接 ID 或名称
    pub id_or_name: String,
}

#[derive(Args, Debug)]
pub struct ConnRmArgs {
    /// 连接 ID 或名称
    pub id_or_name: String,
}

#[derive(Serialize)]
pub struct ConnSummaryItem {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub env_name: String,
    pub group_name: String,
}

pub async fn handle(args: ConnArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let mut store = ConnectionStore::load(storage)?;

    match args.action {
        ConnCommands::List(l) => {
            let containers = store.list_containers();
            let conns = store.list();

            let filter_env_id = match l.env {
                Some(ref e) => Some(resolve_env_id(&store, e)?),
                None => None,
            };
            let filter_group_id = match l.group {
                Some(ref g) => Some(resolve_group_id(&store, g)?),
                None => None,
            };

            let mut list = Vec::new();
            for c in conns {
                if let Some(ref gid) = filter_group_id {
                    if c.group_id.as_deref() != Some(gid.as_str()) {
                        continue;
                    }
                }

                let (env_name, group_name) = match &c.group_id {
                    Some(gid) => {
                        let g = containers.iter().find(|cnt| cnt.id == *gid);
                        let g_name = g.map(|cnt| cnt.name.clone()).unwrap_or_default();
                        let e_name = g
                            .and_then(|cnt| cnt.parent.as_ref())
                            .and_then(|pid| containers.iter().find(|cnt| cnt.id == *pid))
                            .map(|cnt| cnt.name.clone())
                            .unwrap_or_else(|| "未指定环境".to_string());
                        (e_name, g_name)
                    }
                    None => ("未分组".to_string(), "未分组".to_string()),
                };

                if let Some(ref eid) = filter_env_id {
                    let matches_env = c
                        .group_id
                        .as_deref()
                        .and_then(|gid| containers.iter().find(|cnt| cnt.id == gid))
                        .and_then(|g| g.parent.as_ref())
                        .map(|pid| pid == eid)
                        .unwrap_or(false);
                    if !matches_env {
                        continue;
                    }
                }

                let db_type_str = match c.db_type {
                    DbType::Mysql => "mysql",
                    DbType::Redis => "redis",
                };

                list.push(ConnSummaryItem {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    db_type: db_type_str.to_string(),
                    host: c.host.clone(),
                    port: c.port,
                    user: c.user.clone(),
                    database: c.database.clone(),
                    env_name,
                    group_name,
                });
            }

            if json_output {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                if list.is_empty() {
                    println!("暂无连接数据");
                    return Ok(());
                }
                println!(
                    "{:<14} {:<16} {:<8} {:<20} {:<6} {:<12} {:<12}",
                    "ID", "名称", "类型", "Host", "Port", "环境", "分组"
                );
                println!("{}", "-".repeat(90));
                for item in list {
                    println!(
                        "{:<14} {:<16} {:<8} {:<20} {:<6} {:<12} {:<12}",
                        item.id,
                        item.name,
                        item.db_type,
                        item.host,
                        item.port,
                        item.env_name,
                        item.group_name
                    );
                }
            }
        }
        ConnCommands::Add(a) => {
            let mut cfg = build_conn_config(&a)?;

            // 不创建任何持久化父级，先解析已有容器并验证输入。
            let existing_env_id = match a.env.as_deref() {
                Some(env) if !a.create_parents => {
                    let env_id = resolve_env_id(&store, env)
                        .context("指定的环境不存在。若需自动创建，请添加 --create-parents 参数")?;
                    let env_node = store
                        .list_containers()
                        .iter()
                        .find(|c| c.id == env_id)
                        .expect("resolved environment must exist");
                    if env_node.db_type.unwrap_or(DbType::Mysql) != cfg.db_type {
                        return Err(anyhow!("连接类型与指定环境的数据库类型不一致"));
                    }
                    Some(env_id)
                }
                _ => None,
            };

            if !a.create_parents {
                if let Some(ref group_arg) = a.group {
                    let group_id =
                        resolve_group_id_in_env(&store, group_arg, existing_env_id.as_deref())?;
                    let group = store
                        .list_containers()
                        .iter()
                        .find(|c| c.id == group_id)
                        .expect("resolved group must exist");
                    let env = group
                        .parent
                        .as_deref()
                        .and_then(|id| store.list_containers().iter().find(|c| c.id == id))
                        .ok_or_else(|| anyhow!("分组缺少有效的所属环境"))?;
                    if env.db_type.unwrap_or(DbType::Mysql) != cfg.db_type {
                        return Err(anyhow!("连接类型与分组所属环境的数据库类型不一致"));
                    }
                    cfg.group_id = Some(group_id);
                } else if a.env.is_some() {
                    return Err(anyhow!(
                        "仅指定环境时无法直接挂载连接；请同时指定 --group，或使用 --create-parents 创建默认分组"
                    ));
                }
            }

            // 连接测试必须先于环境/分组创建，失败时不留下空容器。
            if a.test {
                eprintln!("正在测试连接 {} ({}:{})...", cfg.name, cfg.host, cfg.port);
                test_raw_conn(&cfg).await.context("连接测试失败")?;
                eprintln!("✓ 连通性测试通过");
            }

            if a.create_parents && (a.env.is_some() || a.group.is_some()) {
                let env_name = a.env.as_deref().unwrap_or("默认环境");
                let group_name = a.group.as_deref().unwrap_or("默认分组");
                let env_id = store.ensure_env(env_name, Some(cfg.db_type))?;
                cfg.group_id = Some(store.ensure_group(&env_id, group_name)?);
            }

            if cfg.id.is_empty() {
                cfg.id = crate::db::container::gen_id("c");
            }
            store.add(cfg.clone())?;

            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": cfg.id,
                        "name": cfg.name,
                        "db_type": match cfg.db_type { DbType::Mysql => "mysql", DbType::Redis => "redis" },
                        "host": cfg.host,
                        "port": cfg.port,
                        "database": cfg.database,
                        "group_id": cfg.group_id,
                    }))?
                );
            } else {
                println!("✓ 连接已保存: {} (ID: {})", cfg.name, cfg.id);
            }
        }
        ConnCommands::Test(t) => {
            let cfg = resolve_conn(&store, &t.id_or_name)?;
            eprintln!("正在测试连接 {} ({}:{})...", cfg.name, cfg.host, cfg.port);
            test_raw_conn(&cfg).await?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": cfg.id,
                        "name": cfg.name,
                        "connected": true,
                    }))?
                );
            } else {
                println!("✓ 连接成功: {} ({}:{})", cfg.name, cfg.host, cfg.port);
            }
        }
        ConnCommands::Rm(r) => {
            let cfg = resolve_conn(&store, &r.id_or_name)?;
            store.remove(&cfg.id)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": cfg.id,
                    }))?
                );
            } else {
                println!("✓ 连接已删除: {} (ID: {})", cfg.name, cfg.id);
            }
        }
        ConnCommands::Import(imp) => {
            let path = std::path::Path::new(&imp.file);
            let content = std::fs::read_to_string(path)
                .with_context(|| format!("无法读取文件: {}", imp.file))?;
            let res = crate::db::importexport::import_yaml(&mut store, &content)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "connections_added": res.connections_added,
                        "connections_updated": res.connections_updated,
                        "containers_added": res.containers_added,
                        "passwords_needed": res.passwords_needed,
                        "skipped": res.skipped,
                    }))?
                );
            } else {
                println!("✓ 导入成功：");
                println!("  - 新增连接数: {}", res.connections_added);
                if res.connections_updated > 0 {
                    println!("  - 更新/去重连接数: {}", res.connections_updated);
                }
                println!("  - 新增环境/分组数: {}", res.containers_added);
                if !res.passwords_needed.is_empty() {
                    println!(
                        "  - 需补充密码的连接 ({} 个): {}",
                        res.passwords_needed.len(),
                        res.passwords_needed.join(", ")
                    );
                }
                if !res.skipped.is_empty() {
                    println!(
                        "  - 跳过的条目 ({} 个): {}",
                        res.skipped.len(),
                        res.skipped.join(", ")
                    );
                }
            }
        }
        ConnCommands::Export(exp) => {
            let cipher = if exp.plaintext { "none" } else { "system-key" };
            let yaml_str = crate::db::importexport::export_yaml(&store, cipher)?;
            if let Some(out_path) = exp.out {
                std::fs::write(&out_path, &yaml_str)
                    .with_context(|| format!("写入导出文件失败: {}", out_path))?;
                if json_output {
                    println!(
                        "{}",
                        serde_json::json!({
                            "ok": true,
                            "file": out_path,
                            "cipher": cipher,
                        })
                    );
                } else {
                    println!("✓ 成功导出连接配置至: {} (加密模式: {})", out_path, cipher);
                }
            } else if json_output {
                let val: serde_json::Value = serde_yaml::from_str(&yaml_str)?;
                println!("{}", serde_json::to_string_pretty(&val)?);
            } else {
                println!("{}", yaml_str);
            }
        }
    }

    Ok(())
}

pub fn resolve_conn(store: &ConnectionStore, id_or_name: &str) -> Result<ConnectionConfig> {
    if let Some(c) = store.list().iter().find(|c| c.id == id_or_name) {
        return Ok(c.clone());
    }
    let matches: Vec<_> = store
        .list()
        .iter()
        .filter(|c| c.name == id_or_name)
        .collect();
    match matches.as_slice() {
        [c] => Ok((*c).clone()),
        [] => Err(anyhow!("找不到名为或ID为 '{}' 的连接", id_or_name)),
        _ => Err(anyhow!("连接名称 '{}' 存在重名，请改用连接 ID", id_or_name)),
    }
}

pub async fn test_raw_conn(cfg: &ConnectionConfig) -> Result<()> {
    match cfg.db_type {
        DbType::Mysql => crate::db::mysql::test(cfg)
            .await
            .map_err(|e| anyhow!(e.to_string())),
        DbType::Redis => crate::db::redis::test(cfg)
            .await
            .map_err(|e| anyhow!(e.to_string())),
    }
}

pub fn build_conn_config(a: &ConnAddArgs) -> Result<ConnectionConfig> {
    let mut base = if let Some(ref url) = a.url {
        parse_dsn(url)?
    } else {
        ConnectionConfig {
            id: String::new(),
            name: a.name.clone(),
            db_type: a.r#type.map(|t| t.into()).unwrap_or(DbType::Mysql),
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: String::new(),
            ssl_mode: String::new(),
            ssl_ca: String::new(),
            client_cert: String::new(),
            client_key: String::new(),
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_auth_kind: String::new(),
            ssh_password: String::new(),
            ssh_private_key: String::new(),
            group_id: None,
        }
    };

    base.name = a.name.clone();
    if let Some(t) = a.r#type {
        base.db_type = t.into();
    }
    if let Some(ref h) = a.host {
        base.host = h.clone();
    }
    if let Some(p) = a.port {
        base.port = p;
    }
    if let Some(ref u) = a.user {
        base.user = u.clone();
    }
    if let Some(ref p) = a.password {
        base.password = p.clone();
    }
    if let Some(ref d) = a.database {
        base.database = d.clone();
    }
    if base.port == 0 {
        base.port = base.db_type.default_port();
    }
    if base.host.is_empty() {
        return Err(anyhow!("必须指定主机地址 (--host 或在 --url 中包含)"));
    }

    // SSH
    if let Some(ref sh) = a.ssh_host {
        base.ssh_host = sh.clone();
        base.ssh_port = a.ssh_port;
        base.ssh_user = a.ssh_user.clone().unwrap_or_default();
        if let Some(ref key) = a.ssh_key {
            base.ssh_auth_kind = "key".to_string();
            base.ssh_private_key = key.clone();
        } else if let Some(ref pass) = a.ssh_password {
            base.ssh_auth_kind = "password".to_string();
            base.ssh_password = pass.clone();
        }
    }

    // SSL
    base.ssl_mode = a.ssl_mode.clone();
    base.ssl_ca = a.ssl_ca.clone();
    base.client_cert = a.client_cert.clone();
    base.client_key = a.client_key.clone();

    Ok(base)
}

/// 解析标准 mysql:// 或 redis:// URL。错误消息不会回显包含密码的原始 URL。
pub fn parse_dsn(url_str: &str) -> Result<ConnectionConfig> {
    let parsed = Url::parse(url_str).map_err(|_| anyhow!("无法解析连接字符串，请检查 URL 格式"))?;
    let db_type = match parsed.scheme().to_ascii_lowercase().as_str() {
        "mysql" => DbType::Mysql,
        "redis" => DbType::Redis,
        _ => return Err(anyhow!("仅支持 mysql:// 和 redis:// 连接字符串")),
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("连接字符串缺少主机地址"))?
        .to_string();
    let port = parsed.port().unwrap_or_else(|| db_type.default_port());
    let decode = |value: &str| -> Result<String> {
        percent_decode_str(value)
            .decode_utf8()
            .map(|v| v.into_owned())
            .map_err(|_| anyhow!("连接字符串包含无效的百分号编码"))
    };
    let user = decode(parsed.username())?;
    let password = decode(parsed.password().unwrap_or(""))?;
    let database = decode(parsed.path().trim_start_matches('/'))?;

    Ok(ConnectionConfig {
        id: String::new(),
        name: String::new(),
        db_type,
        host,
        port,
        user,
        password,
        database,
        ssl_mode: String::new(),
        ssl_ca: String::new(),
        client_cert: String::new(),
        client_key: String::new(),
        ssh_host: String::new(),
        ssh_port: 22,
        ssh_user: String::new(),
        ssh_auth_kind: String::new(),
        ssh_password: String::new(),
        ssh_private_key: String::new(),
        group_id: None,
    })
}
