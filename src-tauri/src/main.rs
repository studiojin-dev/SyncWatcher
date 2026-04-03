// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().any(|arg| arg == "--mcp-stdio") {
        if let Err(error) = syncwatcher_lib::mcp_stdio::run_stdio_server() {
            eprintln!("Failed to start SyncWatcher MCP stdio mode: {error}");
            std::process::exit(1);
        }
        return;
    }

    syncwatcher_lib::run()
}
