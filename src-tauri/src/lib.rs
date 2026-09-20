mod shell;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(shell::RunningCommands::default())
        .invoke_handler(tauri::generate_handler![
            workspace::workspace_info,
            shell::run_command,
            shell::kill_command,
            shell::command_exists,
            shell::resolve_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
