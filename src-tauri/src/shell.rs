//! One-shot command execution.
//!
//! This is deliberately *not* a PTY: commands run through the user's shell
//! with `-c`, output is streamed back over Tauri events, and interactive
//! programs (vim, htop, ssh) will not work. Milestone 4 replaces the spawning
//! here with a real PTY/ConPTY while keeping the same event shape, so the
//! frontend timeline does not have to change.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::workspace::home_dir;

/// Children keyed by the timeline entry that started them, so they can be killed.
#[derive(Default)]
pub struct RunningCommands(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    entry_id: String,
    stream: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    entry_id: String,
    /// `None` when the process was terminated by a signal.
    exit_code: Option<i32>,
    duration_ms: u64,
}

pub const OUTPUT_EVENT: &str = "command://output";
pub const EXIT_EVENT: &str = "command://exit";

/// Builtins that never appear on `PATH` but are still commands, not prose.
const SHELL_BUILTINS: &[&str] = &[
    "alias", "bg", "break", "builtin", "cd", "command", "continue", "declare", "dirs", "echo",
    "eval", "exec", "exit", "export", "false", "fg", "hash", "help", "history", "jobs", "let",
    "local", "logout", "popd", "printf", "pushd", "pwd", "read", "readonly", "return", "set",
    "shift", "source", "test", "times", "trap", "true", "type", "typeset", "ulimit", "umask",
    "unalias", "unset", "wait",
];

fn shell_invocation(input: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
        ("cmd".to_string(), vec!["/C".to_string(), input.to_string()])
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, vec!["-c".to_string(), input.to_string()])
    }
}

/// Reads `pipe` to EOF, handing complete UTF-8 slices to `sink`.
///
/// A read can land in the middle of a multi-byte character, so incomplete
/// trailing bytes are carried over to the next read rather than being
/// replaced with U+FFFD. Whatever is left at EOF is flushed lossily.
fn pump<R: Read, S: FnMut(String)>(mut pipe: R, mut sink: S) {
    let mut buffer = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();

    loop {
        let read = match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        pending.extend_from_slice(&buffer[..read]);

        let valid = match std::str::from_utf8(&pending) {
            Ok(text) => text.len(),
            Err(error) => error.valid_up_to(),
        };
        if valid == 0 {
            continue;
        }

        let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
        pending.drain(..valid);
        sink(text);
    }

    if !pending.is_empty() {
        sink(String::from_utf8_lossy(&pending).into_owned());
    }
}

/// Streams a child pipe to the frontend as `command://output` events.
fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    entry_id: String,
    stream: &'static str,
    pipe: R,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        pump(pipe, |text| {
            let _ = app.emit(
                OUTPUT_EVENT,
                OutputEvent {
                    entry_id: entry_id.clone(),
                    stream,
                    text,
                },
            );
        });
    })
}

