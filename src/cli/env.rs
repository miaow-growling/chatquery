use anyhow::{anyhow, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use crate::db::connection::{ConnectionStore, DbType};
use crate::db::container::ContainerKind;
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct EnvArgs {
    #[command(subcommand)]
    pub action: EnvCommands,
}

#[derive(Subcommand, Debug)]
pub enum EnvCommands {
    /// 列出所有环境
    List(EnvListArgs),
    /// 添加一个环境
    Add(EnvAddArgs),
    /// 重命名环境
    Rename(EnvRenameArgs),
    /// 删除环境
    Rm(EnvRmArgs),
}

#[derive(Args, Debug)]
pub struct EnvListArgs {
    /// 筛选数据库类型 (mysql | redis)
    #[arg(long, value_enum)]
    pub r#type: Option<CliDbType>,
}

#[derive(Args, Debug)]
pub struct EnvAddArgs {
    /// 环境名称
    pub name: String,
    /// 绑定的数据库类型 (mysql | redis)
    #[arg(long, value_enum, default_value = "mysql")]
    pub r#type: CliDbType,
}

#[derive(Args, Debug)]
pub struct EnvRenameArgs {
    /// 环境 ID 或名称
    pub id_or_name: String,
    /// 新名称
    pub new_name: String,
}

#[derive(Args, Debug)]
pub struct EnvRmArgs {
    /// 环境 ID 或名称
    pub id_or_name: String,
    /// 强制删除（如果包含分组或连接时）
    #[arg(long, short)]
    pub force: bool,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CliDbType {
    Mysql,
    Redis,
}

impl From<CliDbType> for DbType {
    fn from(v: CliDbType) -> Self {
        match v {
            CliDbType::Mysql => DbType::Mysql,
            CliDbType::Redis => DbType::Redis,
        }
    }
}

impl From<DbType> for CliDbType {
    fn from(v: DbType) -> Self {
        match v {
            DbType::Mysql => CliDbType::Mysql,
            DbType::Redis => CliDbType::Redis,
        }
    }
}

#[derive(Serialize)]
pub struct EnvItem {
    pub id: String,
    pub name: String,
    pub db_type: CliDbType,
    pub group_count: usize,
}

pub fn handle(args: EnvArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let mut store = ConnectionStore::load(storage)?;

    match args.action {
        EnvCommands::List(l) => {
            let containers = store.list_containers();
            let mut list = Vec::new();
            for env in containers.iter().filter(|c| c.kind == ContainerKind::Env) {
                let env_type = env.db_type.unwrap_or(DbType::Mysql);
                if let Some(target_type) = l.r#type {
                    if env_type != target_type.into() {
                        continue;
                    }
                }
                let group_count = containers
                    .iter()
                    .filter(|c| {
                        c.kind == ContainerKind::Group && c.parent.as_deref() == Some(&env.id)
                    })
                    .count();
                list.push(EnvItem {
                    id: env.id.clone(),
                    name: env.name.clone(),
                    db_type: env_type.into(),
                    group_count,
                });
            }

            if json_output {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                if list.is_empty() {
                    println!("暂无环境数据");
                    return Ok(());
                }
                println!("{:<16} {:<16} {:<10} {:<8}", "ID", "名称", "类型", "分组数");
                println!("{}", "-".repeat(54));
                for item in list {
                    let type_str = match item.db_type {
                        CliDbType::Mysql => "mysql",
                        CliDbType::Redis => "redis",
                    };
                    println!(
                        "{:<16} {:<16} {:<10} {:<8}",
                        item.id, item.name, type_str, item.group_count
                    );
                }
            }
        }
        EnvCommands::Add(a) => {
            let db_type: DbType = a.r#type.into();
            let id = store.create_env(&a.name, Some(db_type))?;
            if json_output {
                let res = serde_json::json!({
                    "ok": true,
                    "id": id,
                    "name": a.name,
                    "type": a.r#type,
                });
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                println!("✓ 环境已创建: {} (ID: {})", a.name, id);
            }
        }
        EnvCommands::Rename(r) => {
            let env_id = resolve_env_id(&store, &r.id_or_name)?;
            store.rename_container(&env_id, &r.new_name)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": env_id,
                        "new_name": r.new_name,
                    }))?
                );
            } else {
                println!("✓ 环境已重命名为: {}", r.new_name);
            }
        }
        EnvCommands::Rm(rm) => {
            let env_id = resolve_env_id(&store, &rm.id_or_name)?;
            // 检查是否有子分组或连接
            if !rm.force {
                let has_groups = store.list_containers().iter().any(|c| {
                    c.kind == ContainerKind::Group && c.parent.as_deref() == Some(&env_id)
                });
                if has_groups {
                    return Err(anyhow!("该环境包含子分组。如确认删除，请添加 --force 参数"));
                }
                store.delete_container(&env_id)?;
            } else {
                let child_groups: Vec<String> = store
                    .list_containers()
                    .iter()
                    .filter(|c| {
                        c.kind == ContainerKind::Group && c.parent.as_deref() == Some(&env_id)
                    })
                    .map(|c| c.id.clone())
                    .collect();
                let conn_ids: Vec<String> = store
                    .list()
                    .iter()
                    .filter(|c| {
                        c.group_id
                            .as_ref()
                            .map(|gid| child_groups.contains(gid))
                            .unwrap_or(false)
                    })
                    .map(|c| c.id.clone())
                    .collect();
                let mut container_ids = child_groups;
                container_ids.push(env_id.clone());
                store.delete_topology_force(&conn_ids, &container_ids)?;
            }
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": env_id,
                    }))?
                );
            } else {
                println!("✓ 环境已删除: {}", env_id);
            }
        }
    }

    Ok(())
}

pub fn resolve_env_id(store: &ConnectionStore, id_or_name: &str) -> Result<String> {
    if let Some(c) = store
        .list_containers()
        .iter()
        .find(|c| c.kind == ContainerKind::Env && c.id == id_or_name)
    {
        return Ok(c.id.clone());
    }
    let matches: Vec<_> = store
        .list_containers()
        .iter()
        .filter(|c| c.kind == ContainerKind::Env && c.name == id_or_name)
        .collect();
    match matches.as_slice() {
        [c] => Ok(c.id.clone()),
        [] => Err(anyhow!("找不到名为或ID为 '{}' 的环境", id_or_name)),
        _ => Err(anyhow!("环境名称 '{}' 存在重名，请改用环境 ID", id_or_name)),
    }
}
