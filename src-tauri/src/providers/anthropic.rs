//! Anthropic Messages API provider.
//!
//! Raw HTTP, because there is no official Anthropic Rust SDK. The wire format
//! is translated into Forge's provider-neutral `AgentStep` vocabulary.
//!
//! Two model-specific facts drive the request shape (verified against the
//! current API reference, 2026-09):
//!
//! - `thinking` and `output_config` are omitted entirely. On Opus 5 and
//!   Sonnet 5 that still runs adaptive thinking; on Haiku 4.5 it runs without.
//!   Sending `budget_tokens` would be a 400 on the Claude 5 family, and
//!   `output_config.effort` errors on Haiku — omitting both is the only shape
//!   that is valid across every model we offer.
//! - Reasoning is never surfaced. `thinking_delta` events advance a progress
//!   indicator and their content is discarded (spec §12).

use serde_json::{json, Value};

use crate::agent::AgentStep;

pub const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
pub const API_VERSION: &str = "2023-06-01";

/// Default when the user has not chosen one.
pub const DEFAULT_MODEL: &str = "claude-opus-5";

/// Models offered in the settings dropdown, newest tier first.
pub const MODELS: &[&str] = &[
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-fable-5-1",
];

/// Conservative across every model we offer. Haiku's output ceiling is lower
/// than the Claude 5 family's 128K, and this is an advice-sized response, not
/// a code-generation one.
const MAX_TOKENS: u32 = 16_000;

/// USD per million tokens, (input, output).
fn pricing(model: &str) -> Option<(f64, f64)> {
    match model {
        "claude-opus-5" => Some((5.0, 25.0)),
        "claude-sonnet-5" => Some((2.0, 10.0)),
        "claude-haiku-4-5" => Some((1.0, 5.0)),
        "claude-fable-5-1" => Some((10.0, 50.0)),
        _ => None,
    }
}

pub fn request_body(model: &str, system: &str, prompt: &str) -> Value {
    json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": true,
        "system": system,
        "messages": [{ "role": "user", "content": prompt }],
    })
}

/// Translates the Anthropic event stream, carrying the running state that a
/// per-event function could not (token counts, model, stop reason).
#[derive(Default)]
pub struct AnthropicStream {
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    announced_thinking: bool,
    errored: bool,
}

impl AnthropicStream {
    fn cost(&self) -> Option<f64> {
        let (input, output) = pricing(self.model.as_deref()?)?;
        Some((self.input_tokens as f64 * input + self.output_tokens as f64 * output) / 1_000_000.0)
    }

