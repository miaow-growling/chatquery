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
    let args: Vec<String> = std::env::args().collect();
    const CLI_COMMANDS: &[&str] = &[
        "env", "group", "conn", "tree", "meta", "query", "redis", "guard", "mcp", "install",
        "--help", "-h", "--version", "-V",
    ];
    let is_cli = args
        .get(1)
        .map(|arg| CLI_COMMANDS.contains(&arg.as_str()))
        .unwrap_or(false);
    if is_cli {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to create tokio runtime for CLI");
        let dispatched = rt.block_on(async {
            chatquery::cli::dispatch(Some(args)).await
        });
        match dispatched {
            Ok(_) => std::process::exit(0),
            Err(e) => {
                eprintln!("错误: {}", e);
                std::process::exit(1);
            }
        }
    }

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 启动时静默检查并建立 ~/.local/bin/chatquery 软链接
            #[cfg(unix)]
            let _ = chatquery::cli::install::ensure_cli_symlink();

            // macOS 应用菜单中文化：Tauri 默认菜单是英文（About/Hide/Quit 等，
            // 应用未声明本地化时系统不翻译）。这里用预定义菜单项（行为不变）
            // + 中文文案整体重建菜单。
            use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
            let handle = app.handle();
            let install_cli = MenuItemBuilder::with_id(
                "install_cli",
                "安装/修复命令行工具 (chatquery)",
            )
            .build(handle)?;

            let app_submenu = SubmenuBuilder::new(handle, "智询")
                .about_with_text(
                    "关于智询",
                    Some(AboutMetadata {
                        name: Some("智询".to_string()),
                        version: Some(handle.package_info().version.to_string()),
                        ..Default::default()
                    }),
                )
                .separator()
                .item(&install_cli)
                .separator()
                .services_with_text("服务")
                .separator()
                .hide_with_text("隐藏智询")
                .hide_others_with_text("隐藏其他")
                .show_all_with_text("全部显示")
                .separator()
                .quit_with_text("退出智询")
                .build()?;

            let file_submenu = SubmenuBuilder::new(handle, "文件")
                .close_window_with_text("关闭窗口")
                .build()?;

            let edit_submenu = SubmenuBuilder::new(handle, "编辑")
                .undo_with_text("撤销")
                .redo_with_text("重做")
                .separator()
                .cut_with_text("剪切")
                .copy_with_text("拷贝")
                .paste_with_text("粘贴")
                .select_all_with_text("全选")
                .build()?;

            let view_submenu = SubmenuBuilder::new(handle, "显示")
                .fullscreen_with_text("进入全屏")
                .build()?;

            let window_submenu = SubmenuBuilder::new(handle, "窗口")
                .minimize_with_text("最小化")
                .build()?;

            let menu = MenuBuilder::new(handle)
                .item(&app_submenu)
                .item(&file_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&window_submenu)
                .build()?;
            handle.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "install_cli" {
                use tauri_plugin_dialog::DialogExt;
                let message = match chatquery::cli::install::ensure_cli_symlink() {
                    Ok(Some(path)) => format!("命令行工具已就绪：{}", path.display()),
                    Ok(None) => "当前平台不需要安装软链接".to_string(),
                    Err(err) => format!("未修改现有文件：{}", err),
                };
                app.dialog()
                    .message(message)
                    .title("ChatQuery 命令行工具")
                    .show(|_| {});
            }
        })
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
            prune_queries,
            save_query,
            delete_query,
            get_schema,
            list_remote_models,
            chat_turn,
            inline_generate_sql,
            cancel_turn,
            resolve_confirm,
            get_status,
            get_llm_config,
            get_vendor_presets,
            save_llm_config,
            list_vendor_profiles,
            save_vendor_profile,
            delete_vendor_profile,
            apply_vendor_profile,
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
	            list_data_assistants,
	            get_data_assistant,
	            save_data_assistant,
	            delete_data_assistant,
	            list_audit_logs,
	            list_conversations,
	            create_conversation,
	            rename_conversation,
	            delete_conversation,
	            get_conversation,
	            append_chat_messages,
	            get_memory_usage,
	            clean_cache,
	        ])
        .run(tauri::generate_context!())
        .expect("error while running ChatQuery");
}
