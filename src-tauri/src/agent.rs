//! The agent runtime.
//!
//! A task is one streaming request to the configured provider. Provider wire
//! formats are translated in `crate::providers` into the small, neutral
//! `AgentStep` vocabulary below, which is all the UI ever sees.
//!
//! The agent cannot yet read files or run commands — there is no tool loop
//! (that is milestone 11). The system prompt says so explicitly, so the model
//! gives exact commands to run rather than claiming to have acted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::providers::{self, sse::SseDecoder, Provider};
use crate::secrets;
use crate::settings::SettingsState;
use crate::workspace::project_summary;

pub const STEP_EVENT: &str = "agent://step";
pub const EXIT_EVENT: &str = "agent://exit";

/// Cancellation flags keyed by the timeline entry that owns the task.
#[derive(Default)]
pub struct RunningAgents(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// One connection pool for the process.
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Generous: a long answer streams for a while, and the read
            // timeout below is what actually catches a dead connection.
            .connect_timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default()
    })
}

/// Provider-neutral view of what the agent is doing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentStep {
    Started {
        session_id: Option<String>,
        model: Option<String>,
    },
    /// Prose for the user. Arrives as deltas and is merged by the UI.
    Text { text: String },
    /// Liveness only — `0` means "working", never any reasoning content.
    Progress { tokens: u64 },
    /// Terminal step. `result` carries the message when `is_error` is set;
    /// on success the prose has already arrived as `Text`.
    Done {
        result: Option<String>,
        is_error: bool,
        cost_usd: Option<f64>,
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

/// Targeted workspace context, not a dump of the machine (spec §16).
pub fn system_prompt(cwd: &str, os: &str, arch: &str) -> String {
    let project = project_summary(std::path::Path::new(cwd));
    format!(
        "You are the agent built into Forge, a terminal emulator. You are \
         answering inside a terminal session.\n\n\
         Working directory: {cwd}\n\
         Platform: {os}/{arch}\n\
         {project}\n\
         Write for a terminal: plain text, tight, no markdown headings and no \
         decorative formatting. Prefer a concrete command over a description \
         of one.\n\n\
         You cannot read files, edit them, or run commands. Do not claim to \
         have done any of those things. When an action is needed, give the \
         exact command for the user to run."
    )
}

fn emit_step(app: &AppHandle, entry_id: &str, step: AgentStep) {
    let _ = app.emit(
        STEP_EVENT,
        StepEvent {
            entry_id: entry_id.to_string(),
            step,
        },
    );
}

#[tauri::command]
pub async fn run_agent_task(
    app: AppHandle,
    entry_id: String,
    input: String,
    cwd: String,
) -> Result<(), String> {
    let settings = app.state::<SettingsState>().snapshot();
    let provider = settings.provider;

    let Some(key) = secrets::get(provider.account()) else {
        return Err(format!(
            "No {} API key is set. Add one in Settings — keys are at {}.",
            provider.label(),
            provider.console_url()
        ));
    };

    let model = settings
        .agent_model
        .clone()
        .or_else(|| provider.default_model().map(str::to_string))
        .ok_or_else(|| {
            format!(
                "No {} model is selected. Choose one in Settings.",
                provider.label()
            )
        })?;

    let system = system_prompt(&cwd, std::env::consts::OS, std::env::consts::ARCH);
    let body = provider.request_body(&model, &system, &input);

    let cancelled = Arc::new(AtomicBool::new(false));
    app.state::<RunningAgents>()
        .0
        .lock()
        .map_err(|_| "agent registry poisoned".to_string())?
        .insert(entry_id.clone(), Arc::clone(&cancelled));

    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let outcome = stream_task(&app, &entry_id, provider, &key, body, &cancelled).await;

        if let Err(message) = outcome {
            emit_step(
                &app,
                &entry_id,
                AgentStep::Done {
                    result: Some(message),
                    is_error: true,
                    cost_usd: None,
                },
            );
        }

        if let Ok(mut registry) = app.state::<RunningAgents>().0.lock() {
            registry.remove(&entry_id);
        }
        let _ = app.emit(
            EXIT_EVENT,
            AgentExitEvent {
                entry_id,
                exit_code: if cancelled.load(Ordering::Relaxed) {
                    None
                } else {
                    Some(0)
                },
                duration_ms: started.elapsed().as_millis() as u64,
            },
        );
    });

    Ok(())
}

