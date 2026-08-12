#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use chatquery::config::{load_mcp_servers, LlmConfig};
use chatquery::db::connection::ConnectionStore;
use chatquery::mcp::host::McpHostManager;
use chatquery::store::Storage;
use commands::*;
use state::AppState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

fn main() {
    let storage = match Storage::open() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("无法打开本地存储: {}", e);
            std::process::exit(1);
        }
    };
    let store = match ConnectionStore::load(storage) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("无法加载连接: {}", e);
            std::process::exit(1);
        }
    };
    let llm = LlmConfig::load();
    let mcp_cfgs = load_mcp_servers();
    let mcp = if mcp_cfgs.is_empty() {
        None
    } else {
        Some(Arc::new(McpHostManager::new(mcp_cfgs)))
    };

    tauri::Builder::default()
        .manage(AppState {
            store: Arc::new(Mutex::new(store)),
            schema_cache: Mutex::new(HashMap::new()),
            llm: Mutex::new(llm),
            mcp,
            turns: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_tree,
            add_connection,
            update_connection,
            delete_connection,
            create_environment,
            create_group,
            rename_container,
            delete_container,
            test_connection,
            guard_write_sql,
            execute_query,
            explain_query,
            log_query,
            list_queries,
            save_query,
            delete_query,
            get_schema,
            complete_sql,
            chat_turn,
            cancel_turn,
            resolve_confirm,
            get_status,
            get_llm_config,
            get_vendor_presets,
            save_llm_config,
            list_databases,
            list_redis_dbs,
            list_tables,
            search_tables,
            list_redis_keys,
            list_redis_keys_meta,
            list_columns,
            browse_table,
            browse_redis_key,
            delete_redis_key,
            php_unserialize,
            apply_edit,
            insert_row,
            delete_row,
            describe_table,
            list_relationships,
            get_key_status,
            set_encryption_key,
            export_connections,
            import_connections,
            export_template,
            explain_visual,
            add_kb_doc,
            update_kb_doc,
            list_kb_docs,
            delete_kb_doc,
            set_kb_bindings,
            list_audit_logs,
            list_conversations,
            create_conversation,
            rename_conversation,
            delete_conversation,
            get_conversation,
            append_chat_messages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ChatQuery");
}
