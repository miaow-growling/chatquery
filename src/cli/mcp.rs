use anyhow::Result;
use clap::Args;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::cli::conn::{parse_dsn, resolve_conn, test_raw_conn};
use crate::cli::env::resolve_env_id;
use crate::cli::group::resolve_group_id_in_env;
use crate::cli::tree::build_topology;
use crate::db::connection::{ConnectionConfig, ConnectionStore, DbType};
use crate::db::mysql;
use crate::db::redis;
use crate::sql_guard::validate_mcp_query_safety;
use crate::store::Storage;

/// 记录在当前 MCP 会话进程中，哪些连接与库已经完成了上下文/记忆的阅读
static CHECKED_CONTEXTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub fn mark_context_checked(conn_id: &str, database: Option<&str>) {
    let db_str = database.filter(|s| !s.trim().is_empty()).unwrap_or("");
    let key = format!("{}:{}", conn_id, db_str);
    let mut set = CHECKED_CONTEXTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap();
    set.insert(key);
}

pub fn is_context_checked(conn_id: &str, database: Option<&str>) -> bool {
    let db_str = database.filter(|s| !s.trim().is_empty()).unwrap_or("");
    let key = format!("{}:{}", conn_id, db_str);
    let conn_all_key = format!("{}:", conn_id);
    let set = CHECKED_CONTEXTS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap();
    set.contains(&key) || set.contains(&conn_all_key)
}

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

