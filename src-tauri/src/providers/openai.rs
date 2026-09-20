//! OpenAI Chat Completions provider.
//!
//! Deliberately conservative about request parameters. OpenAI's newer
//! reasoning models renamed `max_tokens` to `max_completion_tokens` and reject
//! the old name, so no token cap is sent at all and the server default applies
//! — that keeps one request shape valid across the whole model range.
//!
//! For the same reason there is no hardcoded model list or default: model IDs
//! change often and guessing one produces a confusing 404. The list is fetched
//! from the account's own `/v1/models` once a key is present.

use serde_json::{json, Value};

use crate::agent::AgentStep;

pub const ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";
pub const MODELS_ENDPOINT: &str = "https://api.openai.com/v1/models";

/// Terminal sentinel; not JSON.
const DONE: &str = "[DONE]";

pub fn request_body(model: &str, system: &str, prompt: &str) -> Value {
    json!({
        "model": model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": prompt },
        ],
    })
}

/// Keeps only chat-capable models out of the account's full list, which also
/// contains embedding, audio and image models.
pub fn usable_models(payload: &Value) -> Vec<String> {
    let mut models: Vec<String> = payload
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .filter(|id| {
            !id.contains("embedding")
                && !id.contains("whisper")
                && !id.contains("tts")
                && !id.contains("dall-e")
                && !id.contains("moderation")
                && !id.contains("transcribe")
                && !id.contains("realtime")
                && !id.contains("image")
                && !id.contains("audio")
        })
        .map(str::to_string)
        .collect();
    models.sort();
    models.dedup();
    models
}

#[derive(Default)]
pub struct OpenAiStream {
    model: Option<String>,
    finished: bool,
    errored: bool,
}

impl OpenAiStream {
    pub fn push(&mut self, data: &str) -> Vec<AgentStep> {
        if data.trim() == DONE {
            if self.finished || self.errored {
                return Vec::new();
            }
            self.finished = true;
            return vec![AgentStep::Done {
                result: None,
                is_error: false,
                // No verified price table for OpenAI, so no invented number.
                cost_usd: None,
            }];
        }

        let Ok(event) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };

        // Mid-stream failures arrive in-band rather than as an HTTP status.
        if let Some(message) = event.pointer("/error/message").and_then(Value::as_str) {
            self.errored = true;
            return vec![AgentStep::Done {
                result: Some(message.to_string()),
                is_error: true,
                cost_usd: None,
            }];
        }

        let mut steps = Vec::new();

        // The first chunk names the model that actually served the request.
        if self.model.is_none() {
            if let Some(model) = event.get("model").and_then(Value::as_str) {
                self.model = Some(model.to_string());
                steps.push(AgentStep::Started {
                    session_id: event.get("id").and_then(Value::as_str).map(str::to_string),
                    model: self.model.clone(),
                });
            }
        }

        if let Some(text) = event
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            steps.push(AgentStep::Text {
                text: text.to_string(),
            });
        }

        steps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHUNK: &str = r#"{"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-x","choices":[{"index":0,"delta":{"content":"Run "},"finish_reason":null}]}"#;

    #[test]
    fn no_token_cap_is_sent() {
        let body = request_body("gpt-x", "sys", "hi");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "hi");
        // Reasoning models reject `max_tokens`; the rename would break others.
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn the_first_chunk_announces_the_serving_model_once() {
        let mut stream = OpenAiStream::default();
        let steps = stream.push(CHUNK);
        assert_eq!(steps.len(), 2, "started + text");
        assert!(matches!(steps[0], AgentStep::Started { .. }));
        assert_eq!(
            steps[1],
            AgentStep::Text {
                text: "Run ".into()
            }
        );

        // A second chunk yields only text.
        assert_eq!(
            stream.push(CHUNK),
            vec![AgentStep::Text {
                text: "Run ".into()
            }]
        );
    }

    #[test]
    fn the_done_sentinel_finishes_once() {
        let mut stream = OpenAiStream::default();
        let steps = stream.push("[DONE]");
        assert!(matches!(
            steps[0],
            AgentStep::Done {
                is_error: false,
                ..
            }
        ));
        assert!(stream.push("[DONE]").is_empty(), "no double finish");
    }

    #[test]
    fn an_in_band_error_finishes_as_a_failure_and_suppresses_done() {
        let mut stream = OpenAiStream::default();
        let steps =
            stream.push(r#"{"error":{"message":"Rate limit reached","type":"rate_limit_error"}}"#);
        let AgentStep::Done {
            is_error, result, ..
        } = &steps[0]
        else {
            panic!("expected done");
        };
        assert!(is_error);
        assert_eq!(result.as_deref(), Some("Rate limit reached"));
        assert!(stream.push("[DONE]").is_empty());
    }

    #[test]
    fn empty_deltas_and_finish_chunks_produce_nothing() {
        let mut stream = OpenAiStream::default();
        stream.push(CHUNK);
        assert!(stream
            .push(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#)
            .is_empty());
        assert!(stream
            .push(r#"{"choices":[{"delta":{"content":""}}]}"#)
            .is_empty());
        assert!(stream.push("not json").is_empty());
    }

    #[test]
    fn the_model_list_drops_non_chat_models() {
        let payload = json!({"data":[
            {"id":"gpt-x"},
            {"id":"gpt-x-mini"},
            {"id":"text-embedding-3-large"},
            {"id":"whisper-1"},
            {"id":"dall-e-3"},
            {"id":"tts-1"},
            {"id":"omni-moderation-latest"},
            {"id":"gpt-x-audio-preview"},
            {"id":"gpt-x-realtime"},
            {"id":"gpt-x"}
        ]});
        assert_eq!(usable_models(&payload), vec!["gpt-x", "gpt-x-mini"]);
    }

    #[test]
    fn a_malformed_model_list_yields_nothing_rather_than_panicking() {
        assert!(usable_models(&json!({})).is_empty());
        assert!(usable_models(&json!({"data": "nope"})).is_empty());
    }
}
