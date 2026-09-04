use anyhow::Result;
use clap::Args;
use serde::Serialize;

use crate::db::connection::{ConnectionStore, DbType};
use crate::db::container::ContainerKind;
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct TreeArgs {}

#[derive(Serialize)]
pub struct TreeOutput {
    pub mysql: Vec<TreeEnvNode>,
    pub redis: Vec<TreeEnvNode>,
}

#[derive(Serialize)]
pub struct TreeEnvNode {
    pub env_id: String,
    pub env_name: String,
    pub groups: Vec<TreeGroupNode>,
}

#[derive(Serialize)]
pub struct TreeGroupNode {
    pub group_id: String,
    pub group_name: String,
    pub connections: Vec<TreeConnNode>,
}

#[derive(Serialize)]
pub struct TreeConnNode {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub database: String,
}

pub fn build_topology(store: &ConnectionStore) -> TreeOutput {
    let containers = store.list_containers();
    let conns = store.list();
    let mut mysql_envs = Vec::new();
    let mut redis_envs = Vec::new();

    for env in containers.iter().filter(|c| c.kind == ContainerKind::Env) {
        let mut groups = Vec::new();
        for g in containers
            .iter()
            .filter(|c| c.kind == ContainerKind::Group && c.parent.as_deref() == Some(&env.id))
        {
            let group_conns: Vec<TreeConnNode> = conns
                .iter()
                .filter(|c| c.group_id.as_deref() == Some(&g.id))
                .map(|c| TreeConnNode {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    db_type: match c.db_type {
                        DbType::Mysql => "mysql",
                        DbType::Redis => "redis",
                    }
                    .to_string(),
                    host: c.host.clone(),
                    port: c.port,
                    database: c.database.clone(),
                })
                .collect();

            groups.push(TreeGroupNode {
                group_id: g.id.clone(),
                group_name: g.name.clone(),
                connections: group_conns,
            });
        }

        let node = TreeEnvNode {
            env_id: env.id.clone(),
            env_name: env.name.clone(),
            groups,
        };

        if env.db_type == Some(DbType::Redis) {
            redis_envs.push(node);
        } else {
            mysql_envs.push(node);
        }
    }

    // 未分组连接
    let ungrouped_mysql: Vec<TreeConnNode> = conns
        .iter()
        .filter(|c| c.group_id.is_none() && c.db_type == DbType::Mysql)
        .map(|c| TreeConnNode {
            id: c.id.clone(),
            name: c.name.clone(),
            db_type: match c.db_type {
                DbType::Mysql => "mysql",
                DbType::Redis => "redis",
            }
            .to_string(),
            host: c.host.clone(),
            port: c.port,
            database: c.database.clone(),
        })
        .collect();

    if !ungrouped_mysql.is_empty() {
        mysql_envs.push(TreeEnvNode {
            env_id: "__ungrouped".to_string(),
            env_name: "未分组".to_string(),
            groups: vec![TreeGroupNode {
                group_id: "__ungrouped".to_string(),
                group_name: "未分组".to_string(),
                connections: ungrouped_mysql,
            }],
        });
    }

    let ungrouped_redis: Vec<TreeConnNode> = conns
        .iter()
        .filter(|c| c.group_id.is_none() && c.db_type == DbType::Redis)
        .map(|c| TreeConnNode {
            id: c.id.clone(),
            name: c.name.clone(),
            db_type: match c.db_type {
                DbType::Mysql => "mysql",
                DbType::Redis => "redis",
            }
            .to_string(),
            host: c.host.clone(),
            port: c.port,
            database: c.database.clone(),
        })
        .collect();

    if !ungrouped_redis.is_empty() {
        redis_envs.push(TreeEnvNode {
            env_id: "__ungrouped".to_string(),
            env_name: "未分组".to_string(),
            groups: vec![TreeGroupNode {
                group_id: "__ungrouped".to_string(),
                group_name: "未分组".to_string(),
                connections: ungrouped_redis,
            }],
        });
    }

    TreeOutput {
        mysql: mysql_envs,
        redis: redis_envs,
    }
}

pub fn handle(_args: TreeArgs, json_output: bool) -> Result<()> {
    let storage = Storage::open()?;
    let store = ConnectionStore::load(storage)?;
    let output = build_topology(&store);
    if json_output {
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        println!("MySQL");
        print_tree_envs(&output.mysql);
        println!("\nRedis");
        print_tree_envs(&output.redis);
    }
    Ok(())
}

fn print_tree_envs(envs: &[TreeEnvNode]) {
    if envs.is_empty() {
        println!("  └── (空)");
        return;
    }
    for (i, env) in envs.iter().enumerate() {
        let is_last_env = i == envs.len() - 1;
        let env_prefix = if is_last_env {
            "└──"
        } else {
            "├──"
        };
        println!("{} 📁 {} ({})", env_prefix, env.env_name, env.env_id);

        let indent = if is_last_env { "    " } else { "│   " };
        for (j, grp) in env.groups.iter().enumerate() {
            let is_last_grp = j == env.groups.len() - 1;
            let grp_prefix = if is_last_grp {
                "└──"
            } else {
                "├──"
            };
            println!(
                "{}{} 📁 {} ({})",
                indent, grp_prefix, grp.group_name, grp.group_id
            );

            let sub_indent = format!("{}{}", indent, if is_last_grp { "    " } else { "│   " });
            for (k, conn) in grp.connections.iter().enumerate() {
                let is_last_conn = k == grp.connections.len() - 1;
                let conn_prefix = if is_last_conn {
                    "└──"
                } else {
                    "├──"
                };
                let db_info = if conn.database.is_empty() {
                    format!("{}:{}", conn.host, conn.port)
                } else {
                    format!("{}:{}/{}", conn.host, conn.port, conn.database)
                };
                println!(
                    "{}{}{} 🔌 {} [{}]",
                    sub_indent, conn_prefix, conn.name, conn.id, db_info
                );
            }
        }
    }
}