    pub fn push(&mut self, data: &str) -> Vec<AgentStep> {
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };

        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                let message = event.get("message");
                self.model = message
                    .and_then(|m| m.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.input_tokens = message
                    .and_then(|m| m.pointer("/usage/input_tokens"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                vec![AgentStep::Started {
                    session_id: message
                        .and_then(|m| m.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model: self.model.clone(),
                }]
            }

            Some("content_block_start") => {
                // Announce that reasoning is under way, without its content.
                let is_thinking = event
                    .pointer("/content_block/type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.contains("thinking"));
                if is_thinking && !self.announced_thinking {
                    self.announced_thinking = true;
                    return vec![AgentStep::Progress { tokens: 0 }];
                }
                Vec::new()
            }

            Some("content_block_delta") => {
                match event.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => event
                        .pointer("/delta/text")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(|text| {
                            vec![AgentStep::Text {
                                text: text.to_string(),
                            }]
                        })
                        .unwrap_or_default(),
                    // Reasoning is dropped on the floor, deliberately.
                    Some("thinking_delta") | Some("signature_delta") => Vec::new(),
                    _ => Vec::new(),
                }
            }

            Some("message_delta") => {
                if let Some(tokens) = event
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64)
                {
                    self.output_tokens = tokens;
                }
                Vec::new()
            }

            Some("message_stop") => {
                if self.errored {
                    return Vec::new();
                }
                vec![AgentStep::Done {
                    result: None,
                    is_error: false,
                    cost_usd: self.cost(),
                }]
            }

            Some("error") => {
                self.errored = true;
                let message = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("the provider reported an error");
                let kind = event
                    .pointer("/error/type")
                    .and_then(Value::as_str)
                    .unwrap_or("error");
                vec![AgentStep::Done {
                    result: Some(format!("{kind}: {message}")),
                    is_error: true,
                    cost_usd: self.cost(),
                }]
            }

            // `ping` and anything added later.
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGE_START: &str = r#"{"type":"message_start","message":{"id":"msg_01","model":"claude-opus-5","usage":{"input_tokens":100}}}"#;
    const THINKING_START: &str = r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#;
    const THINKING_DELTA: &str = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"the user wants..."}}"#;
    const TEXT_DELTA: &str =
        r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Run "}}"#;
    const MESSAGE_DELTA: &str = r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}"#;

    #[test]
    fn the_request_omits_thinking_and_effort() {
        let body = request_body("claude-opus-5", "sys", "hi");
        assert_eq!(body["model"], "claude-opus-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hi");
        // Both would 400 on at least one model we offer.
        assert!(body.get("thinking").is_none());
        assert!(body.get("output_config").is_none());
        // budget_tokens is rejected outright on the Claude 5 family.
        assert!(body.to_string().find("budget_tokens").is_none());
    }

    #[test]
    fn model_ids_carry_no_date_suffix() {
        for model in MODELS {
            assert!(
                !model
                    .chars()
                    .rev()
                    .take(8)
                    .all(|c| c.is_ascii_digit() || c == '-'),
                "{model} looks date-suffixed"
            );
        }
        assert_eq!(DEFAULT_MODEL, "claude-opus-5");
    }

    #[test]
    fn a_message_start_reports_the_model() {
        let mut stream = AnthropicStream::default();
        assert_eq!(
            stream.push(MESSAGE_START),
            vec![AgentStep::Started {
                session_id: Some("msg_01".into()),
                model: Some("claude-opus-5".into()),
            }]
        );
    }

    #[test]
    fn text_deltas_stream_through_verbatim() {
        let mut stream = AnthropicStream::default();
        assert_eq!(
            stream.push(TEXT_DELTA),
            vec![AgentStep::Text {
                text: "Run ".into()
            }]
        );
    }

    /// The whole reason the translation layer exists.
    #[test]
    fn reasoning_never_becomes_a_step() {
        let mut stream = AnthropicStream::default();
        // The opening block announces work, with no content.
        assert_eq!(
            stream.push(THINKING_START),
            vec![AgentStep::Progress { tokens: 0 }]
        );
        // Repeat blocks do not re-announce.
        assert!(stream.push(THINKING_START).is_empty());
        // And the reasoning itself is discarded.
        assert!(stream.push(THINKING_DELTA).is_empty());
        assert!(stream
            .push(r#"{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"x"}}"#)
            .is_empty());
    }

    #[test]
    fn a_finished_message_reports_cost_from_usage() {
        let mut stream = AnthropicStream::default();
        stream.push(MESSAGE_START);
        stream.push(MESSAGE_DELTA);
        let steps = stream.push(r#"{"type":"message_stop"}"#);

        let AgentStep::Done {
            cost_usd, is_error, ..
        } = &steps[0]
        else {
            panic!("expected done");
        };
        assert!(!is_error);
        // 100 in @ $5/M + 50 out @ $25/M
        let expected = (100.0 * 5.0 + 50.0 * 25.0) / 1_000_000.0;
        assert!((cost_usd.unwrap() - expected).abs() < 1e-12);
    }

    #[test]
    fn an_unknown_model_reports_no_cost_rather_than_a_wrong_one() {
        let mut stream = AnthropicStream::default();
        stream.push(r#"{"type":"message_start","message":{"model":"claude-future-9","usage":{"input_tokens":10}}}"#);
        let steps = stream.push(r#"{"type":"message_stop"}"#);
        let AgentStep::Done { cost_usd, .. } = &steps[0] else {
            panic!("expected done");
        };
        assert_eq!(*cost_usd, None);
    }

    #[test]
    fn an_error_event_ends_the_stream_as_a_failure() {
        let mut stream = AnthropicStream::default();
        stream.push(MESSAGE_START);
        let steps = stream
            .push(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#);

        let AgentStep::Done {
            is_error, result, ..
        } = &steps[0]
        else {
            panic!("expected done");
        };
        assert!(is_error);
        assert_eq!(result.as_deref(), Some("overloaded_error: Overloaded"));

        // A trailing message_stop must not report a second, successful finish.
        assert!(stream.push(r#"{"type":"message_stop"}"#).is_empty());
    }

    #[test]
    fn pings_and_unknown_events_are_ignored() {
        let mut stream = AnthropicStream::default();
        assert!(stream.push(r#"{"type":"ping"}"#).is_empty());
        assert!(stream.push(r#"{"type":"something_new"}"#).is_empty());
        assert!(stream.push("not json").is_empty());
        assert!(stream
            .push(r#"{"type":"content_block_stop","index":0}"#)
            .is_empty());
    }
}
