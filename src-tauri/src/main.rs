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
use tauri::Manager;

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
            store: Mutex::new(store),
            schema_cache: Mutex::new(HashMap::new()),
            llm: Mutex::new(llm),
            mcp,
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
            execute_query,
            explain_query,
            log_query,
            list_queries,
            save_query,
            delete_query,
            get_schema,
            complete_sql,
            chat_turn,
            get_status,
            get_llm_config,
            get_vendor_presets,
            save_llm_config,
            list_databases,
            list_redis_dbs,
            list_tables,
            list_redis_keys,
            list_columns,
            browse_table,
            browse_redis_key,
            apply_edit,
            insert_row,
            delete_row,
            describe_table,
            list_relationships,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                // macOS WKWebView follows the system scroller style. With the
                // default "Automatically" setting (trackpad Macs) it uses the
                // overlay scroller, which ignores `::-webkit-scrollbar` styling.
                // Force the legacy (always-visible) style so our custom CSS
                // scrollbars actually render.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| {
                        unsafe {
                            use objc2::msg_send;
                            use objc2::runtime::AnyObject;
                            let view = webview.inner() as *mut AnyObject;
                            let scroll_view: *mut AnyObject = msg_send![view, scrollView];
                            // NSScrollerStyleLegacy = 0
                            let _: () = msg_send![scroll_view, setScrollerStyle: 0isize];
                        }
                    });
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ChatQuery");
}
