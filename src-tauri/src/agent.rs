//! Claude Code as an agent backend.
//!
//! Rather than calling a chat API, Forge drives the installed `claude` binary
//! in print mode and translates its NDJSON event stream into a small,
//! provider-neutral step vocabulary. A future OpenAI provider emits the same
//! steps, so the UI never learns either vendor's schema.
//!
//! Two deliberate properties:
//!
//! - No API key. The CLI uses the user's existing Claude Code credentials.
//! - Thinking blocks are dropped, never forwarded. The UI shows actions and
//!   prose only (spec §12).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::settings::{AgentPermissions, Settings, SettingsState};

pub const STEP_EVENT: &str = "agent://step";
pub const EXIT_EVENT: &str = "agent://exit";

/// Longest tool detail shown before elision, e.g. a very long shell command.
const DETAIL_LIMIT: usize = 140;

/// Agent processes keyed by the timeline entry that started them.
#[derive(Default)]
pub struct RunningAgents(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

/// Provider-neutral view of what the agent is doing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentStep {
    Started {
        session_id: Option<String>,
        model: Option<String>,
        permission_mode: Option<String>,
    },
    /// Prose the agent wrote for the user.
    Text { text: String },
    /// An action the agent took, e.g. `Read` of `src/auth.ts`.
    Tool {
        name: String,
        detail: Option<String>,
    },
    /// Liveness only — a token count, never any thinking content.
    Progress { tokens: u64 },
    /// Out-of-band message, such as something the CLI wrote to stderr.
    Notice { text: String },
    Done {
        result: Option<String>,
        is_error: bool,
        turns: Option<u64>,
        duration_ms: Option<u64>,
        cost_usd: Option<f64>,
        denials: u64,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepEvent {
    entry_id: String,
    step: AgentStep,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentExitEvent {
    entry_id: String,
    exit_code: Option<i32>,
    duration_ms: u64,
}

fn truncate(text: &str, limit: usize) -> String {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= limit {
        return flattened;
    }
    let kept: String = flattened.chars().take(limit).collect();
    format!("{kept}…")
}

/// The most useful single field from a tool's input, for a one-line summary.
fn tool_detail(name: &str, input: &Value) -> Option<String> {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let raw = match name {
        "Read" | "Edit" | "Write" | "NotebookEdit" => field("file_path"),
        "Bash" | "BashOutput" => field("command"),
        "Grep" | "Glob" => field("pattern"),
        "Task" | "Agent" => field("description"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        "Skill" => field("skill"),
        _ => None,
    }?;
    Some(truncate(raw, DETAIL_LIMIT))
}

/// Translates one NDJSON line into zero or more steps.
///
/// Unknown event types and unparseable lines are ignored rather than surfaced,
/// so a CLI schema change degrades quietly instead of filling the timeline
/// with noise.
pub fn steps_from_line(line: &str) -> Vec<AgentStep> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };

    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };

    match value.get("type").and_then(Value::as_str) {
        Some("system") => match value.get("subtype").and_then(Value::as_str) {
            Some("init") => vec![AgentStep::Started {
                session_id: string("session_id"),
                model: string("model"),
                permission_mode: string("permissionMode"),
            }],
            Some("thinking_tokens") => value
                .get("estimated_tokens")
                .and_then(Value::as_u64)
                .map(|tokens| vec![AgentStep::Progress { tokens }])
                .unwrap_or_default(),
            _ => Vec::new(),
        },

        Some("assistant") => {
            let blocks = value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();

            blocks
                .iter()
                .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                    // Chain-of-thought is never forwarded to the UI.
                    Some("thinking") | Some("redacted_thinking") => None,
                    Some("text") => block
                        .get("text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.trim().is_empty())
                        .map(|text| AgentStep::Text {
                            text: text.to_string(),
                        }),
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str)?;
                        Some(AgentStep::Tool {
                            name: name.to_string(),
                            detail: block.get("input").and_then(|input| tool_detail(name, input)),
                        })
                    }
                    _ => None,
                })
                .collect()
        }

        Some("result") => vec![AgentStep::Done {
            result: string("result"),
            is_error: value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            turns: value.get("num_turns").and_then(Value::as_u64),
            duration_ms: value.get("duration_ms").and_then(Value::as_u64),
            cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
            denials: value
                .get("permission_denials")
                .and_then(Value::as_array)
                .map(|denials| denials.len() as u64)
                .unwrap_or(0),
        }],

        _ => Vec::new(),
    }
}

