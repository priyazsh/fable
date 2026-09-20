//! User settings.
//!
//! Rust owns the settings so the shell runner and the UI cannot disagree about
//! them. They are held in memory and mirrored to a JSON file on save.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::providers::Provider;

/// Where a newly opened tab starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewTabCwd {
    /// The directory Forge itself was launched from.
    Cwd,
    /// The user's home directory.
    Home,
}

fn default_font_family() -> String {
    "ui-monospace".to_string()
}

const fn default_font_size() -> u16 {
    14
}

const fn default_new_tab_cwd() -> NewTabCwd {
    NewTabCwd::Cwd
}

/// Bounds keep a typo from rendering the UI unusable.
const MIN_FONT_SIZE: u16 = 8;
const MAX_FONT_SIZE: u16 = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    /// `None` means "whatever `$SHELL` says".
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default = "default_new_tab_cwd")]
    pub new_tab_cwd: NewTabCwd,
    #[serde(default)]
    pub provider: Provider,
    /// Model id sent to the provider; `None` uses the provider's default.
    #[serde(default)]
    pub agent_model: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_family: default_font_family(),
            font_size: default_font_size(),
            shell: None,
            new_tab_cwd: default_new_tab_cwd(),
            provider: Provider::default(),
            agent_model: None,
        }
    }
}

impl Settings {
    /// Clamps anything a hand-edited file could get wrong.
    fn sanitised(mut self) -> Self {
        self.font_size = self.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        if self.font_family.trim().is_empty() {
            self.font_family = default_font_family();
        }
        self.shell = self
            .shell
            .filter(|path| !path.trim().is_empty() && PathBuf::from(path).is_file());
        self.agent_model = self
            .agent_model
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty());
        self
    }
}

#[derive(Default)]
pub struct SettingsState(Mutex<Settings>);

impl SettingsState {
    pub fn new(settings: Settings) -> Self {
        Self(Mutex::new(settings))
    }

    pub fn snapshot(&self) -> Settings {
        self.0.lock().map(|guard| guard.clone()).unwrap_or_default()
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .config_dir()
        .map_err(|error| format!("no config directory: {error}"))?
        .join("forge");
    Ok(dir.join("settings.json"))
}

/// Reads settings from disk, falling back to defaults for a missing or
/// unreadable file. Called once at startup.
pub fn load_from_disk(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    serde_json::from_str::<Settings>(&text)
        .map(Settings::sanitised)
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    state.snapshot()
}

#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: Settings,
) -> Result<Settings, String> {
    let settings = settings.sanitised();

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "settings state poisoned".to_string())?;
        *guard = settings.clone();
    }

    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| format!("{}: {error}", path.display()))?;

    Ok(settings)
}

/// Absolute path of the settings file, shown in the settings panel.
#[tauri::command]
pub fn settings_file(app: AppHandle) -> Result<String, String> {
    settings_path(&app).map(|path| path.to_string_lossy().into_owned())
}

/// Shells that actually exist on this machine, for the settings dropdown.
#[tauri::command]
pub fn available_shells() -> Vec<String> {
    let mut found: Vec<String> = Vec::new();

    let mut push = |candidate: PathBuf| {
        let path = candidate.to_string_lossy().into_owned();
        if candidate.is_file() && !found.contains(&path) {
            found.push(path);
        }
    };

    if cfg!(windows) {
        for candidate in [
            r"C:\Windows\System32\cmd.exe",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Windows\System32\wsl.exe",
        ] {
            push(PathBuf::from(candidate));
        }
    } else {
        // /etc/shells is the system's own list of login shells.
        if let Ok(text) = std::fs::read_to_string("/etc/shells") {
            for line in text.lines() {
                let line = line.trim();
                if !line.is_empty() && !line.starts_with('#') {
                    push(PathBuf::from(line));
                }
            }
        }
        // Anything installed but not registered as a login shell.
        if let Some(path) = std::env::var_os("PATH") {
            for name in ["bash", "zsh", "fish", "dash", "sh"] {
                for dir in std::env::split_paths(&path) {
                    push(dir.join(name));
                }
            }
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_size_is_clamped_and_blank_family_falls_back() {
        let wild = Settings {
            font_family: "   ".into(),
            font_size: 900,
            new_tab_cwd: NewTabCwd::Home,
            ..Settings::default()
        }
        .sanitised();
        assert_eq!(wild.font_size, MAX_FONT_SIZE);
        assert_eq!(wild.font_family, default_font_family());
        // An explicit choice is preserved.
        assert_eq!(wild.new_tab_cwd, NewTabCwd::Home);

        let tiny = Settings {
            font_size: 1,
            ..Settings::default()
        }
        .sanitised();
        assert_eq!(tiny.font_size, MIN_FONT_SIZE);
    }

    #[test]
    fn a_shell_that_does_not_exist_is_dropped() {
        let settings = Settings {
            shell: Some("/definitely/not/a/shell".into()),
            ..Settings::default()
        }
        .sanitised();
        assert_eq!(settings.shell, None);
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_shell_is_kept() {
        let settings = Settings {
            shell: Some("/bin/sh".into()),
            ..Settings::default()
        }
        .sanitised();
        assert_eq!(settings.shell.as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn the_agent_defaults_to_anthropic_with_no_model_override() {
        let settings = Settings::default();
        assert_eq!(settings.provider, Provider::Anthropic);
        assert_eq!(settings.agent_model, None);
    }

    #[test]
    fn a_blank_model_is_treated_as_unset() {
        let blank = Settings {
            agent_model: Some("   ".into()),
            ..Settings::default()
        }
        .sanitised();
        assert_eq!(blank.agent_model, None);
    }

    #[test]
    fn a_partial_file_fills_in_defaults() {
        let settings: Settings = serde_json::from_str(r#"{"fontSize": 16}"#).unwrap();
        assert_eq!(settings.font_size, 16);
        assert_eq!(settings.font_family, default_font_family());
        assert_eq!(settings.new_tab_cwd, NewTabCwd::Cwd);
        assert_eq!(settings.shell, None);
        // A file written before providers existed still loads.
        assert_eq!(settings.provider, Provider::Anthropic);
    }

    #[cfg(unix)]
    #[test]
    fn available_shells_finds_something_real() {
        let shells = available_shells();
        assert!(!shells.is_empty(), "expected at least one shell");
        assert!(shells.iter().all(|path| PathBuf::from(path).is_file()));
        // No duplicates, since /etc/shells and PATH overlap.
        let mut sorted = shells.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), shells.len());
    }
}
