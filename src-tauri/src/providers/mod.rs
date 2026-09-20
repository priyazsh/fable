//! Agent providers.
//!
//! Each provider translates its own wire format into Forge's `AgentStep`
//! vocabulary, so nothing above this layer knows either vendor's schema
//! (spec §9). Adding a provider means adding a module and two match arms.

pub mod anthropic;
pub mod openai;
pub mod sse;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::AgentStep;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    #[default]
    Anthropic,
    #[serde(rename = "openai")]
    OpenAi,
}

impl Provider {
    /// Keyring account name. Stable across releases — changing it orphans keys.
    pub fn account(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Anthropic => "Anthropic",
            Self::OpenAi => "OpenAI",
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::Anthropic => anthropic::ENDPOINT,
            Self::OpenAi => openai::ENDPOINT,
        }
    }

    /// Where to get a key, shown when one is missing.
    pub fn console_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://console.anthropic.com/settings/keys",
            Self::OpenAi => "https://platform.openai.com/api-keys",
        }
    }

    pub fn default_model(self) -> Option<&'static str> {
        match self {
            Self::Anthropic => Some(anthropic::DEFAULT_MODEL),
            // Model IDs move too often to hardcode; the list is fetched.
            Self::OpenAi => None,
        }
    }

    pub fn request_body(self, model: &str, system: &str, prompt: &str) -> Value {
        match self {
            Self::Anthropic => anthropic::request_body(model, system, prompt),
            Self::OpenAi => openai::request_body(model, system, prompt),
        }
    }

    pub fn translator(self) -> Translator {
        match self {
            Self::Anthropic => Translator::Anthropic(anthropic::AnthropicStream::default()),
            Self::OpenAi => Translator::OpenAi(openai::OpenAiStream::default()),
        }
    }
}

pub enum Translator {
    Anthropic(anthropic::AnthropicStream),
    OpenAi(openai::OpenAiStream),
}

impl Translator {
    pub fn push(&mut self, data: &str) -> Vec<AgentStep> {
        match self {
            Self::Anthropic(stream) => stream.push(data),
            Self::OpenAi(stream) => stream.push(data),
        }
    }
}

/// Both vendors report failures at the same JSON path.
pub fn error_message(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Turns a non-2xx response into something a user can act on.
pub fn explain_status(provider: Provider, status: u16, body: &str) -> String {
    let detail = error_message(body).unwrap_or_else(|| body.chars().take(200).collect());
    let name = provider.label();

    match status {
        401 | 403 => format!(
            "{name} rejected the API key. Check it in Settings — keys are at {}.",
            provider.console_url()
        ),
        404 => {
            format!("{name} does not recognise that model. Pick another in Settings. ({detail})")
        }
        429 => format!("{name} rate-limited this request. Wait a moment and try again."),
        500..=599 => format!("{name} is having trouble (HTTP {status}). Try again shortly."),
        400 => format!("{name} rejected the request: {detail}"),
        _ => format!("{name} returned HTTP {status}: {detail}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_round_trip_through_the_settings_file() {
        for provider in [Provider::Anthropic, Provider::OpenAi] {
            let json = serde_json::to_string(&provider).unwrap();
            assert_eq!(serde_json::from_str::<Provider>(&json).unwrap(), provider);
        }
        // Pinned: these strings are the TypeScript union and the keyring key.
        assert_eq!(
            serde_json::to_string(&Provider::Anthropic).unwrap(),
            "\"anthropic\""
        );
        assert_eq!(
            serde_json::to_string(&Provider::OpenAi).unwrap(),
            "\"openai\""
        );
        assert_eq!(Provider::Anthropic.account(), "anthropic");
        assert_eq!(Provider::OpenAi.account(), "openai");
    }

    #[test]
    fn anthropic_is_the_default_and_has_a_default_model() {
        assert_eq!(Provider::default(), Provider::Anthropic);
        assert_eq!(Provider::Anthropic.default_model(), Some("claude-opus-5"));
        // Guessing an OpenAI model id produces a confusing 404, so we do not.
        assert_eq!(Provider::OpenAi.default_model(), None);
    }

    #[test]
    fn both_vendors_report_errors_at_the_same_path() {
        assert_eq!(
            error_message(r#"{"error":{"message":"bad key","type":"authentication_error"}}"#),
            Some("bad key".into())
        );
        assert_eq!(error_message("not json"), None);
        assert_eq!(error_message("{}"), None);
    }

    #[test]
    fn status_codes_become_actionable_advice() {
        let auth = explain_status(Provider::Anthropic, 401, "{}");
        assert!(auth.contains("Settings"), "{auth}");
        assert!(auth.contains("console.anthropic.com"), "{auth}");

        let limit = explain_status(Provider::OpenAi, 429, "{}");
        assert!(
            limit.contains("OpenAI") && limit.contains("rate-limited"),
            "{limit}"
        );

        let missing = explain_status(
            Provider::OpenAi,
            404,
            r#"{"error":{"message":"no such model"}}"#,
        );
        assert!(
            missing.contains("Pick another") && missing.contains("no such model"),
            "{missing}"
        );

        let down = explain_status(Provider::Anthropic, 503, "{}");
        assert!(down.contains("503"), "{down}");
    }

    #[test]
    fn a_huge_html_error_body_is_truncated_rather_than_dumped() {
        let body = "<html>".to_string() + &"x".repeat(5000);
        let message = explain_status(Provider::OpenAi, 502, &body);
        assert!(message.len() < 400, "got {} chars", message.len());
    }
}
