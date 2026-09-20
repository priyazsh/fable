//! Workspace state exposed to the frontend.
//!
//! For now this is a single snapshot command. As the terminal runtime lands
//! (Milestone 4+) the session/PTY state joins this module.

use serde::Serialize;

/// A snapshot of the environment Forge was launched into.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    /// Current working directory of the Forge process.
    pub cwd: String,
    /// The user's home directory, used to abbreviate paths as `~/...`.
    pub home: Option<String>,
    /// Target OS: `linux`, `windows`, `macos`, ...
    pub os: String,
    /// Target architecture: `x86_64`, `aarch64`, ...
    pub arch: String,
    /// Forge version, sourced from the Tauri package info.
    pub app_version: String,
}

/// Resolves the user's home directory without pulling in an extra crate.
fn home_dir() -> Option<String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

#[tauri::command]
pub fn workspace_info(app: tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let cwd = std::env::current_dir()
        .map_err(|error| format!("failed to read working directory: {error}"))?
        .to_string_lossy()
        .into_owned();

    Ok(WorkspaceInfo {
        cwd,
        home: home_dir(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
    })
}
