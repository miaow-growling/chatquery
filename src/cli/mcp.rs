use anyhow::Result;
use clap::Args;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::cli::conn::{parse_dsn, resolve_conn, test_raw_conn};
use crate::cli::env::resolve_env_id;
use crate::cli::group::resolve_group_id_in_env;
use crate::cli::tree::build_topology;
use crate::db::connection::{ConnectionConfig, ConnectionStore, DbType};
use crate::db::mysql::{self, is_read_query};
use crate::db::redis;
use crate::sql_guard;
use crate::store::Storage;

#[derive(Args, Debug)]
pub struct McpArgs {}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    #[serde(skip)]
    has_id: bool,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Serialize, Debug)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize, Debug)]
struct JsonRpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

pub async fn run(_args: McpArgs) -> Result<()> {
    eprintln!("[chatquery-mcp] Starting ChatQuery MCP Server (stdio mode)...");

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = reader.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let value: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[chatquery-mcp] Invalid JSON: {}", e);
                let out =
                    serde_json::to_string(&error_response(None, -32700, "Parse error"))? + "\n";
                stdout.write_all(out.as_bytes()).await?;
                stdout.flush().await?;
                continue;
            }
        };
        let request_id = value.get("id").cloned();
        let has_id = value.get("id").is_some();
        let mut req: JsonRpcRequest = match serde_json::from_value(value) {
            Ok(r) => r,
            Err(_) => {
                let out =
                    serde_json::to_string(&error_response(request_id, -32600, "Invalid Request"))?
                        + "\n";
                stdout.write_all(out.as_bytes()).await?;
                stdout.flush().await?;
                continue;
            }
        };
        req.has_id = has_id;

        // 处理请求
        let resp = handle_request(req).await;
        if let Some(r) = resp {
            let out = serde_json::to_string(&r)? + "\n";
            stdout.write_all(out.as_bytes()).await?;
            stdout.flush().await?;
        }
    }

    eprintln!("[chatquery-mcp] Stdin closed, exiting MCP server.");
    Ok(())
}

fn error_response(id: Option<Value>, code: i32, message: &str) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_string(),
            data: None,
        }),
    }
}

async fn handle_request(req: JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.clone();
    if !req.has_id {
        return None;
    }
    if req.jsonrpc != "2.0" {
        return Some(error_response(
            id,
            -32600,
            "Invalid Request: jsonrpc must be 2.0",
        ));
    }

    match req.method.as_str() {
        "initialize" => {
            let result = json!({
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "chatquery",
                    "version": "0.1.0"
                },
                "capabilities": {
                    "tools": {}
                }
            });
            Some(JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(result),
                error: None,
            })
        }
        "ping" => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(json!({})),
            error: None,
        }),
        "tools/list" => {
            let tools = list_mcp_tools();
            Some(JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(json!({ "tools": tools })),
                error: None,
            })
        }
        "tools/call" => {
            let params = req.params.unwrap_or(json!({}));
            let Some(tool_name) = params.get("name").and_then(|v| v.as_str()) else {
                return Some(error_response(
                    id,
                    -32602,
                    "Invalid params: missing tool name",
                ));
            };
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            if !args.is_object() {
                return Some(error_response(
                    id,
                    -32602,
                    "Invalid params: arguments must be an object",
                ));
            }

            match call_tool(tool_name, args).await {
                Ok(content_text) => Some(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: Some(json!({
                        "content": [
                            {
                                "type": "text",
                                "text": content_text
                            }
                        ]
                    })),
                    error: None,
                }),
                Err(e) => Some(JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id,
                    result: Some(json!({
                        "isError": true,
                        "content": [
                            {
                                "type": "text",
                                "text": format!("Error executing tool '{}': {}", tool_name, e)
                            }
                        ]
                    })),
                    error: None,
                }),
            }
        }
        _ => Some(JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("Method not found: {}", req.method),
                data: None,
            }),
        }),
    }
}