/// Maps the configured permission level onto the CLI's modes.
///
/// `ReadOnly` is the default: the agent can inspect the workspace and plan,
/// but cannot edit or execute. Anything beyond that is an explicit opt-in
/// (spec §11, §13).
fn permission_flag(permissions: AgentPermissions) -> &'static str {
    match permissions {
        AgentPermissions::ReadOnly => "plan",
        AgentPermissions::Edits => "acceptEdits",
        AgentPermissions::Full => "bypassPermissions",
    }
}

fn agent_invocation(input: &str, settings: &Settings) -> (String, Vec<String>) {
    let mut args: Vec<String> = vec![
        "-p".into(),
        input.into(),
        "--output-format".into(),
        "stream-json".into(),
        // stream-json requires --verbose in print mode.
        "--verbose".into(),
        // Nothing can answer a prompt from here, so anything that would ask
        // is denied instead of hanging.
        "--permission-prompts".into(),
        "none".into(),
        "--permission-mode".into(),
        permission_flag(settings.agent_permissions).into(),
    ];
    if let Some(model) = settings.agent_model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    (settings.agent_command(), args)
}

/// Reads NDJSON from `pipe`, handing each parsed step to `sink`.
fn pump_steps<R: Read, S: FnMut(AgentStep)>(pipe: R, mut sink: S) {
    let reader = BufReader::new(pipe);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        for step in steps_from_line(&line) {
            sink(step);
        }
    }
}

