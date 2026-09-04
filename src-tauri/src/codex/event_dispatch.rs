use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::diagnostics::DiagnosticsState;
use super::protocol::CodexEvent;

pub const EVENT_CODEX_BATCH: &str = "codex:events";

const EVENT_QUEUE_CAPACITY: usize = 2_048;
const MAX_BATCH_EVENTS: usize = 128;
const MAX_BATCH_LATENCY: Duration = Duration::from_millis(8);

pub fn spawn(
    app: AppHandle,
    diagnostics: Arc<DiagnosticsState>,
) -> std::io::Result<SyncSender<CodexEvent>> {
    let (sender, receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
    std::thread::Builder::new()
        .name("codex-ui-events".to_string())
        .spawn(move || dispatch(receiver, app, diagnostics))?;
    Ok(sender)
}

fn dispatch(receiver: Receiver<CodexEvent>, app: AppHandle, diagnostics: Arc<DiagnosticsState>) {
    while let Ok(first) = receiver.recv() {
        let started = Instant::now();
        let mut disconnected = false;
        let mut events = vec![first];
        while events.len() < MAX_BATCH_EVENTS {
            let Some(remaining) = MAX_BATCH_LATENCY.checked_sub(started.elapsed()) else {
                break;
            };
            match receiver.recv_timeout(remaining) {
                Ok(event) => events.push(event),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        let events = coalesce_events(events);
        if let Err(error) = app.emit(EVENT_CODEX_BATCH, &events) {
            diagnostics.push_protocol_error(&format!("Unable to emit Codex event batch: {error}"));
        }
        if disconnected {
            break;
        }
    }
}

fn can_coalesce_delta(previous: &CodexEvent, next: &CodexEvent) -> bool {
    previous.delta.is_some()
        && next.delta.is_some()
        && matches!(
            previous.kind.as_str(),
            "agentMessageDelta"
                | "commandOutputDelta"
                | "fileChangeOutputDelta"
                | "planDelta"
                | "reasoningDelta"
                | "reasoningSummaryDelta"
        )
        && previous.kind == next.kind
        && previous.method == next.method
        && previous.thread_id == next.thread_id
        && previous.turn_id == next.turn_id
        && previous.item_id == next.item_id
        && previous.thread.is_none()
        && previous.turn.is_none()
        && previous.item.is_none()
        && previous.approval.is_none()
        && previous.token_usage.is_none()
        && previous.error.is_none()
        && next.thread.is_none()
        && next.turn.is_none()
        && next.item.is_none()
        && next.approval.is_none()
        && next.token_usage.is_none()
        && next.error.is_none()
}

pub(crate) fn coalesce_events(events: Vec<CodexEvent>) -> Vec<CodexEvent> {
    let mut result: Vec<CodexEvent> = Vec::with_capacity(events.len());
    for mut event in events {
        let Some(previous) = result.last_mut() else {
            result.push(event);
            continue;
        };
        if can_coalesce_delta(previous, &event) {
            let mut delta = previous.delta.take().unwrap_or_default();
            delta.push_str(event.delta.as_deref().unwrap_or_default());
            event.delta = Some(delta);
            *previous = event;
        } else {
            result.push(event);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::coalesce_events;
    use crate::codex::protocol::CodexEvent;

    fn delta(sequence: u64, item_id: &str, value: &str) -> CodexEvent {
        CodexEvent {
            sequence,
            kind: "agentMessageDelta".to_string(),
            method: "item/agentMessage/delta".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some(item_id.to_string()),
            delta: Some(value.to_string()),
            ..CodexEvent::default()
        }
    }

    #[test]
    fn adjacent_streaming_deltas_share_one_ui_event() {
        let events = coalesce_events(vec![
            delta(1, "agent-1", "Hello"),
            delta(2, "agent-1", " world"),
            delta(3, "agent-2", "Separate"),
        ]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].sequence, 2);
        assert_eq!(events[0].delta.as_deref(), Some("Hello world"));
        assert_eq!(events[1].item_id.as_deref(), Some("agent-2"));
    }

    #[test]
    fn lifecycle_events_preserve_order_and_boundaries() {
        let completed = CodexEvent {
            sequence: 2,
            kind: "turnCompleted".to_string(),
            method: "turn/completed".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            ..CodexEvent::default()
        };
        let events = coalesce_events(vec![
            delta(1, "agent-1", "Done"),
            completed,
            delta(3, "agent-1", "."),
        ]);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].sequence, 1);
        assert_eq!(events[1].kind, "turnCompleted");
        assert_eq!(events[2].sequence, 3);
    }
}