fn list_mcp_tools() -> Value {
    json!([
        {
            "name": "cq_list_topology",
            "description": "获取当前本地所有数据库资产拓扑树（按数据库类型、环境、分组组织的所有连接）",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "cq_add_connection",
            "description": "添加并持久化一个数据库连接到 ChatQuery 中（支持自动建环境/分组与连接测试）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "连接名称" },
                    "url": { "type": "string", "description": "连接字符串 (mysql://user:pass@host:port/db 或 redis://:pass@host:port/db)" },
                    "type": { "type": "string", "enum": ["mysql", "redis"], "description": "数据库类型" },
                    "host": { "type": "string", "description": "主机地址" },
                    "port": { "type": "integer", "description": "端口" },
                    "user": { "type": "string", "description": "用户名" },
                    "password": { "type": "string", "description": "密码" },
                    "database": { "type": "string", "description": "默认数据库" },
                    "env": { "type": "string", "description": "所属环境名称" },
                    "group": { "type": "string", "description": "所属分组名称" },
                    "create_parents": { "type": "boolean", "description": "若环境或分组不存在，是否自动创建（推荐 true）" },
                    "test": { "type": "boolean", "description": "是否先测试连通性，连通才存入（推荐 true）" }
                },
                "required": ["name"]
            }
        },
        {
            "name": "cq_add_environment",
            "description": "在 ChatQuery 中创建一个新的顶层环境（例如：生产环境、测试环境、本地开发）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "环境名称" },
                    "type": { "type": "string", "enum": ["mysql", "redis"], "description": "数据库类型" }
                },
                "required": ["name"]
            }
        },
        {
            "name": "cq_add_group",
            "description": "在指定环境下创建一个业务分组（例如：订单中心、用户服务）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "分组名称" },
                    "env": { "type": "string", "description": "所属环境名称或 ID" }
                },
                "required": ["name", "env"]
            }
        },
        {
            "name": "cq_list_tables",
            "description": "列出指定连接下的所有数据表及表注释",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "database": { "type": "string", "description": "可选指定数据库名" },
                    "filter": { "type": "string", "description": "模糊过滤关键词（如 order）" }
                },
                "required": ["connection"]
            }
        },
        {
            "name": "cq_search_tables",
            "description": "在库中全局模糊搜索数据表名、表注释、列名及列注释",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "keyword": { "type": "string", "description": "搜索关键词" },
                    "database": { "type": "string", "description": "可选指定数据库名" }
                },
                "required": ["connection", "keyword"]
            }
        },
        {
            "name": "cq_get_table_schema",
            "description": "获取指定表的字段明细、数据类型、主键、可空及默认值",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "tables": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "数据表名数组"
                    },
                    "database": { "type": "string", "description": "可选指定数据库名" }
                },
                "required": ["connection", "tables"]
            }
        },
        {
            "name": "cq_get_prompt_context",
            "description": "获取专为大模型 Prompt 优化精简的 Markdown 表结构（极致压缩 Token）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "tables": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "数据表名数组"
                    },
                    "database": { "type": "string", "description": "可选指定数据库名" }
                },
                "required": ["connection", "tables"]
            }
        },
        {
            "name": "cq_execute_query",
            "description": "在指定连接上执行只读 SQL 查询并返回结构化数据（默认只读，禁止破坏性写入）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "sql": { "type": "string", "description": "待执行的 SQL" },
                    "database": { "type": "string", "description": "可选指定数据库名" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "最大行数（默认 50）" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "cq_explain_query",
            "description": "分析 SQL 查询语句的执行计划（EXPLAIN 分析，诊断索引与扫描行数）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "sql": { "type": "string", "description": "待分析的 SELECT SQL" },
                    "database": { "type": "string", "description": "可选指定数据库名" }
                },
                "required": ["connection", "sql"]
            }
        },
        {
            "name": "cq_redis_get",
            "description": "读取 Redis 缓存键值（支持 PHP 反序列化）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "key": { "type": "string", "description": "Redis 键名" },
                    "db": { "type": "integer", "description": "DB 编号，默认 0" },
                    "unserialize_php": { "type": "boolean", "description": "是否自动进行 PHP 反序列化转 JSON" }
                },
                "required": ["connection", "key"]
            }
        }
    ])
}

