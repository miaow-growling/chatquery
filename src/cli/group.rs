use anyhow::{anyhow, Result};
use clap::{Args, Subcommand};
use serde::Serialize;

use crate::cli::env::resolve_env_id;
use crate::db::connection::ConnectionStore;
use crate::db::container::ContainerKind;
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct GroupArgs {
    #[command(subcommand)]
    pub action: GroupCommands,
}

#[derive(Subcommand, Debug)]
pub enum GroupCommands {
    /// 列出分组
    List(GroupListArgs),
    /// 在指定环境下添加一个分组
    Add(GroupAddArgs),
    /// 重命名分组
    Rename(GroupRenameArgs),
    /// 删除分组
    Rm(GroupRmArgs),
}

#[derive(Args, Debug)]
pub struct GroupListArgs {
    /// 按环境筛选（环境名称或 ID）
    #[arg(long)]
    pub env: Option<String>,
}

#[derive(Args, Debug)]
pub struct GroupAddArgs {
    /// 分组名称
    pub name: String,
    /// 所属环境（环境名称或 ID）
    #[arg(long)]
    pub env: String,
}

#[derive(Args, Debug)]
pub struct GroupRenameArgs {
    /// 分组 ID 或名称
    pub id_or_name: String,
    /// 新名称
    pub new_name: String,
}

#[derive(Args, Debug)]
pub struct GroupRmArgs {
    /// 分组 ID 或名称
    pub id_or_name: String,
    /// 强制删除（如果分组内包含数据库连接）
    #[arg(long, short)]
    pub force: bool,
}

#[derive(Serialize)]
pub struct GroupItem {
    pub id: String,
    pub name: String,
    pub env_id: String,
    pub env_name: String,
    pub connection_count: usize,
}

pub fn handle(args: GroupArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let mut store = ConnectionStore::load(storage)?;

    match args.action {
        GroupCommands::List(l) => {
            let filter_env_id = match l.env {
                Some(ref e) => Some(resolve_env_id(&store, e)?),
                None => None,
            };

            let containers = store.list_containers();
            let conns = store.list();
            let mut list = Vec::new();

            for grp in containers.iter().filter(|c| c.kind == ContainerKind::Group) {
                if let Some(ref target_env_id) = filter_env_id {
                    if grp.parent.as_deref() != Some(target_env_id.as_str()) {
                        continue;
                    }
                }
                let env_name = grp
                    .parent
                    .as_deref()
                    .and_then(|pid| {
                        containers
                            .iter()
                            .find(|c| c.id == pid)
                            .map(|c| c.name.clone())
                    })
                    .unwrap_or_else(|| "未知环境".to_string());

                let connection_count = conns
                    .iter()
                    .filter(|c| c.group_id.as_deref() == Some(&grp.id))
                    .count();

                list.push(GroupItem {
                    id: grp.id.clone(),
                    name: grp.name.clone(),
                    env_id: grp.parent.clone().unwrap_or_default(),
                    env_name,
                    connection_count,
                });
            }

            if json_output {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else {
                if list.is_empty() {
                    println!("暂无分组数据");
                    return Ok(());
                }
                println!(
                    "{:<16} {:<16} {:<16} {:<8}",
                    "ID", "分组名称", "所属环境", "连接数"
                );
                println!("{}", "-".repeat(60));
                for item in list {
                    println!(
                        "{:<16} {:<16} {:<16} {:<8}",
                        item.id, item.name, item.env_name, item.connection_count
                    );
                }
            }
        }
        GroupCommands::Add(a) => {
            let env_id = resolve_env_id(&store, &a.env)?;
            let id = store.create_group(&env_id, &a.name)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": id,
                        "name": a.name,
                        "env_id": env_id,
                    }))?
                );
            } else {
                println!(
                    "✓ 分组已创建: {} (ID: {}, 所属环境: {})",
                    a.name, id, env_id
                );
            }
        }
        GroupCommands::Rename(r) => {
            let grp_id = resolve_group_id(&store, &r.id_or_name)?;
            store.rename_container(&grp_id, &r.new_name)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": grp_id,
                        "new_name": r.new_name,
                    }))?
                );
            } else {
                println!("✓ 分组已重命名为: {}", r.new_name);
            }
        }
        GroupCommands::Rm(rm) => {
            let grp_id = resolve_group_id(&store, &rm.id_or_name)?;
            let conns_in_grp: Vec<String> = store
                .list()
                .iter()
                .filter(|c| c.group_id.as_deref() == Some(&grp_id))
                .map(|c| c.id.clone())
                .collect();

            if !conns_in_grp.is_empty() && !rm.force {
                return Err(anyhow!(
                    "该分组下仍包含 {} 个连接。如确认一同删除，请添加 --force 参数",
                    conns_in_grp.len()
                ));
            }
            if rm.force {
                store.delete_topology_force(&conns_in_grp, std::slice::from_ref(&grp_id))?;
            } else {
                store.delete_container(&grp_id)?;
            }
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "id": grp_id,
                    }))?
                );
            } else {
                println!("✓ 分组已删除: {}", grp_id);
            }
        }
    }

    Ok(())
}

pub fn resolve_group_id(store: &ConnectionStore, id_or_name: &str) -> Result<String> {
    resolve_group_id_in_env(store, id_or_name, None)
}

pub fn resolve_group_id_in_env(
    store: &ConnectionStore,
    id_or_name: &str,
    env_id: Option<&str>,
) -> Result<String> {
    if let Some(c) = store.list_containers().iter().find(|c| {
        c.kind == ContainerKind::Group
            && c.id == id_or_name
            && env_id
                .map(|id| c.parent.as_deref() == Some(id))
                .unwrap_or(true)
    }) {
        return Ok(c.id.clone());
    }
    let matches: Vec<_> = store
        .list_containers()
        .iter()
        .filter(|c| {
            c.kind == ContainerKind::Group
                && c.name == id_or_name
                && env_id
                    .map(|id| c.parent.as_deref() == Some(id))
                    .unwrap_or(true)
        })
        .collect();
    match matches.as_slice() {
        [c] => Ok(c.id.clone()),
        [] => Err(anyhow!("找不到名为或ID为 '{}' 的分组", id_or_name)),
        _ => Err(anyhow!(
            "分组名称 '{}' 存在重名，请指定环境或改用分组 ID",
            id_or_name
        )),
    }
}