async fn stream_task(
    app: &AppHandle,
    entry_id: &str,
    provider: Provider,
    key: &str,
    body: Value,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let request = http().post(provider.endpoint()).json(&body);
    let request = match provider {
        Provider::Anthropic => request
            .header("x-api-key", key)
            .header("anthropic-version", providers::anthropic::API_VERSION),
        Provider::OpenAi => request.header("authorization", format!("Bearer {key}")),
    };

    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach {}: {error}", provider.label()))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(providers::explain_status(provider, status.as_u16(), &body));
    }

    let mut translator = provider.translator();
    let mut decoder = SseDecoder::default();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(());
        }
        let chunk = chunk.map_err(|error| format!("Stream ended early: {error}"))?;
        // Chunks split at arbitrary byte boundaries; the decoder reassembles.
        let text = String::from_utf8_lossy(&chunk);
        for data in decoder.push(&text) {
            for step in translator.push(&data) {
                emit_step(app, entry_id, step);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn kill_agent(state: State<'_, RunningAgents>, entry_id: String) -> Result<(), String> {
    if let Some(flag) = state
        .0
        .lock()
        .map_err(|_| "agent registry poisoned".to_string())?
        .get(&entry_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Whether a task can run right now: a key, and a model to send it to.
#[tauri::command]
pub fn agent_ready(state: State<'_, SettingsState>) -> bool {
    let settings = state.snapshot();
    let has_model = settings.agent_model.is_some() || settings.provider.default_model().is_some();
    secrets::has(settings.provider.account()) && has_model
}

#[tauri::command]
pub fn has_api_key(provider: Provider) -> bool {
    secrets::has(provider.account())
}

#[tauri::command]
pub fn set_api_key(provider: Provider, key: String) -> Result<(), String> {
    secrets::set(provider.account(), &key)
}

#[tauri::command]
pub fn clear_api_key(provider: Provider) -> Result<(), String> {
    secrets::delete(provider.account())
}

/// Models the account can actually use. Anthropic's list is static; OpenAI's
/// is fetched, because its model ids change too often to hardcode.
#[tauri::command]
pub async fn list_models(provider: Provider) -> Result<Vec<String>, String> {
    match provider {
        Provider::Anthropic => Ok(providers::anthropic::MODELS
            .iter()
            .map(|model| model.to_string())
            .collect()),
        Provider::OpenAi => {
            let key = secrets::get(provider.account())
                .ok_or_else(|| "Add an OpenAI API key first.".to_string())?;
            let response = http()
                .get(providers::openai::MODELS_ENDPOINT)
                .header("authorization", format!("Bearer {key}"))
                .send()
                .await
                .map_err(|error| format!("Could not reach OpenAI: {error}"))?;

            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(providers::explain_status(provider, status.as_u16(), &body));
            }
            let payload: Value = serde_json::from_str(&body)
                .map_err(|error| format!("Unexpected model list: {error}"))?;
            Ok(providers::openai::usable_models(&payload))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_serialise_as_a_camel_case_tagged_union() {
        let json = serde_json::to_value(AgentStep::Started {
            session_id: Some("abc".into()),
            model: Some("claude-opus-5".into()),
        })
        .unwrap();
        assert_eq!(json["kind"], "started");
        assert_eq!(json["sessionId"], "abc");

        let json = serde_json::to_value(AgentStep::Done {
            result: Some("ok".into()),
            is_error: false,
            cost_usd: Some(0.5),
        })
        .unwrap();
        assert_eq!(json["kind"], "done");
        assert_eq!(json["isError"], false);
        assert_eq!(json["costUsd"], 0.5);
    }

    #[test]
    fn the_system_prompt_carries_targeted_context_and_states_its_limits() {
        let prompt = system_prompt("/home/dev/app", "linux", "x86_64");
        assert!(prompt.contains("/home/dev/app"));
        assert!(prompt.contains("linux/x86_64"));
        // The model must not claim to have acted (no tool loop yet).
        assert!(prompt.contains("cannot read files"));
        assert!(prompt.contains("Do not claim"));
        // And it should answer like a terminal, not a chat window.
        assert!(prompt.contains("no markdown headings"));
    }

    #[test]
    fn the_prompt_does_not_leak_the_whole_machine() {
        let prompt = system_prompt("/tmp", "linux", "x86_64");
        // Targeted context only: no env dump, no history, no file contents.
        assert!(prompt.len() < 1200, "prompt is {} chars", prompt.len());
    }
}