#[tauri::command]
pub fn run_command(
    app: AppHandle,
    state: State<'_, RunningCommands>,
    entry_id: String,
    input: String,
    cwd: String,
) -> Result<(), String> {
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("no such directory: {cwd}"));
    }

    let started = Instant::now();
    let (program, args) = shell_invocation(&input);

    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(&dir)
        // No PTY yet, so give the child nothing to read rather than letting it
        // block forever waiting on a terminal that does not exist.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start {program}: {error}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let child = Arc::new(Mutex::new(child));
    state
        .0
        .lock()
        .map_err(|_| "command registry poisoned".to_string())?
        .insert(entry_id.clone(), Arc::clone(&child));

    let readers: Vec<_> = [
        stdout.map(|pipe| spawn_reader(app.clone(), entry_id.clone(), "stdout", pipe)),
        stderr.map(|pipe| spawn_reader(app.clone(), entry_id.clone(), "stderr", pipe)),
    ]
    .into_iter()
    .flatten()
    .collect();

    thread::spawn(move || {
        // Draining the pipes first means the exit event always arrives last.
        for reader in readers {
            let _ = reader.join();
        }

        let mut exit_code = None;
        loop {
            if let Ok(mut guard) = child.lock() {
                match guard.try_wait() {
                    Ok(Some(status)) => {
                        exit_code = status.code();
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            } else {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        if let Ok(mut registry) = app.state::<RunningCommands>().0.lock() {
            registry.remove(&entry_id);
        }
        let _ = app.emit(
            EXIT_EVENT,
            ExitEvent {
                entry_id,
                exit_code,
                duration_ms: started.elapsed().as_millis() as u64,
            },
        );
    });

    Ok(())
}

/// Terminates a running command. The exit event is emitted by the waiter
/// thread once the process is actually reaped.
///
/// Only the shell process is signalled; a backgrounded grandchild can outlive
/// it. Process-group termination arrives with the PTY in milestone 4.
#[tauri::command]
pub fn kill_command(state: State<'_, RunningCommands>, entry_id: String) -> Result<(), String> {
    let child = state
        .0
        .lock()
        .map_err(|_| "command registry poisoned".to_string())?
        .get(&entry_id)
        .map(Arc::clone);

    match child {
        Some(child) => child
            .lock()
            .map_err(|_| "child process poisoned".to_string())?
            .kill()
            .map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into());
    extensions.split(';').any(|extension| {
        let extension = extension.trim_start_matches('.');
        !extension.is_empty() && path.with_extension(extension).is_file()
    })
}

/// Whether the first token of an input line names something runnable.
///
/// This is what decides "run it" versus "hand it to the agent", so it errs
/// toward recognising commands: builtins, explicit paths and anything on PATH.
#[tauri::command]
pub fn command_exists(name: String) -> bool {
    if name.is_empty() {
        return false;
    }
    if SHELL_BUILTINS.contains(&name.as_str()) {
        return true;
    }
    if name.contains('/') || (cfg!(windows) && name.contains('\\')) {
        return is_executable(Path::new(&name));
    }

    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| is_executable(&dir.join(&name)))
}

/// Windows canonicalisation yields `\\?\C:\...`, which is correct but ugly in a
/// status bar.
fn tidy(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text)
}

/// Resolves the target of a `cd`, expanding `~` and relative paths.
///
/// One-shot execution has no persistent shell, so directory changes are held
/// in the session rather than in a child process.
#[tauri::command]
pub fn resolve_dir(cwd: String, target: Option<String>) -> Result<String, String> {
    let home = home_dir();
    let raw = match target.filter(|value| !value.trim().is_empty()) {
        Some(value) => value.trim().to_string(),
        None => home.clone().ok_or_else(|| "cd: no home directory".to_string())?,
    };

    let expanded = if raw == "~" {
        home.clone().ok_or_else(|| "cd: no home directory".to_string())?
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        let home = home.ok_or_else(|| "cd: no home directory".to_string())?;
        Path::new(&home).join(rest).to_string_lossy().into_owned()
    } else {
        raw.clone()
    };

    let candidate = Path::new(&expanded);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        Path::new(&cwd).join(candidate)
    };

    let canonical = joined
        .canonicalize()
        .map_err(|_| format!("cd: no such directory: {raw}"))?;
    if !canonical.is_dir() {
        return Err(format!("cd: not a directory: {raw}"));
    }
    Ok(tidy(&canonical))
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A reader that hands out one byte per `read`, forcing every multi-byte
    /// character to straddle a read boundary.
    struct Dribble(Cursor<Vec<u8>>);

    impl Read for Dribble {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            self.0.read(&mut buffer[..1])
        }
    }

    fn collect(reader: impl Read) -> Vec<String> {
        let mut chunks = Vec::new();
        pump(reader, |text| chunks.push(text));
        chunks
    }

    #[test]
    fn pump_reassembles_utf8_split_across_reads() {
        let source = "héllo — 日本語 ✓\n";
        let chunks = collect(Dribble(Cursor::new(source.as_bytes().to_vec())));
        assert_eq!(chunks.concat(), source);
        // Nothing was replaced with the substitution character.
        assert!(!chunks.concat().contains('\u{fffd}'));
    }

    #[test]
    fn pump_flushes_a_truncated_trailing_sequence() {
        // The first two bytes of a three-byte character, then EOF.
        let bytes = vec![b'a', 0xe6, 0x97];
        let chunks = collect(Cursor::new(bytes));
        assert_eq!(chunks.concat().chars().next(), Some('a'));
        assert!(chunks.concat().contains('\u{fffd}'));
    }

    #[test]
    fn pump_yields_nothing_for_an_empty_pipe() {
        assert!(collect(Cursor::new(Vec::new())).is_empty());
    }

    #[test]
    fn builtins_and_path_entries_count_as_commands() {
        assert!(command_exists("cd".into()), "cd is a builtin");
        assert!(command_exists("export".into()), "export is a builtin");
        assert!(!command_exists(String::new()));
        assert!(!command_exists("forge-definitely-not-a-real-binary".into()));
    }

    #[cfg(unix)]
    #[test]
    fn absolute_and_relative_program_paths_are_probed_directly() {
        assert!(command_exists("sh".into()), "sh should be on PATH");
        assert!(command_exists("/bin/sh".into()));
        assert!(!command_exists("/bin/forge-not-here".into()));
        // A directory is not executable even though it exists.
        assert!(!command_exists("/tmp/".into()));
    }

    #[test]
    fn prose_does_not_resolve_as_a_program() {
        for word in ["fix", "explain", "refactor", "why"] {
            assert!(!command_exists(word.to_string()), "{word} should not be on PATH");
        }
    }

    /// Covers the whole spawn path short of the Tauri emit: shell selection,
    /// piping, interleaved streams and the exit code.
    #[cfg(unix)]
    #[test]
    fn spawning_through_the_shell_captures_both_streams_and_the_exit_code() {
        let (program, args) = shell_invocation("echo out; echo err >&2; exit 3");
        let mut child = Command::new(&program)
            .args(&args)
            .current_dir("/tmp")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");

        let out = child.stdout.take().expect("stdout");
        let err = child.stderr.take().expect("stderr");

        let mut stdout = String::new();
        let mut stderr = String::new();
        pump(out, |text| stdout.push_str(&text));
        pump(err, |text| stderr.push_str(&text));

        assert_eq!(stdout, "out\n");
        assert_eq!(stderr, "err\n");
        assert_eq!(child.wait().unwrap().code(), Some(3));
    }

    /// `stdin` is null, so a program that reads it must not hang.
    #[cfg(unix)]
    #[test]
    fn a_command_reading_stdin_terminates_instead_of_blocking() {
        let (program, args) = shell_invocation("cat");
        let mut child = Command::new(&program)
            .args(&args)
            .current_dir("/tmp")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn");

        let out = child.stdout.take().expect("stdout");
        let mut stdout = String::new();
        pump(out, |text| stdout.push_str(&text));

        assert_eq!(stdout, "");
        assert_eq!(child.wait().unwrap().code(), Some(0));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_dir_handles_absolute_relative_and_missing_targets() {
        let tmp = resolve_dir("/".into(), Some("tmp".into())).expect("relative descent");
        assert_eq!(tmp, "/tmp");

        assert_eq!(resolve_dir("/tmp".into(), Some("/".into())).unwrap(), "/");
        assert_eq!(resolve_dir("/tmp".into(), Some("..".into())).unwrap(), "/");

        let error = resolve_dir("/tmp".into(), Some("no-such-dir-xyz".into())).unwrap_err();
        assert!(error.starts_with("cd: no such directory"), "got {error}");
    }

    #[cfg(unix)]
    #[test]
    fn resolve_dir_rejects_files_and_bare_cd_goes_home() {
        let error = resolve_dir("/".into(), Some("/etc/hostname".into()));
        // Either the file does not exist on this host, or it is not a directory.
        if let Ok(path) = &error {
            panic!("expected a rejection, resolved to {path}");
        }

        if let Some(home) = home_dir() {
            assert_eq!(resolve_dir("/tmp".into(), None).unwrap(), home);
            assert_eq!(resolve_dir("/tmp".into(), Some("~".into())).unwrap(), home);
        }
    }
}
