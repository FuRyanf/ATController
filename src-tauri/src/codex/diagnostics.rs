use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const MAX_STDERR_LINES: usize = 120;
const MAX_PROTOCOL_ERRORS: usize = 80;
const MAX_DIAGNOSTIC_LINE_CHARS: usize = 2_000;
const GENERATED_PROTOCOL_VERSION_JSON: &str =
    include_str!("../../../generated/codex-app-server/version.json");

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    #[default]
    Stopped,
    Starting,
    Initializing,
    Ready,
    Degraded,
    Restarting,
    Failed,
    Stopping,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExitInfo {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexDiagnostics {
    pub atcontroller_version: String,
    pub codex_binary_path: Option<String>,
    pub codex_version: Option<String>,
    pub app_server_supported: bool,
    pub generated_schema_version: String,
    pub transport: String,
    pub connection_state: ConnectionState,
    pub initialized: bool,
    pub process_id: Option<u32>,
    pub process_uptime_ms: Option<u64>,
    pub codex_home: Option<String>,
    pub platform_family: Option<String>,
    pub platform_os: Option<String>,
    pub authentication_state: Option<String>,
    pub plan_type: Option<String>,
    pub current_model: Option<String>,
    pub current_reasoning_effort: Option<String>,
    pub current_permission_profile: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox_policy: Option<String>,
    pub workspace_path: Option<String>,
    pub active_thread_id: Option<String>,
    pub active_turn_id: Option<String>,
    pub pending_requests: usize,
    pub event_queue_depth: usize,
    pub recent_stderr: Vec<String>,
    pub recent_protocol_errors: Vec<String>,
    pub last_process_exit: Option<ProcessExitInfo>,
    pub restart_attempts: u32,
}

#[derive(Debug)]
struct DiagnosticsData {
    binary_path: Option<String>,
    version: Option<String>,
    app_server_supported: bool,
    state: ConnectionState,
    initialized: bool,
    pid: Option<u32>,
    started_at: Option<Instant>,
    codex_home: Option<String>,
    platform_family: Option<String>,
    platform_os: Option<String>,
    authentication_state: Option<String>,
    plan_type: Option<String>,
    current_model: Option<String>,
    current_reasoning_effort: Option<String>,
    current_permission_profile: Option<String>,
    approval_policy: Option<String>,
    sandbox_policy: Option<String>,
    workspace_path: Option<String>,
    active_thread_id: Option<String>,
    active_turn_id: Option<String>,
    stderr: VecDeque<String>,
    protocol_errors: VecDeque<String>,
    last_exit: Option<ProcessExitInfo>,
    restart_attempts: u32,
}

impl Default for DiagnosticsData {
    fn default() -> Self {
        Self {
            binary_path: None,
            version: None,
            app_server_supported: false,
            state: ConnectionState::Stopped,
            initialized: false,
            pid: None,
            started_at: None,
            codex_home: None,
            platform_family: None,
            platform_os: None,
            authentication_state: None,
            plan_type: None,
            current_model: None,
            current_reasoning_effort: None,
            current_permission_profile: None,
            approval_policy: None,
            sandbox_policy: None,
            workspace_path: None,
            active_thread_id: None,
            active_turn_id: None,
            stderr: VecDeque::new(),
            protocol_errors: VecDeque::new(),
            last_exit: None,
            restart_attempts: 0,
        }
    }
}

#[derive(Debug, Default)]
pub struct DiagnosticsState {
    data: Mutex<DiagnosticsData>,
    pending_requests: AtomicUsize,
    queue_depth: AtomicUsize,
}

impl DiagnosticsState {
    pub fn snapshot(&self) -> CodexDiagnostics {
        let data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        CodexDiagnostics {
            atcontroller_version: env!("CARGO_PKG_VERSION").to_string(),
            codex_binary_path: data.binary_path.clone(),
            codex_version: data.version.clone(),
            app_server_supported: data.app_server_supported,
            generated_schema_version: generated_schema_version(),
            transport: "stdio JSONL".to_string(),
            connection_state: data.state,
            initialized: data.initialized,
            process_id: data.pid,
            process_uptime_ms: data
                .started_at
                .map(|started| duration_millis(started.elapsed())),
            codex_home: data.codex_home.clone(),
            platform_family: data.platform_family.clone(),
            platform_os: data.platform_os.clone(),
            authentication_state: data.authentication_state.clone(),
            plan_type: data.plan_type.clone(),
            current_model: data.current_model.clone(),
            current_reasoning_effort: data.current_reasoning_effort.clone(),
            current_permission_profile: data.current_permission_profile.clone(),
            approval_policy: data.approval_policy.clone(),
            sandbox_policy: data.sandbox_policy.clone(),
            workspace_path: data.workspace_path.clone(),
            active_thread_id: data.active_thread_id.clone(),
            active_turn_id: data.active_turn_id.clone(),
            pending_requests: self.pending_requests.load(Ordering::Relaxed),
            event_queue_depth: self.queue_depth.load(Ordering::Relaxed),
            recent_stderr: data.stderr.iter().cloned().collect(),
            recent_protocol_errors: data.protocol_errors.iter().cloned().collect(),
            last_process_exit: data.last_exit.clone(),
            restart_attempts: data.restart_attempts,
        }
    }

    pub fn set_discovery(&self, binary_path: String, version: String, supported: bool) {
        self.with_data(|data| {
            data.binary_path = Some(binary_path);
            data.version = Some(version);
            data.app_server_supported = supported;
        });
    }

    pub fn set_state(&self, state: ConnectionState) {
        self.with_data(|data| data.state = state);
    }

    pub fn set_process(&self, pid: u32) {
        self.with_data(|data| {
            data.pid = Some(pid);
            data.started_at = Some(Instant::now());
            data.initialized = false;
        });
    }

    pub fn set_initialized(&self, result: &serde_json::Value) {
        self.with_data(|data| {
            data.initialized = true;
            data.codex_home = string_at(result, "codexHome");
            data.platform_family = string_at(result, "platformFamily");
            data.platform_os = string_at(result, "platformOs");
        });
    }

    pub fn set_restart_attempts(&self, attempts: u32) {
        self.with_data(|data| data.restart_attempts = attempts);
    }

    pub fn set_context(
        &self,
        workspace_path: Option<String>,
        thread_id: Option<String>,
        turn_id: Option<String>,
    ) {
        self.with_data(|data| {
            if workspace_path.is_some() {
                data.workspace_path = workspace_path;
            }
            if thread_id.is_some() {
                data.active_thread_id = thread_id;
            }
            data.active_turn_id = turn_id;
        });
    }

    pub fn set_effective_settings(
        &self,
        model: Option<String>,
        effort: Option<String>,
        permission_profile: Option<String>,
        approval_policy: Option<String>,
        sandbox_policy: Option<String>,
    ) {
        self.with_data(|data| {
            if model.is_some() {
                data.current_model = model;
            }
            if effort.is_some() {
                data.current_reasoning_effort = effort;
            }
            if permission_profile.is_some() {
                data.current_permission_profile = permission_profile;
            }
            if approval_policy.is_some() {
                data.approval_policy = approval_policy;
            }
            if sandbox_policy.is_some() {
                data.sandbox_policy = sandbox_policy;
            }
        });
    }

    pub fn set_account(&self, state: Option<String>, plan_type: Option<String>) {
        self.with_data(|data| {
            data.authentication_state = state;
            data.plan_type = plan_type;
        });
    }

    pub fn note_exit(&self, exit: ProcessExitInfo) {
        self.with_data(|data| {
            data.pid = None;
            data.started_at = None;
            data.initialized = false;
            data.active_turn_id = None;
            data.last_exit = Some(exit);
        });
    }

    pub fn push_stderr(&self, line: &str) {
        let redacted = redact_sensitive(line);
        if redacted.trim().is_empty() {
            return;
        }
        self.with_data(|data| push_bounded(&mut data.stderr, redacted, MAX_STDERR_LINES));
    }

    pub fn push_protocol_error(&self, line: &str) {
        let redacted = redact_sensitive(line);
        self.with_data(|data| {
            push_bounded(&mut data.protocol_errors, redacted, MAX_PROTOCOL_ERRORS)
        });
    }

    pub fn pending_increment(&self) {
        self.pending_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub fn pending_decrement(&self) {
        let _ = self
            .pending_requests
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(1))
            });
    }

    pub fn queue_increment(&self) {
        self.queue_depth.fetch_add(1, Ordering::Relaxed);
    }

    pub fn queue_decrement(&self) {
        let _ = self
            .queue_depth
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(1))
            });
    }

    fn with_data(&self, update: impl FnOnce(&mut DiagnosticsData)) {
        let mut data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        update(&mut data);
    }
}

