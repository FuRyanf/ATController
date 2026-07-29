use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

fn default_permission_mode() -> String {
    "fullAccess".to_string()
}

fn default_workspace_type() -> String {
    "local".to_string()
}

fn normalize_optional_setting(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppearanceMode {
    Light,
    #[default]
    System,
    Dark,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ResumeTerminalBehavior {
    #[default]
    InsertForReview,
    ExecuteImmediately,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub codex_cli_path: Option<String>,
    #[serde(default)]
    pub appearance_mode: AppearanceMode,
    #[serde(default = "default_true")]
    pub default_new_thread_full_access: bool,
    #[serde(default = "default_permission_mode")]
    pub default_permission_mode: String,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
    #[serde(default)]
    pub default_service_tier: Option<String>,
    #[serde(default)]
    pub resume_terminal_behavior: ResumeTerminalBehavior,
    #[serde(default = "default_true")]
    pub command_enter_to_send: bool,
    #[serde(default = "default_true")]
    pub task_completion_alerts: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            codex_cli_path: None,
            appearance_mode: AppearanceMode::System,
            default_new_thread_full_access: true,
            default_permission_mode: default_permission_mode(),
            default_model: None,
            default_reasoning_effort: None,
            default_service_tier: None,
            resume_terminal_behavior: ResumeTerminalBehavior::InsertForReview,
            command_enter_to_send: true,
            task_completion_alerts: true,
        }
    }
}

impl Settings {
    pub fn normalized(mut self) -> Self {
        self.codex_cli_path = normalize_optional_setting(self.codex_cli_path);
        if !["standard", "workspaceAccess", "fullAccess"]
            .contains(&self.default_permission_mode.as_str())
        {
            self.default_permission_mode = default_permission_mode();
        }
        self.default_new_thread_full_access = self.default_permission_mode == "fullAccess";
        self.default_model = normalize_optional_setting(self.default_model);
        self.default_reasoning_effort = normalize_optional_setting(self.default_reasoning_effort);
        self.default_service_tier = normalize_optional_setting(self.default_service_tier);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default = "default_workspace_type")]
    pub workspace_type: String,
    #[serde(default)]
    pub last_opened_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub is_pinned: bool,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "default_true")]
    pub is_expanded: bool,
    #[serde(default)]
    pub icon_preference: Option<String>,
    #[serde(default = "default_true")]
    pub is_available: bool,
    #[serde(default)]
    pub git_pull_on_master_for_new_threads: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdate {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub is_pinned: Option<bool>,
    #[serde(default)]
    pub is_expanded: Option<bool>,
    #[serde(default)]
    pub icon_preference: Option<String>,
    #[serde(default)]
    pub clear_icon_preference: bool,
    #[serde(default)]
    pub mark_opened: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadUiMetadata {
    pub thread_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub fallback_title: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub draft: String,
    #[serde(default)]
    pub prompt_history: Vec<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub requested_model: Option<String>,
    #[serde(default)]
    pub requested_reasoning_effort: Option<String>,
    #[serde(default)]
    pub requested_service_tier: Option<String>,
    #[serde(default)]
    pub last_viewed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl CodexThreadUiMetadata {
    pub fn new(thread_id: String, workspace_id: String) -> Self {
        let now = Utc::now();
        Self {
            thread_id,
            workspace_id,
            fallback_title: String::new(),
            pinned: false,
            unread: false,
            archived: false,
            draft: String::new(),
            prompt_history: Vec::new(),
            permission_mode: default_permission_mode(),
            requested_model: None,
            requested_reasoning_effort: None,
            requested_service_tier: None,
            last_viewed_at: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn normalized(mut self) -> Self {
        self.fallback_title = self.fallback_title.trim().chars().take(200).collect();
        self.draft = self.draft.chars().take(200_000).collect();
        self.prompt_history = self
            .prompt_history
            .into_iter()
            .map(|entry| entry.trim().chars().take(20_000).collect::<String>())
            .filter(|entry| !entry.is_empty())
            .rev()
            .take(50)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if !["standard", "workspaceAccess", "fullAccess"].contains(&self.permission_mode.as_str()) {
            self.permission_mode = default_permission_mode();
        }
        self.requested_model = normalize_optional_setting(self.requested_model);
        self.requested_reasoning_effort =
            normalize_optional_setting(self.requested_reasoning_effort);
        self.requested_service_tier = normalize_optional_setting(self.requested_service_tier);
        self
    }
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
    pub files: Vec<GitChangedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullForNewThreadResult {
    pub outcome: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::{AppearanceMode, Settings};

    #[test]
    fn settings_default_to_system_appearance_and_full_access() {
        let settings = Settings::default();
        assert_eq!(settings.appearance_mode, AppearanceMode::System);
        assert!(settings.default_new_thread_full_access);
        assert_eq!(settings.default_permission_mode, "fullAccess");
        assert!(settings.command_enter_to_send);
        assert!(settings.task_completion_alerts);
    }

    #[test]
    fn settings_normalize_runtime_choices() {
        let settings = serde_json::from_str::<Settings>(
            r#"{
                "defaultPermissionMode": "invalid",
                "defaultModel": " runtime-model ",
                "defaultReasoningEffort": " ultra "
            }"#,
        )
        .expect("settings")
        .normalized();
        assert_eq!(settings.default_permission_mode, "fullAccess");
        assert_eq!(settings.default_model.as_deref(), Some("runtime-model"));
        assert_eq!(settings.default_reasoning_effort.as_deref(), Some("ultra"));
    }
}