#[tauri::command]
pub fn run_agent_task(
    app: AppHandle,
    state: State<'_, RunningAgents>,
    settings: State<'_, SettingsState>,
    entry_id: String,
    input: String,
    cwd: String,
) -> Result<(), String> {
    let dir = PathBuf::from(&cwd);
    if !dir.is_dir() {
        return Err(format!("no such directory: {cwd}"));
    }

    let started = Instant::now();
    let settings = settings.snapshot();
    let (program, args) = agent_invocation(&input, &settings);

    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "could not start `{program}`: {error}. \
                 Install Claude Code, or point Settings → Agent at its binary."
            )
        })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let child = Arc::new(Mutex::new(child));
    state
        .0
        .lock()
        .map_err(|_| "agent registry poisoned".to_string())?
        .insert(entry_id.clone(), Arc::clone(&child));

    let emit = {
        let app = app.clone();
        let entry_id = entry_id.clone();
        move |step: AgentStep| {
            let _ = app.emit(
                STEP_EVENT,
                StepEvent {
                    entry_id: entry_id.clone(),
                    step,
                },
            );
        }
    };

    let mut readers = Vec::new();
    if let Some(pipe) = stdout {
        let emit = emit.clone();
        readers.push(thread::spawn(move || pump_steps(pipe, emit)));
    }
    if let Some(pipe) = stderr {
        // stderr is diagnostics, not events; surface it verbatim as a notice.
        let emit = emit.clone();
        readers.push(thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if !line.trim().is_empty() {
                    emit(AgentStep::Notice { text: line });
                }
            }
        }));
    }

    thread::spawn(move || {
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

        if let Ok(mut registry) = app.state::<RunningAgents>().0.lock() {
            registry.remove(&entry_id);
        }
        let _ = app.emit(
            EXIT_EVENT,
            AgentExitEvent {
                entry_id,
                exit_code,
                duration_ms: started.elapsed().as_millis() as u64,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub fn kill_agent(state: State<'_, RunningAgents>, entry_id: String) -> Result<(), String> {
    let child = state
        .0
        .lock()
        .map_err(|_| "agent registry poisoned".to_string())?
        .get(&entry_id)
        .map(Arc::clone);

    match child {
        Some(child) => child
            .lock()
            .map_err(|_| "agent process poisoned".to_string())?
            .kill()
            .map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// Whether the configured agent binary can be found, so the UI can say so
/// before the user submits a task.
#[tauri::command]
pub fn agent_available(settings: State<'_, SettingsState>) -> bool {
    let command = settings.snapshot().agent_command();
    if command.contains('/') || command.contains('\\') {
        return Path::new(&command).is_file();
    }
    crate::shell::command_exists(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from `claude -p … --output-format stream-json` on 2026-09-20.
    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"6b29a9dd","tools":["Bash","Read"],"model":"claude-sonnet-5","permissionMode":"plan","claude_code_version":"2.1.278"}"#;
    const THINKING_TOKENS: &str = r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":422,"estimated_tokens_delta":122}"#;
    const TEXT: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]},"session_id":"6b29a9dd"}"#;
    const THINKING: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"secret reasoning","signature":"abc"}]}}"#;
    const RESULT: &str = r#"{"duration_api_ms":6715,"session_id":"6b29a9dd","total_cost_usd":0.0333893,"is_error":false,"num_turns":1,"subtype":"success","result":"pong","type":"result","duration_ms":7173,"permission_denials":[]}"#;

    #[test]
    fn init_becomes_a_started_step() {
        assert_eq!(
            steps_from_line(INIT),
            vec![AgentStep::Started {
                session_id: Some("6b29a9dd".into()),
                model: Some("claude-sonnet-5".into()),
                permission_mode: Some("plan".into()),
            }]
        );
    }

    #[test]
    fn assistant_prose_becomes_a_text_step() {
        assert_eq!(
            steps_from_line(TEXT),
            vec![AgentStep::Text {
                text: "pong".into()
            }]
        );
    }

    /// The whole point of the translation layer: reasoning never reaches the UI.
    #[test]
    fn thinking_blocks_are_never_forwarded() {
        assert!(steps_from_line(THINKING).is_empty());

        let redacted = r#"{"type":"assistant","message":{"content":[{"type":"redacted_thinking","data":"x"}]}}"#;
        assert!(steps_from_line(redacted).is_empty());

        // The token counter is liveness only and carries no content.
        assert_eq!(
            steps_from_line(THINKING_TOKENS),
            vec![AgentStep::Progress { tokens: 422 }]
        );
    }

    #[test]
    fn tool_use_is_summarised_per_tool() {
        let cases = [
            (
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/src/auth.ts"}}]}}"#,
                "Read",
                Some("/src/auth.ts"),
            ),
            (
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}"#,
                "Bash",
                Some("bun test"),
            ),
            (
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"expiry"}}]}}"#,
                "Grep",
                Some("expiry"),
            ),
            (
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Mystery","input":{"whatever":1}}]}}"#,
                "Mystery",
                None,
            ),
        ];

        for (line, name, detail) in cases {
            assert_eq!(
                steps_from_line(line),
                vec![AgentStep::Tool {
                    name: name.into(),
                    detail: detail.map(str::to_string),
                }],
                "for {name}"
            );
        }
    }

    #[test]
    fn a_long_command_is_flattened_and_elided() {
        let long = "a".repeat(400);
        let line = format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"{long}"}}}}]}}}}"#
        );
        let steps = steps_from_line(&line);
        let AgentStep::Tool { detail, .. } = &steps[0] else {
            panic!("expected a tool step");
        };
        let detail = detail.as_deref().expect("detail");
        assert!(detail.ends_with('…'));
        assert_eq!(detail.chars().count(), DETAIL_LIMIT + 1);
    }

    #[test]
    fn multiline_details_collapse_to_one_line() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cd /tmp\n  && ls -la"}}]}}"#;
        assert_eq!(
            steps_from_line(line),
            vec![AgentStep::Tool {
                name: "Bash".into(),
                detail: Some("cd /tmp && ls -la".into()),
            }]
        );
    }

    #[test]
    fn a_result_carries_the_summary_and_cost() {
        let steps = steps_from_line(RESULT);
        assert_eq!(
            steps,
            vec![AgentStep::Done {
                result: Some("pong".into()),
                is_error: false,
                turns: Some(1),
                duration_ms: Some(7173),
                cost_usd: Some(0.0333893),
                denials: 0,
            }]
        );
    }

    #[test]
    fn denials_are_counted_so_the_ui_can_explain_a_stalled_task() {
        let line = r#"{"type":"result","subtype":"error","is_error":true,"result":"blocked","permission_denials":[{"tool_name":"Bash"},{"tool_name":"Edit"}]}"#;
        let AgentStep::Done {
            is_error, denials, ..
        } = &steps_from_line(line)[0]
        else {
            panic!("expected a done step");
        };
        assert!(is_error);
        assert_eq!(*denials, 2);
    }

    #[test]
    fn unknown_and_malformed_lines_are_ignored() {
        assert!(steps_from_line("not json").is_empty());
        assert!(steps_from_line(r#"{"type":"future_event"}"#).is_empty());
        assert!(steps_from_line(r#"{"no_type":true}"#).is_empty());
        assert!(steps_from_line(r#"{"type":"system","subtype":"unknown"}"#).is_empty());
        // Empty prose is not worth a bubble.
        assert!(steps_from_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"  "}]}}"#
        )
        .is_empty());
    }

    #[test]
    fn a_stream_of_lines_pumps_in_order() {
        let stream = format!("{INIT}\n{THINKING}\n{THINKING_TOKENS}\n\n{TEXT}\n{RESULT}\n");
        let mut steps = Vec::new();
        pump_steps(stream.as_bytes(), |step| steps.push(step));

        assert_eq!(steps.len(), 4, "thinking dropped, blank line skipped");
        assert!(matches!(steps[0], AgentStep::Started { .. }));
        assert!(matches!(steps[1], AgentStep::Progress { .. }));
        assert!(matches!(steps[2], AgentStep::Text { .. }));
        assert!(matches!(steps[3], AgentStep::Done { .. }));
    }

    /// The wire shape is the contract with the TypeScript `AgentStep` union;
    /// a rename here silently breaks the UI, so it is pinned.
    #[test]
    fn steps_serialise_as_a_camel_case_tagged_union() {
        let json = serde_json::to_value(AgentStep::Started {
            session_id: Some("abc".into()),
            model: Some("claude-sonnet-5".into()),
            permission_mode: Some("plan".into()),
        })
        .unwrap();
        assert_eq!(json["kind"], "started");
        assert_eq!(json["sessionId"], "abc");
        assert_eq!(json["permissionMode"], "plan");

        let json = serde_json::to_value(AgentStep::Done {
            result: Some("ok".into()),
            is_error: false,
            turns: Some(3),
            duration_ms: Some(120),
            cost_usd: Some(0.5),
            denials: 1,
        })
        .unwrap();
        assert_eq!(json["kind"], "done");
        assert_eq!(json["isError"], false);
        assert_eq!(json["durationMs"], 120);
        assert_eq!(json["costUsd"], 0.5);

        let json = serde_json::to_value(AgentStep::Tool {
            name: "Read".into(),
            detail: None,
        })
        .unwrap();
        assert_eq!(json["kind"], "tool");
        assert!(json["detail"].is_null());
    }

    #[test]
    fn read_only_is_the_default_and_maps_to_plan_mode() {
        let settings = Settings::default();
        assert_eq!(settings.agent_permissions, AgentPermissions::ReadOnly);

        let (program, args) = agent_invocation("fix the build", &settings);
        assert_eq!(program, "claude");
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"fix the build".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--verbose".to_string()));

        let mode = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[mode + 1], "plan");

        let prompts = args.iter().position(|a| a == "--permission-prompts").unwrap();
        assert_eq!(args[prompts + 1], "none");

        // No model flag unless one is configured.
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn escalated_permissions_and_a_model_reach_the_argv() {
        let settings = Settings {
            agent_permissions: AgentPermissions::Full,
            agent_model: Some("opus".into()),
            ..Settings::default()
        };
        let (_, args) = agent_invocation("go", &settings);

        let mode = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[mode + 1], "bypassPermissions");

        let model = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[model + 1], "opus");
    }

    #[test]
    fn each_permission_level_has_a_distinct_mode() {
        assert_eq!(permission_flag(AgentPermissions::ReadOnly), "plan");
        assert_eq!(permission_flag(AgentPermissions::Edits), "acceptEdits");
        assert_eq!(permission_flag(AgentPermissions::Full), "bypassPermissions");
    }
}