fn generated_schema_version() -> String {
    serde_json::from_str::<serde_json::Value>(GENERATED_PROTOCOL_VERSION_JSON)
        .ok()
        .and_then(|value| {
            value
                .get("codexVersion")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn duration_millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn string_at(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

fn push_bounded(queue: &mut VecDeque<String>, line: String, limit: usize) {
    queue.push_back(line);
    while queue.len() > limit {
        queue.pop_front();
    }
}

pub fn redact_sensitive(input: &str) -> String {
    let mut trimmed = input
        .chars()
        .take(MAX_DIAGNOSTIC_LINE_CHARS)
        .collect::<String>();
    let lower = trimmed.to_ascii_lowercase();
    if [
        "authorization:",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "oauth",
        "password",
        "credential",
        "client_secret",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return "[redacted sensitive diagnostic]".to_string();
    }

    for prefix in ["sk-", "sess-", "eyJ"] {
        while let Some(index) = trimmed.find(prefix) {
            let suffix = &trimmed[index..];
            let token_len = suffix
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(character, '-' | '_' | '.' | ':' | '/')
                })
                .count();
            if token_len < 12 {
                break;
            }
            trimmed.replace_range(index..index + token_len, "<redacted>");
        }
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::redact_sensitive;

    #[test]
    fn redacts_secret_bearing_diagnostics() {
        assert_eq!(
            redact_sensitive("Authorization: Bearer extremely-secret"),
            "[redacted sensitive diagnostic]"
        );
        assert_eq!(
            redact_sensitive(&format!(
                "failed with {}{}",
                "sk-", "redaction-fixture-value"
            )),
            "failed with <redacted>"
        );
    }

    #[test]
    fn preserves_useful_non_secret_diagnostics() {
        assert_eq!(
            redact_sensitive("codex app-server exited with status 1"),
            "codex app-server exited with status 1"
        );
    }
}
