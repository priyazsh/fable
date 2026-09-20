//! Server-sent event framing.
//!
//! Both providers stream SSE, so the line protocol is shared. Per the spec an
//! event ends at a blank line and multiple `data:` lines in one event are
//! joined with newlines. Chunks arrive at arbitrary byte boundaries, so the
//! decoder buffers partial lines across reads.

#[derive(Default)]
pub struct SseDecoder {
    buffer: String,
    data: Vec<String>,
}

impl SseDecoder {
    /// Feeds a chunk, returning the payload of every event completed by it.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();

        while let Some(position) = self.buffer.find('\n') {
            let line = self.buffer[..position].trim_end_matches('\r').to_string();
            self.buffer.drain(..=position);

            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
                continue;
            }

            // Comments and the `event:` / `id:` / `retry:` fields are ignored:
            // both providers repeat the event name inside the JSON payload.
            if let Some(value) = line.strip_prefix("data:") {
                self.data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
        }

        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_events_on_blank_lines() {
        let mut decoder = SseDecoder::default();
        let events = decoder.push("event: a\ndata: one\n\nevent: b\ndata: two\n\n");
        assert_eq!(events, vec!["one", "two"]);
    }

    #[test]
    fn buffers_across_chunk_boundaries() {
        let mut decoder = SseDecoder::default();
        // A payload split mid-token, mid-line and mid-terminator.
        assert!(decoder.push("data: {\"te").is_empty());
        assert!(decoder.push("xt\":\"hi\"}").is_empty());
        assert!(decoder.push("\n").is_empty(), "no blank line yet");
        assert_eq!(decoder.push("\n"), vec![r#"{"text":"hi"}"#]);
    }

    #[test]
    fn joins_multiple_data_lines_in_one_event() {
        let mut decoder = SseDecoder::default();
        assert_eq!(decoder.push("data: a\ndata: b\n\n"), vec!["a\nb"]);
    }

    #[test]
    fn tolerates_crlf_and_missing_space_after_colon() {
        let mut decoder = SseDecoder::default();
        assert_eq!(decoder.push("data:x\r\n\r\n"), vec!["x"]);
    }

    #[test]
    fn ignores_comments_and_other_fields() {
        let mut decoder = SseDecoder::default();
        let events = decoder.push(": keep-alive\nevent: ping\nid: 7\ndata: real\n\n");
        assert_eq!(events, vec!["real"]);
    }

    #[test]
    fn a_blank_line_with_no_data_emits_nothing() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push("\n\n: comment\n\n").is_empty());
    }
}