async fn call_tool(name: &str, args: Value) -> Result<String> {
    let storage = Storage::open()?;
    let mut store = ConnectionStore::load(storage)?;

    match name {
        "cq_list_topology" => Ok(serde_json::to_string_pretty(&build_topology(&store))?),
        "cq_add_connection" => {
            let conn_name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 name 参数"))?;
            let url = args.get("url").and_then(|v| v.as_str());

            let mut cfg = if let Some(u) = url {
                parse_dsn(u)?
            } else {
                let host = args
                    .get("host")
                    .and_then(|v| v.as_str())
                    .unwrap_or("127.0.0.1");
                let user = args.get("user").and_then(|v| v.as_str()).unwrap_or("");
                let password = args.get("password").and_then(|v| v.as_str()).unwrap_or("");
                let database = args.get("database").and_then(|v| v.as_str()).unwrap_or("");
                let db_type = match args.get("type").and_then(|v| v.as_str()).unwrap_or("mysql") {
                    "redis" => DbType::Redis,
                    "mysql" => DbType::Mysql,
                    other => return Err(anyhow::anyhow!("不支持的连接类型: {}", other)),
                };
                let port_u64 = args
                    .get("port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(u64::from(db_type.default_port()));
                let port = u16::try_from(port_u64)
                    .map_err(|_| anyhow::anyhow!("port 必须在 1 到 65535 之间"))?;
                if port == 0 {
                    return Err(anyhow::anyhow!("port 必须在 1 到 65535 之间"));
                }
                ConnectionConfig {
                    id: String::new(),
                    name: conn_name.to_string(),
                    db_type,
                    host: host.to_string(),
                    port,
                    user: user.to_string(),
                    password: password.to_string(),
                    database: database.to_string(),
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
            cfg.name = conn_name.to_string();

            let create_parents = args
                .get("create_parents")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let env_arg = args.get("env").and_then(|v| v.as_str());
            let grp_arg = args.get("group").and_then(|v| v.as_str());

            let existing_env_id = if !create_parents {
                match env_arg {
                    Some(env) => {
                        let env_id = resolve_env_id(&store, env)?;
                        let env_node = store
                            .list_containers()
                            .iter()
                            .find(|c| c.id == env_id)
                            .expect("resolved environment must exist");
                        if env_node.db_type.unwrap_or(DbType::Mysql) != cfg.db_type {
                            return Err(anyhow::anyhow!("连接类型与指定环境的数据库类型不一致"));
                        }
                        Some(env_id)
                    }
                    None => None,
                }
            } else {
                None
            };
            if !create_parents {
                if let Some(grp) = grp_arg {
                    let group_id =
                        resolve_group_id_in_env(&store, grp, existing_env_id.as_deref())?;
                    let group = store
                        .list_containers()
                        .iter()
                        .find(|c| c.id == group_id)
                        .expect("resolved group must exist");
                    let env = group
                        .parent
                        .as_deref()
                        .and_then(|id| store.list_containers().iter().find(|c| c.id == id))
                        .ok_or_else(|| anyhow::anyhow!("分组缺少有效的所属环境"))?;
                    if env.db_type.unwrap_or(DbType::Mysql) != cfg.db_type {
                        return Err(anyhow::anyhow!("连接类型与分组所属环境的数据库类型不一致"));
                    }
                    cfg.group_id = Some(group_id);
                } else if env_arg.is_some() {
                    return Err(anyhow::anyhow!("指定环境时必须同时指定 group"));
                }
            }

            let test_conn = args.get("test").and_then(|v| v.as_bool()).unwrap_or(true);
            if test_conn {
                test_raw_conn(&cfg).await?;
            }

            if create_parents && (env_arg.is_some() || grp_arg.is_some()) {
                let env_id = store.ensure_env(env_arg.unwrap_or("默认环境"), Some(cfg.db_type))?;
                cfg.group_id = Some(store.ensure_group(&env_id, grp_arg.unwrap_or("默认分组"))?);
            }

            if cfg.id.is_empty() {
                cfg.id = crate::db::container::gen_id("c");
            }
            store.add(cfg.clone())?;
            Ok(format!("成功添加连接: {} (ID: {})", cfg.name, cfg.id))
        }
        "cq_add_environment" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 name"))?;
            let db_type = match args.get("type").and_then(|v| v.as_str()).unwrap_or("mysql") {
                "redis" => DbType::Redis,
                "mysql" => DbType::Mysql,
                other => return Err(anyhow::anyhow!("不支持的环境类型: {}", other)),
            };
            let id = store.create_env(name, Some(db_type))?;
            Ok(format!("环境创建成功: {} (ID: {})", name, id))
        }
        "cq_add_group" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 name"))?;
            let env = args
                .get("env")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 env"))?;
            let env_id = resolve_env_id(&store, env)?;
            let id = store.create_group(&env_id, name)?;
            Ok(format!(
                "分组创建成功: {} (ID: {}, 所属环境: {})",
                name, id, env_id
            ))
        }
        "cq_list_tables" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let cfg = resolve_conn(&store, conn)?;
            let target_db = args
                .get("database")
                .and_then(|v| v.as_str())
                .or(if cfg.database.is_empty() {
                    None
                } else {
                    Some(&cfg.database)
                })
                .ok_or_else(|| anyhow::anyhow!("未指定数据库名称"))?;
            let filter = args
                .get("filter")
                .and_then(|v| v.as_str())
                .map(|f| f.to_lowercase());

            let tables = mysql::list_tables(&cfg, target_db).await?;
            let matched: Vec<String> = tables
                .into_iter()
                .filter(|t| {
                    filter
                        .as_ref()
                        .map(|flt| t.name.to_lowercase().contains(flt))
                        .unwrap_or(true)
                })
                .map(|t| t.name)
                .collect();
            Ok(serde_json::to_string_pretty(&matched)?)
        }
        "cq_search_tables" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let kw = args
                .get("keyword")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 keyword"))?
                .to_lowercase();
            let cfg = resolve_conn(&store, conn)?;
            let target_db = args
                .get("database")
                .and_then(|v| v.as_str())
                .or(if cfg.database.is_empty() {
                    None
                } else {
                    Some(&cfg.database)
                })
                .ok_or_else(|| anyhow::anyhow!("未指定数据库名称"))?;

            let all_tables = mysql::list_tables(&cfg, target_db).await?;
            let mut matched_tables = Vec::new();
            let mut matched_columns = Vec::new();

            for tbl in all_tables {
                if tbl.name.to_lowercase().contains(&kw) {
                    matched_tables.push(tbl.name.clone());
                }
                if let Ok(cols) = mysql::list_columns(&cfg, target_db, &tbl.name).await {
                    for col in cols {
                        let hit_col = col.name.to_lowercase().contains(&kw);
                        let hit_comment = col
                            .comment
                            .as_deref()
                            .map(|c| c.to_lowercase().contains(&kw))
                            .unwrap_or(false);
                        if hit_col || hit_comment {
                            matched_columns.push(json!({
                                "table": tbl.name,
                                "column": col.name,
                                "comment": col.comment
                            }));
                        }
                    }
                }
            }
            Ok(serde_json::to_string_pretty(&json!({
                "matched_tables": matched_tables,
                "matched_columns": matched_columns
            }))?)
        }
        "cq_get_table_schema" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let tables = args
                .get("tables")
                .and_then(|v| v.as_array())
                .ok_or_else(|| anyhow::anyhow!("缺少 tables 数组"))?;
            let cfg = resolve_conn(&store, conn)?;
            let target_db = args
                .get("database")
                .and_then(|v| v.as_str())
                .or(if cfg.database.is_empty() {
                    None
                } else {
                    Some(&cfg.database)
                })
                .ok_or_else(|| anyhow::anyhow!("未指定数据库名称"))?;

            let mut out = Vec::new();
            for t_val in tables {
                let table_name = t_val
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("tables 中的每一项都必须是字符串"))?;
                let cols = mysql::list_columns(&cfg, target_db, table_name).await?;
                out.push(json!({
                    "table": table_name,
                    "columns": cols
                }));
            }
            Ok(serde_json::to_string_pretty(&out)?)
        }
        "cq_get_prompt_context" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let tables = args
                .get("tables")
                .and_then(|v| v.as_array())
                .ok_or_else(|| anyhow::anyhow!("缺少 tables 数组"))?;
            let cfg = resolve_conn(&store, conn)?;
            let target_db = args
                .get("database")
                .and_then(|v| v.as_str())
                .or(if cfg.database.is_empty() {
                    None
                } else {
                    Some(&cfg.database)
                })
                .ok_or_else(|| anyhow::anyhow!("未指定数据库名称"))?;

            let mut markdown = String::new();
            for t_val in tables {
                let table_name = t_val
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("tables 中的每一项都必须是字符串"))?;
                let cols = mysql::list_columns(&cfg, target_db, table_name).await?;
                markdown.push_str(&format!("### Table `{}`\n", table_name));
                for c in cols {
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
                    let comment_str = c
                        .comment
                        .as_deref()
                        .filter(|cm| !cm.trim().is_empty())
                        .map(|cm| format!(" ({})", cm.trim()))
                        .unwrap_or_default();

                    markdown.push_str(&format!(
                        "- `{}`: {}{}{}\n",
                        c.name, c.data_type, flag_str, comment_str
                    ));
                }
                markdown.push('\n');
            }
            Ok(markdown.trim().to_string())
        }
        "cq_execute_query" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let sql = args
                .get("sql")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 sql"))?
                .trim();
            if !mysql::is_single_statement(sql) {
                return Err(anyhow::anyhow!("MCP 每次只允许执行一条 SQL 语句"));
            }
            if !is_read_query(sql) || !sql_guard::analyze_write_sql(sql).is_empty() {
                return Err(anyhow::anyhow!(
                    "MCP 查询工具为永久只读模式，拒绝执行任何修改语句"
                ));
            }
            let cfg = resolve_conn(&store, conn)?;
            let target_db =
                args.get("database")
                    .and_then(|v| v.as_str())
                    .or(if cfg.database.is_empty() {
                        None
                    } else {
                        Some(&cfg.database)
                    });
            let limit_u64 = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50);
            if !(1..=1000).contains(&limit_u64) {
                return Err(anyhow::anyhow!("limit 必须在 1 到 1000 之间"));
            }
            let limit = limit_u64 as usize;

            let res = mysql::query_paged(&cfg, sql, target_db, 0, limit, false).await?;

            let out = json!({
                "columns": res.columns,
                "rows": res.rows,
                "affected_rows": res.affected,
                "total_rows": res.total,
            });
            Ok(serde_json::to_string_pretty(&out)?)
        }
        "cq_explain_query" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let sql = args
                .get("sql")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 sql"))?
                .trim();
            let cfg = resolve_conn(&store, conn)?;
            let target_db =
                args.get("database")
                    .and_then(|v| v.as_str())
                    .or(if cfg.database.is_empty() {
                        None
                    } else {
                        Some(&cfg.database)
                    });

            let explain_sql = format!("EXPLAIN {}", sql);
            let res = mysql::query(&cfg, &explain_sql, target_db, false).await?;
            let out = json!({
                "columns": res.columns,
                "rows": res.rows,
            });
            Ok(serde_json::to_string_pretty(&out)?)
        }
        "cq_redis_get" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 key"))?;
            let db_u64 = args.get("db").and_then(|v| v.as_u64()).unwrap_or(0);
            let db =
                u8::try_from(db_u64).map_err(|_| anyhow::anyhow!("db 必须在 0 到 255 之间"))?;
            let cfg = resolve_conn(&store, conn)?;
            if cfg.db_type != DbType::Redis {
                return Err(anyhow::anyhow!("该连接不是 Redis 类型"));
            }

            let res = redis::browse_key(&cfg, db, key).await?;
            let raw = res.lines.join("\n");
            if args
                .get("unserialize_php")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                crate::cli::redis::try_php_unserialize(&raw)
            } else {
                Ok(raw)
            }
        }
        other => Err(anyhow::anyhow!("未知的工具名称: {}", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn notifications_never_receive_responses() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            has_id: false,
            method: "tools/list".to_string(),
            params: None,
        };
        assert!(handle_request(req).await.is_none());
    }

    #[tokio::test]
    async fn explicit_null_id_is_still_a_request() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            has_id: true,
            method: "ping".to_string(),
            params: None,
        };
        assert!(handle_request(req).await.is_some());
    }

    #[tokio::test]
    async fn rejects_non_v2_jsonrpc() {
        let req = JsonRpcRequest {
            jsonrpc: "1.0".to_string(),
            id: Some(json!(1)),
            has_id: true,
            method: "ping".to_string(),
            params: None,
        };
        let response = handle_request(req).await.unwrap();
        assert_eq!(response.error.unwrap().code, -32600);
    }

    #[tokio::test]
    async fn tools_call_requires_name() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(1)),
            has_id: true,
            method: "tools/call".to_string(),
            params: Some(json!({"arguments": {}})),
        };
        let response = handle_request(req).await.unwrap();
        assert_eq!(response.error.unwrap().code, -32602);
    }
}
