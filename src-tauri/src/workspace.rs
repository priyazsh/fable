//! Workspace state exposed to the frontend.
//!
//! For now this is a single snapshot command. As the terminal runtime lands
//! (Milestone 4+) the session/PTY state joins this module.

use std::path::Path;

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
pub fn home_dir() -> Option<String> {
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

/// Files that identify what kind of project a directory holds (spec §10).
const PROJECT_MARKERS: &[(&str, &str)] = &[
    ("Cargo.toml", "Rust"),
    ("bun.lock", "Bun"),
    ("package.json", "Node"),
    ("pyproject.toml", "Python"),
    ("requirements.txt", "Python"),
    ("go.mod", "Go"),
    ("pom.xml", "Java/Maven"),
    ("build.gradle", "Java/Gradle"),
    ("build.gradle.kts", "Java/Gradle"),
    ("Gemfile", "Ruby"),
    ("composer.json", "PHP"),
    ("compose.yaml", "Docker Compose"),
    ("docker-compose.yml", "Docker Compose"),
    ("Dockerfile", "Docker"),
];

/// Current branch, by reading `.git/HEAD` rather than shelling out to git.
fn git_branch(start: &Path) -> Option<String> {
    let mut dir = start;
    loop {
        let head = dir.join(".git").join("HEAD");
        if head.is_file() {
            let text = std::fs::read_to_string(head).ok()?;
            // A detached HEAD holds a bare sha, which is not a branch name.
            return text
                .trim()
                .strip_prefix("ref: refs/heads/")
                .map(str::to_string);
        }
        dir = dir.parent()?;
    }
}

/// A short description of the project in `cwd`, or an empty string.
///
/// Deliberately small: the agent gets targeted context, not a filesystem dump
/// (spec §16).
pub fn project_summary(cwd: &Path) -> String {
    let mut kinds: Vec<&str> = Vec::new();
    for (marker, kind) in PROJECT_MARKERS {
        if cwd.join(marker).is_file() && !kinds.contains(kind) {
            kinds.push(kind);
        }
    }

    let mut lines = Vec::new();
    if !kinds.is_empty() {
        lines.push(format!("Project: {}", kinds.join(", ")));
    }
    if let Some(branch) = git_branch(cwd) {
        lines.push(format!("Git branch: {branch}"));
    }

    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_come_from_the_directory_itself_and_never_recurse() {
        // Cargo.toml lives in src-tauri; the repo root has bun.lock + package.json.
        let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let repo = crate_root.parent().unwrap();

        assert!(project_summary(crate_root).contains("Rust"));

        let root = project_summary(repo);
        assert!(root.contains("Bun") && root.contains("Node"), "got {root:?}");
        assert!(!root.contains("Rust"), "must not descend into src-tauri: {root:?}");
        // git_branch does walk up, so the repo root reports a branch.
        assert!(root.contains("Git branch:"), "got {root:?}");
    }

    #[test]
    fn a_bare_directory_contributes_nothing() {
        assert_eq!(project_summary(Path::new("/")), "");
    }

    #[test]
    fn a_kind_with_several_markers_is_listed_once() {
        // Python has two markers; both present must still say "Python" once.
        let dir = std::env::temp_dir().join(format!("forge-summary-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for marker in ["pyproject.toml", "requirements.txt"] {
            std::fs::write(dir.join(marker), "").unwrap();
        }
        let summary = project_summary(&dir);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(summary.matches("Python").count(), 1, "got {summary:?}");
    }
}
