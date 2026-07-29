use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const TERMINAL_SCROLLBACK_LINES_MIN: u32 = 10_000;
pub const TERMINAL_SCROLLBACK_LINES_DEFAULT: u32 = 100_000;
pub const TERMINAL_SCROLLBACK_LINES_MAX: u32 = 250_000;

fn default_terminal_scrollback_lines() -> u32 {
    TERMINAL_SCROLLBACK_LINES_DEFAULT
}

pub fn normalize_terminal_scrollback_lines(value: u32) -> u32 {
    value.clamp(TERMINAL_SCROLLBACK_LINES_MIN, TERMINAL_SCROLLBACK_LINES_MAX)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    #[default]
    Local,
    Rdev,
    Ssh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub kind: WorkspaceKind,
    #[serde(default)]
    pub rdev_ssh_command: Option<String>,
    #[serde(default)]
    pub ssh_command: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub git_pull_on_master_for_new_threads: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThreadRunStatus {
    #[default]
    Idle,
    Running,
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    pub id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub full_access: bool,
    #[serde(default)]
    pub enabled_skills: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub title: String,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default)]
    pub last_run_status: ThreadRunStatus,
    #[serde(default)]
    pub last_run_started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_run_ended_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub codex_session_id: Option<String>,
    #[serde(default)]
    pub forked_from_codex_session_id: Option<String>,
    #[serde(default)]
    pub pending_fork_source_codex_session_id: Option<String>,
    #[serde(default)]
    pub pending_fork_known_child_session_ids: Vec<String>,
    #[serde(default)]
    pub pending_fork_requested_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub pending_fork_launch_consumed: bool,
    #[serde(default)]
    pub last_resume_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub last_new_session_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppearanceMode {
    Light,
    #[default]
    System,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub codex_cli_path: Option<String>,
    #[serde(default)]
    pub appearance_mode: AppearanceMode,
    #[serde(default)]
    pub default_new_thread_full_access: bool,
    #[serde(default)]
    pub task_completion_alerts: bool,
    #[serde(default = "default_terminal_scrollback_lines")]
    pub terminal_scrollback_lines: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            codex_cli_path: None,
            appearance_mode: AppearanceMode::System,
            default_new_thread_full_access: false,
            task_completion_alerts: false,
            terminal_scrollback_lines: TERMINAL_SCROLLBACK_LINES_DEFAULT,
        }
    }
}

impl Settings {
    pub fn normalized(mut self) -> Self {
        self.codex_cli_path = self
            .codex_cli_path
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty());
        self.terminal_scrollback_lines =
            normalize_terminal_scrollback_lines(self.terminal_scrollback_lines);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportableCodexSession {
    pub session_id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub first_prompt: Option<String>,
    #[serde(default)]
    pub message_count: u64,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub modified_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub git_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportableCodexProject {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub path_exists: bool,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    pub sessions: Vec<ImportableCodexSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentCodexThread {
    pub session_id: String,
    pub workspace_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub recency_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexReasoningEffortOption {
    pub value: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelOption {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<CodexReasoningEffortOption>,
    pub supports_fast_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitWindow {
    pub used_percent: i64,
    pub window_duration_mins: i64,
    #[serde(default)]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeOverview {
    pub models: Vec<CodexModelOption>,
    pub selected_model: String,
    pub selected_reasoning_effort: String,
    pub fast_mode: bool,
    #[serde(default)]
    pub five_hour_limit: Option<CodexRateLimitWindow>,
    #[serde(default)]
    pub weekly_limit: Option<CodexRateLimitWindow>,
    #[serde(default)]
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimePreferences {
    pub model: String,
    pub reasoning_effort: String,
    pub fast_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub short_hash: String,
    pub is_dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub is_main_worktree: bool,
    pub worktree_label: Option<String>,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEntry {
    pub name: String,
    pub is_current: bool,
    pub last_commit_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceStatus {
    pub is_dirty: bool,
    pub uncommitted_files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullForNewThreadResult {
    pub outcome: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub entry_points: Vec<String>,
    pub path: String,
    pub relative_path: String,
    #[serde(default)]
    pub is_global: bool,
    #[serde(default)]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartResponse {
    pub session_id: String,
    pub session_mode: String,
    pub resume_session_id: Option<String>,
    pub turn_completion_mode: String,
    pub current_cwd: Option<String>,
    pub thread: ThreadMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedNativeFork {
    pub source_codex_session_id: String,
    #[serde(default)]
    pub known_child_session_ids: Vec<String>,
    pub requested_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceShellStartResponse {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub session_id: String,
    pub thread_id: Option<String>,
    pub data: String,
    pub start_position: u64,
    pub end_position: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputSnapshot {
    pub text: String,
    pub start_position: u64,
    pub end_position: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadyEvent {
    pub session_id: String,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSshAuthStatusEvent {
    pub session_id: String,
    pub workspace_id: String,
    pub thread_id: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTurnCompletedEvent {
    pub session_id: String,
    pub thread_id: Option<String>,
    pub status: String,
    pub has_meaningful_output: bool,
    pub completed_at_ms: i64,
    #[serde(default)]
    pub completion_index: Option<u64>,
    pub current_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnCompletionSummary {
    pub codex_session_id: String,
    pub completion_index: u64,
    pub completed_at_ms: i64,
    pub status: String,
    pub has_meaningful_output: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub persistence_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_terminal_scrollback_lines, AppearanceMode, Settings,
        TERMINAL_SCROLLBACK_LINES_DEFAULT, TERMINAL_SCROLLBACK_LINES_MAX,
        TERMINAL_SCROLLBACK_LINES_MIN,
    };

    #[test]
    fn settings_default_to_system_appearance_and_standard_access() {
        let settings = Settings::default();

        assert_eq!(settings.appearance_mode, AppearanceMode::System);
        assert!(!settings.default_new_thread_full_access);
        assert_eq!(
            settings.terminal_scrollback_lines,
            TERMINAL_SCROLLBACK_LINES_DEFAULT
        );
    }

    #[test]
    fn missing_settings_fields_deserialize_to_system_defaults() {
        let settings: Settings = serde_json::from_str("{}").expect("settings should deserialize");

        assert_eq!(settings.appearance_mode, AppearanceMode::System);
        assert!(!settings.default_new_thread_full_access);
        assert_eq!(
            settings.terminal_scrollback_lines,
            TERMINAL_SCROLLBACK_LINES_DEFAULT
        );
    }

    #[test]
    fn terminal_scrollback_lines_are_clamped_to_safe_bounds() {
        assert_eq!(
            normalize_terminal_scrollback_lines(1),
            TERMINAL_SCROLLBACK_LINES_MIN
        );
        assert_eq!(
            normalize_terminal_scrollback_lines(TERMINAL_SCROLLBACK_LINES_MAX + 1),
            TERMINAL_SCROLLBACK_LINES_MAX
        );
    }
}