fn format_diagnostic_error(
    tool: &str,
    args: &Value,
    err: &anyhow::Error,
    elapsed_ms: u128,
) -> String {
    let conn = args
        .get("connection")
        .and_then(|v| v.as_str())
        .unwrap_or("-");
    let err_str = err.to_string();

    let mut suggestions = Vec::new();
    if err_str.contains("Unknown column") || err_str.contains("1054") {
        suggestions.push("检测到列名不存在，请先调用 cq_get_prompt_context 获取真实字段定义，严禁臆测字段名");
    } else if err_str.contains("doesn't exist") || err_str.contains("1146") {
        suggestions.push("检测到表名不存在，请先调用 cq_list_tables 查询该库中真实存在的合法表名清单");
    } else if err_str.contains("Access denied") || err_str.contains("1045") {
        suggestions.push("数据库认证失败，请在 ChatQuery 中检查该连接的用户名与密码配置");
    } else if err_str.contains("Connection refused")
        || err_str.contains("timed out")
        || err_str.contains("PoolTimedOut")
    {
        suggestions.push("网络连通或连接池超时，请检查主机地址、端口、网络防火墙或 SSH 跳板机状态（已自动刷新连接池）");
    } else if err_str.contains("MCP 安全限制") {
        suggestions.push("MCP 处于纯只读保护模式，严禁任何 DML (增删改) 或 DDL 语句，仅允许数据查询 (SELECT/SHOW/EXPLAIN)");
    } else {
        suggestions.push("若持续失败，可调用 cq_list_topology 重新确认连接拓扑与环境状态");
    }

    format!(
        "【ChatQuery 工具执行错误诊断】\n\
         - 工具名称: {}\n\
         - 目标连接: {}\n\
         - 执行耗时: {}ms\n\
         - 错误原因: {}\n\
         - 修复建议: {}",
        tool,
        conn,
        elapsed_ms,
        err_str,
        suggestions.join("；\n             ")
    )
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
                "instructions": "【ChatQuery 数据库助手核心准则】\n\
                1. 【严禁盲猜表结构与字段】：编写或执行 SQL 前，必须先通过 `cq_list_tables` 查看表清单与中文表注释，并优先调用 `cq_get_prompt_context` 获取真实字段结构与注释。\n\
                2. 【必须严格遵守历史纠错记忆】：`cq_get_prompt_context` 与 `cq_list_memories` 会返回该数据库已沉淀的历史业务纠错规则与避坑指南（例如：「yk_config 表使用 code 字段而非 key」、「统计房产时必须排除测试项目」）。在生成 SQL 时必须严格遵守这些规则，绝不能重犯历史错误！\n\
                3. 【业务指标与口径检索】：当用户询问业务指标（如成交量、退款率、有效客户）或提到特定业务名词时，先调用 `cq_search_knowledge` 检索已绑定的业务知识库文档。\n\
                4. 【主动沉淀新规则】：当用户纠正了你的 SQL、指出字段错误或给出了新的业务规则时，请主动调用 `cq_add_memory` 将其沉淀到 ChatQuery 记忆库中。\n\
                5. 【安全只读】：所有 SQL 执行（`cq_execute_query`）均为只读模式，请务必添加合理的 LIMIT（默认 50）。",
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

            let timeout_duration =
                if tool_name == "cq_execute_query" || tool_name == "cq_explain_query" {
                    std::time::Duration::from_secs(20)
                } else {
                    std::time::Duration::from_secs(8)
                };

            let start_time = std::time::Instant::now();
            let call_future = call_tool(tool_name, args.clone());

            match tokio::time::timeout(timeout_duration, call_future).await {
                Ok(Ok(content_text)) => Some(JsonRpcResponse {
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
                Ok(Err(e)) => {
                    let elapsed = start_time.elapsed().as_millis();
                    let diag = format_diagnostic_error(tool_name, &args, &e, elapsed);
                    Some(JsonRpcResponse {
                        jsonrpc: "2.0".to_string(),
                        id,
                        result: Some(json!({
                            "isError": true,
                            "content": [
                                {
                                    "type": "text",
                                    "text": diag
                                }
                            ]
                        })),
                        error: None,
                    })
                }
                Err(_) => {
                    // 超时截断处理：若操作了连接，主动重置连接池避免死锁与脏连接复用
                    if let Some(conn) = args.get("connection").and_then(|v| v.as_str()) {
                        let target_db = args.get("database").and_then(|v| v.as_str()).unwrap_or("");
                        if let Ok(storage) = Storage::open() {
                            if let Ok(store) = ConnectionStore::load(storage) {
                                if let Ok(cfg) = crate::cli::conn::resolve_conn(&store, conn) {
                                    crate::db::mysql::invalidate_pool_cache(&cfg, target_db);
                                }
                            }
                        }
                    }
                    let diag = format!(
                        "【ChatQuery 超时截断与诊断】\n\
                         - 工具名称: {}\n\
                         - 执行状态: 耗时超过内部限制 ({}s) 已被主动截断\n\
                         - 自动处置: 已主动终止该耗时任务并物理重置底层连接池，断开异常套接字，防止死锁与脏连接污染后续查询\n\
                         - 诊断建议:\n\
                           1. 若为复杂 SQL 查询，请补充更精确的索引过滤条件（WHERE）或减小 LIMIT；\n\
                           2. 若网络抖动或正在锁表，可稍后重试或使用 cq_explain_query 分析执行计划；\n\
                           3. 可使用 cq_get_prompt_context 获取准确字段，避免无效的大范围扫描。",
                        tool_name,
                        timeout_duration.as_secs()
                    );
                    Some(JsonRpcResponse {
                        jsonrpc: "2.0".to_string(),
                        id,
                        result: Some(json!({
                            "isError": true,
                            "content": [
                                {
                                    "type": "text",
                                    "text": diag
                                }
                            ]
                        })),
                        error: None,
                    })
                }
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
            "description": "列出指定连接下的所有数据表、类型及表注释（支持按表名或表注释过滤）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "database": { "type": "string", "description": "可选指定数据库名" },
                    "filter": { "type": "string", "description": "模糊过滤关键词（如 order 或 中文表注释）" }
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
                    "keyword": { "type": "string", "description": "搜索关键词（支持表名、表注释、字段名、字段注释）" },
                    "database": { "type": "string", "description": "可选指定数据库名" }
                },
                "required": ["connection", "keyword"]
            }
        },
        {
            "name": "cq_get_table_schema",
            "description": "获取指定表的字段明细、数据类型、主键及默认值。返回数据中也会附带该库关联的纠错记忆规则。推荐优先使用 cq_get_prompt_context 获取更完整的 Markdown 上下文。",
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
            "description": "【编写 SQL 前必须优先调用的核心工具】获取真实表结构、字段明细、中文表注释，以及该库已沉淀的历史业务纠错记忆与关联知识库。一次调用即可获取生成准确 SQL 所需的完整上下文，严格避免凭空猜测。",
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
            "description": "在指定连接上执行只读 SQL 查询并返回结构化数据（默认只读，禁止破坏性写入）。⚠️ 强约束安全门禁：若目标数据库沉淀了历史业务纠错规则或知识库，必须先调用 cq_get_prompt_context 获取真实上下文并阅读记忆，否则首次查询会被服务端硬性拦截阻断！",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "sql": { "type": "string", "description": "待执行的 SQL" },
                    "database": { "type": "string", "description": "可选指定数据库名" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "最大行数（默认 50）" },
                    "skip_memory_check": { "type": "boolean", "description": "强制跳过业务记忆检查（默认 false，仅限明确不需要业务规则时使用）" }
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
            "name": "cq_redis_keys",
            "description": "匹配查询 Redis 键列表",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "pattern": { "type": "string", "description": "匹配模式，如 'user:*'，默认为 '*'" },
                    "db": { "type": "integer", "description": "DB 编号，默认 0" },
                    "limit": { "type": "integer", "description": "返回条数限制，默认 50" }
                },
                "required": ["connection"]
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
        },
        {
            "name": "cq_list_memories",
            "description": "【业务规则与历史纠错记忆探查】获取指定连接或数据库下已沉淀的所有业务规范、表字段口径、排除约束与历史纠错记忆。在针对业务库写 SQL 前调用此工具检查，防止犯已被指正的历史错误。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "database": { "type": "string", "description": "可选指定数据库名" },
                    "limit": { "type": "integer", "description": "返回条数限制，默认 50" }
                },
                "required": ["connection"]
            }
        },
        {
            "name": "cq_add_memory",
            "description": "【沉淀纠错规则与业务记忆】当用户在对话中指出 AI 的错误（如字段用错、条件漏加、业务排除项）或提供新的业务规范时，主动调用此工具将规则持久化沉淀到 ChatQuery，后续查询会自动生效。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "content": { "type": "string", "description": "规则内容，如「yk_config 表使用 code 作为配置键，而非 key」" },
                    "database": { "type": "string", "description": "可选限定数据库名，省略则对该连接全局生效" },
                    "source": { "type": "string", "description": "来源标注，默认为 'mcp_agent'" }
                },
                "required": ["connection", "content"]
            }
        },
        {
            "name": "cq_delete_memory",
            "description": "删除指定的业务记忆规则",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "记忆 ID (如 mem_xxx)" }
                },
                "required": ["id"]
            }
        },
        {
            "name": "cq_search_knowledge",
            "description": "【业务指标与口径规范检索】在当前数据库绑定的知识库中按关键词检索业务口径、指标计算公式、字段含义字典或 SQL 模板。当用户提问包含特定业务术语、指标口径（如 GMV、退款率）或业务流程时优先调用。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "连接名称或 ID" },
                    "query": { "type": "string", "description": "检索关键词，支持多个词空格分隔" },
                    "database": { "type": "string", "description": "可选指定数据库名" }
                },
                "required": ["connection", "query"]
            }
        },
        {
            "name": "cq_list_knowledge",
            "description": "列出知识库文档列表（可按连接和数据库筛选已绑定的文档）",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "可选连接名称或 ID，若指定则仅列出与该连接/库绑定的文档" },
                    "database": { "type": "string", "description": "可选数据库名" }
                }
            }
        },
        {
            "name": "cq_add_knowledge",
            "description": "添加一篇业务知识库文档，并可直接绑定到指定连接或数据库",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "知识库文档标题" },
                    "content": { "type": "string", "description": "知识库正文内容（Markdown 或纯文本）" },
                    "connection": { "type": "string", "description": "可选连接名称或 ID，指定后自动绑定该文档" },
                    "database": { "type": "string", "description": "可选数据库名，配合 connection 绑定至特定库" }
                },
                "required": ["name", "content"]
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
            let matched: Vec<Value> = tables
                .into_iter()
                .filter(|t| {
                    filter
                        .as_ref()
                        .map(|flt| {
                            t.name.to_lowercase().contains(flt)
                                || t.comment
                                    .as_deref()
                                    .map(|c| c.to_lowercase().contains(flt))
                                    .unwrap_or(false)
                        })
                        .unwrap_or(true)
                })
                .map(|t| {
                    json!({
                        "name": t.name,
                        "is_view": t.is_view,
                        "comment": t.comment,
                    })
                })
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

            // 1. 单条带 LIKE 与 LIMIT 30 的 SQL 查询匹配的表名与表注释（毫秒级，彻底消除全库扫描）
            let matched_tables_raw = mysql::search_tables_direct(&cfg, target_db, &kw, 30).await?;
            let matched_tables: Vec<Value> = matched_tables_raw
                .into_iter()
                .map(|tbl| {
                    json!({
                        "table": tbl.name,
                        "is_view": tbl.is_view,
                        "comment": tbl.comment,
                    })
                })
                .collect();

            // 2. 单条带 LIKE 与 LIMIT 30 的 SQL 查询字段名与字段注释（带 5 秒超时保护）
            let matched_cols_fut = mysql::search_columns_in_db(&cfg, target_db, &kw, 30);
            let matched_cols = tokio::time::timeout(std::time::Duration::from_secs(5), matched_cols_fut)
                .await
                .ok()
                .and_then(|r| r.ok())
                .unwrap_or_default();

            let matched_columns: Vec<Value> = matched_cols
                .into_iter()
                .map(|(t, c, cm)| {
                    json!({
                        "table": t,
                        "column": c,
                        "comment": cm,
                    })
                })
                .collect();

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
            let memories = store
                .get_injected_memories(&cfg.id, Some(target_db), 20)
                .unwrap_or_default();
            mark_context_checked(&cfg.id, Some(target_db));
            Ok(serde_json::to_string_pretty(&json!({
                "tables": out,
                "relevant_memories": memories.iter().map(|m| &m.content).collect::<Vec<_>>(),
            }))?)
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

            let all_tables = mysql::list_tables(&cfg, target_db).await.unwrap_or_default();
            let mut markdown = String::new();
            for t_val in tables {
                let table_name = t_val
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("tables 中的每一项都必须是字符串"))?;
                let cols = mysql::list_columns(&cfg, target_db, table_name).await?;

                let comment_suffix = all_tables
                    .iter()
                    .find(|t| t.name == table_name)
                    .and_then(|t| t.comment.as_deref())
                    .filter(|cm| !cm.trim().is_empty())
                    .map(|cm| format!(" ({})", cm.trim()))
                    .unwrap_or_default();

                markdown.push_str(&format!("### Table `{}`{}\n", table_name, comment_suffix));
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

            // 自动注入关联的 DbMemory 业务规则与纠错记忆
            let memories = store
                .get_injected_memories(&cfg.id, Some(target_db), 50)
                .unwrap_or_default();
            if !memories.is_empty() {
                markdown.push_str("## 数据库业务规则与历史纠错记忆（必须严格遵守）：\n");
                for (i, m) in memories.iter().enumerate() {
                    markdown.push_str(&format!("{}. {}\n", i + 1, m.content));
                }
                markdown.push('\n');
            }

            // 自动注入绑定的业务知识库文档
            let kb_docs = store
                .get_injected_kb_docs(&cfg.id, Some(target_db))
                .unwrap_or_default();
            if !kb_docs.is_empty() {
                markdown.push_str("## 关联业务知识库：\n");
                let mut total = 0usize;
                const PER_DOC: usize = 2000;
                const TOTAL_CAP: usize = 6000;
                for doc in &kb_docs {
                    if total >= TOTAL_CAP {
                        break;
                    }
                    let take: String = doc.content.chars().take(PER_DOC).collect();
                    total += take.chars().count();
                    markdown.push_str(&format!("- 文档「{}」：{}\n", doc.name, take));
                }
                markdown.push('\n');
            }

            mark_context_checked(&cfg.id, Some(target_db));
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
            validate_mcp_query_safety(sql)
                .map_err(|e| anyhow::anyhow!(e))?;
            let cfg = resolve_conn(&store, conn)?;
            let target_db =
                args.get("database")
                    .and_then(|v| v.as_str())
                    .or(if cfg.database.is_empty() {
                        None
                    } else {
                        Some(&cfg.database)
                    });

            // --- 防盲查前置安全门禁 ---
            let skip_check = args
                .get("skip_memory_check")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !skip_check {
                let memories = store
                    .get_injected_memories(&cfg.id, target_db, 5)
                    .unwrap_or_default();
                let kb_docs = store
                    .get_injected_kb_docs(&cfg.id, target_db)
                    .unwrap_or_default();
                let has_rules = !memories.is_empty() || !kb_docs.is_empty();

                if has_rules && !is_context_checked(&cfg.id, target_db) {
                    let mem_samples: Vec<String> = memories
                        .iter()
                        .take(3)
                        .map(|m| format!("- {}", m.content))
                        .collect();
                    let kb_samples: Vec<String> = kb_docs
                        .iter()
                        .take(2)
                        .map(|d| format!("- 文档「{}」", d.name))
                        .collect();
                    let mut sample_msg = String::new();
                    if !mem_samples.is_empty() {
                        sample_msg.push_str(&format!("\n历史业务纠错记忆（部分）：\n{}", mem_samples.join("\n")));
                    }
                    if !kb_samples.is_empty() {
                        sample_msg.push_str(&format!("\n关联业务知识库（部分）：\n{}", kb_samples.join("\n")));
                    }

                    return Err(anyhow::anyhow!(
                        "【前置门禁拦截：当前数据库存在必须遵守的业务规则与历史纠错记忆】\n\
                         目标连接: {} (数据库: {})\n\
                         拦截原因: 该库已沉淀了 {} 条业务避坑规则与 {} 篇知识库文档。为了防止盲写 SQL 重犯历史错误，执行首次查询前，必须先调用 `cq_get_prompt_context` 获取真实字段结构与记忆规则！\n\
                         {}\n\n\
                         下一步行动: 请先调用 `cq_get_prompt_context(connection: \"{}\", tables: [...], database: \"{}\")` 获取完整字段结构与规则，核对后再提交执行！",
                        cfg.name,
                        target_db.unwrap_or("默认库"),
                        memories.len(),
                        kb_docs.len(),
                        sample_msg.trim(),
                        cfg.name,
                        target_db.unwrap_or("")
                    ));
                }
            }

            let limit_u64 = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50);
            if !(1..=1000).contains(&limit_u64) {
                return Err(anyhow::anyhow!("limit 必须在 1 到 1000 之间"));
            }
            let limit = limit_u64 as usize;

            let res = mysql::query_paged(&cfg, sql, target_db, 0, limit, false).await?;

            let active_memories = store
                .get_injected_memories(&cfg.id, target_db, 10)
                .unwrap_or_default();

            mark_context_checked(&cfg.id, target_db);

            let mut out = json!({
                "columns": res.columns,
                "rows": res.rows,
                "affected_rows": res.affected,
                "total_rows": res.total,
            });
            if !active_memories.is_empty() {
                out["active_memory_rules"] =
                    json!(active_memories.iter().map(|m| &m.content).collect::<Vec<_>>());
            }
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
            validate_mcp_query_safety(sql)
                .map_err(|e| anyhow::anyhow!(e))?;
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
        "cq_redis_keys" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let pattern = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("*");
            let db_u64 = args.get("db").and_then(|v| v.as_u64()).unwrap_or(0);
            let db =
                u8::try_from(db_u64).map_err(|_| anyhow::anyhow!("db 必须在 0 到 255 之间"))?;
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(50) as usize;
            let cfg = resolve_conn(&store, conn)?;
            if cfg.db_type != DbType::Redis {
                return Err(anyhow::anyhow!("该连接不是 Redis 类型"));
            }
            let keys = redis::list_keys(&cfg, db, pattern, limit).await?;
            Ok(serde_json::to_string_pretty(&keys)?)
        }
        "cq_list_memories" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let cfg = resolve_conn(&store, conn)?;
            let target_db = args.get("database").and_then(|v| v.as_str());
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
            let memories = store.get_injected_memories(&cfg.id, target_db, limit)?;
            mark_context_checked(&cfg.id, target_db);
            Ok(serde_json::to_string_pretty(&memories)?)
        }
        "cq_add_memory" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 content"))?;
            let cfg = resolve_conn(&store, conn)?;
            let database = args.get("database").and_then(|v| v.as_str());
            let source = args
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("mcp_agent");
            let mem = store.add_memory(&cfg.id, database, content, source, content)?;
            mark_context_checked(&cfg.id, database);
            Ok(serde_json::to_string_pretty(&json!({
                "ok": true,
                "message": format!("成功添加业务记忆: {}", mem.content),
                "memory": mem
            }))?)
        }
        "cq_delete_memory" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 id"))?;
            store.delete_memory(id)?;
            Ok(serde_json::to_string_pretty(&json!({
                "ok": true,
                "message": format!("成功删除记忆 {}", id)
            }))?)
        }
        "cq_search_knowledge" => {
            let conn = args
                .get("connection")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 connection"))?;
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 query"))?;
            let cfg = resolve_conn(&store, conn)?;
            let target_db = args.get("database").and_then(|v| v.as_str());
            let res = store.search_kb_docs(&cfg.id, target_db, query)?;
            mark_context_checked(&cfg.id, target_db);
            Ok(res)
        }
        "cq_list_knowledge" => {
            let conn_arg = args.get("connection").and_then(|v| v.as_str());
            let db_arg = args.get("database").and_then(|v| v.as_str());
            if let Some(conn) = conn_arg {
                let cfg = resolve_conn(&store, conn)?;
                let docs = store.get_injected_kb_docs(&cfg.id, db_arg)?;
                mark_context_checked(&cfg.id, db_arg);
                let out: Vec<Value> = docs.iter().map(|d| json!({
                    "id": d.id,
                    "name": d.name,
                    "preview": crate::store::preview_of(Some(&d.content)),
                    "created": d.created,
                    "updated": d.updated,
                })).collect();
                Ok(serde_json::to_string_pretty(&out)?)
            } else {
                let docs = store.list_kb_docs()?;
                let mut out = Vec::new();
                for d in docs {
                    let bindings = store.get_kb_bindings(&d.id).unwrap_or_default();
                    out.push(json!({
                        "id": d.id,
                        "name": d.name,
                        "preview": crate::store::preview_of(Some(&d.content)),
                        "bindings_count": bindings.len(),
                        "created": d.created,
                        "updated": d.updated,
                    }));
                }
                Ok(serde_json::to_string_pretty(&out)?)
            }
        }
        "cq_add_knowledge" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 name"))?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 content"))?;
            let conn_arg = args.get("connection").and_then(|v| v.as_str());
            let db_arg = args.get("database").and_then(|v| v.as_str());
            let conn_id = if let Some(conn) = conn_arg {
                let cfg = resolve_conn(&store, conn)?;
                Some(cfg.id)
            } else {
                None
            };
            let kb_id = store.add_kb_doc_with_binding(
                name,
                content,
                conn_id.as_deref(),
                db_arg,
            )?;
            if let Some(ref cid) = conn_id {
                mark_context_checked(cid, db_arg);
            }
            Ok(serde_json::to_string_pretty(&json!({
                "ok": true,
                "message": format!("成功创建知识库文档: {} (ID: {})", name, kb_id),
                "id": kb_id,
                "bound_conn": conn_arg,
                "bound_db": db_arg
            }))?)
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

    #[tokio::test]
    async fn tools_list_contains_memory_and_knowledge_tools() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(1)),
            has_id: true,
            method: "tools/list".to_string(),
            params: None,
        };
        let response = handle_request(req).await.unwrap();
        let tools = response
            .result
            .unwrap()
            .get("tools")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(names.contains(&"cq_list_memories"));
        assert!(names.contains(&"cq_add_memory"));
        assert!(names.contains(&"cq_delete_memory"));
        assert!(names.contains(&"cq_search_knowledge"));
        assert!(names.contains(&"cq_list_knowledge"));
        assert!(names.contains(&"cq_add_knowledge"));
        assert!(names.contains(&"cq_redis_keys"));
    }

    #[test]
    fn context_checked_state_tracking() {
        assert!(!is_context_checked("conn_mock_1", Some("db1")));
        mark_context_checked("conn_mock_1", Some("db1"));
        assert!(is_context_checked("conn_mock_1", Some("db1")));
        assert!(!is_context_checked("conn_mock_1", Some("db2")));

        // Connection-level check covers all databases under the connection
        mark_context_checked("conn_mock_2", None);
        assert!(is_context_checked("conn_mock_2", None));
        assert!(is_context_checked("conn_mock_2", Some("any_db")));
    }
}
