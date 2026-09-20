mod agent;
mod providers;
mod secrets;
mod settings;
mod shell;
mod workspace;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(shell::RunningCommands::default())
        .manage(agent::RunningAgents::default())
        .setup(|app| {
            // Settings live in Rust so the shell runner and the UI cannot
            // disagree about them. Loaded before the window renders.
            let loaded = settings::load_from_disk(app.handle());
            app.manage(settings::SettingsState::new(loaded));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::workspace_info,
            shell::run_command,
            shell::kill_command,
            shell::command_exists,
            shell::resolve_dir,
            settings::get_settings,
            settings::set_settings,
            settings::settings_file,
            settings::available_shells,
            agent::run_agent_task,
            agent::kill_agent,
            agent::agent_ready,
            agent::has_api_key,
            agent::set_api_key,
            agent::clear_api_key,
            agent::list_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
