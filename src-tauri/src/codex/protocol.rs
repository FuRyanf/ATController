use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::process;

// Large app-server histories can contain many megabytes of repeated command
// output and diffs. Keep enough tail context for diagnosis and copying without
// transferring pathological payloads into WebKit's layout and accessibility
// trees, where they can multiply into hundreds of megabytes.
const MAX_HISTORY_TEXT_CHARS: usize = 256_000;
const MAX_HISTORY_COMMAND_OUTPUT_CHARS: usize = 128_000;
const MAX_HISTORY_DIFF_CHARS: usize = 256_000;
const MAX_HISTORY_JSON_CHARS: usize = 16_000;
const HISTORY_TRUNCATION_MARKER: &str = "\n[Earlier content truncated by ATController]\n";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Standard,
    WorkspaceAccess,
    #[default]
    FullAccess,
}

impl PermissionMode {
    pub fn sandbox_mode(self) -> &'static str {
        match self {
            Self::Standard => "read-only",
            Self::WorkspaceAccess => "workspace-write",
            Self::FullAccess => "danger-full-access",
        }
    }

    pub fn approval_policy(self) -> &'static str {
        match self {
            Self::Standard | Self::WorkspaceAccess => "on-request",
            Self::FullAccess => "never",
        }
    }

    pub fn profile_id(self) -> &'static str {
        match self {
            Self::Standard => ":read-only",
            Self::WorkspaceAccess => ":workspace",
            Self::FullAccess => ":danger-full-access",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPreferences {
    #[serde(default)]
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveThreadSettings {
    pub requested_model: Option<String>,
    pub effective_model: Option<String>,
    pub model_resolution: String,
    pub requested_reasoning_effort: Option<String>,
    pub effective_reasoning_effort: Option<String>,
    pub reasoning_effort_resolution: String,
    pub requested_service_tier: Option<String>,
    pub effective_service_tier: Option<String>,
    pub service_tier_resolution: String,
    pub permission_mode: PermissionMode,
    pub permission_profile: String,
    pub approval_policy: String,
    pub sandbox_policy: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadSession {
    pub thread: CodexThread,
    pub settings: EffectiveThreadSettings,
    pub instruction_sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadPage {
    pub data: Vec<CodexThread>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexDiscoveredProject {
    pub name: String,
    pub workspace_path: String,
    pub thread_count: usize,
    pub active_thread_count: usize,
    pub archived_thread_count: usize,
    pub most_recent_activity: Option<i64>,
    pub already_added: bool,
    pub available: bool,
    pub thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexThread {
    pub id: String,
    pub session_id: String,
    pub forked_from_id: Option<String>,
    pub parent_thread_id: Option<String>,
    pub title: String,
    pub preview: String,
    pub cwd: String,
    pub model_provider: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: Option<i64>,
    pub status: String,
    pub source: String,
    pub cli_version: String,
    pub archived: bool,
    pub turns: Vec<CodexTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurn {
    pub id: String,
    pub status: String,
    pub items: Vec<CodexItem>,
    pub items_view: String,
    pub error: Option<CodexError>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexError {
    pub message: String,
    pub details: Option<String>,
    pub kind: Option<String>,
    pub will_retry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexFileChange {
    pub path: String,
    pub kind: String,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexInputPart {
    pub kind: String,
    pub text: Option<String>,
    pub path: Option<String>,
    pub url: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActivity {
    pub id: String,
    pub activity_type: String,
    pub label: String,
    pub status: String,
    pub server: String,
    pub tool: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub browser_session_id: Option<String>,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    pub url: Option<String>,
    pub target: Option<String>,
    pub duration_ms: Option<i64>,
    pub screenshot_reference: Option<String>,
    pub console_error_count: u32,
    pub failed_request_count: u32,
    pub summary_lines: Vec<String>,
    pub details: Option<Value>,
    pub error: Option<String>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexItem {
    pub id: String,
    pub client_id: Option<String>,
    pub kind: String,
    pub status: Option<String>,
    pub phase: Option<String>,
    pub text: Option<String>,
    pub summary: Vec<String>,
    pub reasoning: Vec<String>,
    pub content: Vec<CodexInputPart>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub output: Option<String>,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub changes: Vec<CodexFileChange>,
    pub tool_name: Option<String>,
    pub tool_server: Option<String>,
    pub tool_arguments: Option<Value>,
    pub tool_result: Option<Value>,
    pub browser_activity: Option<BrowserActivity>,
    pub error: Option<String>,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexTokenUsage {
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub last_total_tokens: i64,
    pub model_context_window: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRequest {
    pub request_id: Value,
    pub approval_type: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub reason: Option<String>,
    pub network_host: Option<String>,
    pub network_protocol: Option<String>,
    pub grant_root: Option<String>,
    pub requested_permissions: Option<Value>,
    pub available_decisions: Vec<String>,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerRequestResponse {
    Command {
        request_id: Value,
        decision: String,
    },
    FileChange {
        request_id: Value,
        decision: String,
    },
    Permissions {
        request_id: Value,
        grant: bool,
        #[serde(default)]
        scope: Option<String>,
    },
    UserInput {
        request_id: Value,
        answers: BTreeMap<String, Vec<String>>,
    },
    McpElicitation {
        request_id: Value,
        action: String,
        #[serde(default)]
        content: Option<Value>,
    },
}

impl ServerRequestResponse {
    pub fn request_id(&self) -> &Value {
        match self {
            Self::Command { request_id, .. }
            | Self::FileChange { request_id, .. }
            | Self::Permissions { request_id, .. }
            | Self::UserInput { request_id, .. }
            | Self::McpElicitation { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexEvent {
    pub sequence: u64,
    pub kind: String,
    pub method: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub status: Option<String>,
    pub delta: Option<String>,
    pub thread: Option<CodexThread>,
    pub turn: Option<CodexTurn>,
    pub item: Option<CodexItem>,
    pub approval: Option<CodexApprovalRequest>,
    pub token_usage: Option<CodexTokenUsage>,
    pub error: Option<CodexError>,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexReasoningOption {
    pub value: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub reasoning_efforts: Vec<CodexReasoningOption>,
    pub service_tiers: Vec<CodexServiceTier>,
    pub default_service_tier: Option<String>,
    pub input_modalities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimitWindow {
    pub used_percent: f64,
    pub window_duration_mins: Option<i64>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    pub signed_in: bool,
    pub authentication_mode: Option<String>,
    pub plan_type: Option<String>,
    pub requires_openai_auth: bool,
    pub five_hour_limit: Option<CodexRateLimitWindow>,
    pub weekly_limit: Option<CodexRateLimitWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexRuntimeCatalog {
    pub models: Vec<CodexModel>,
    pub account: CodexAccount,
    pub permission_profiles: Vec<CodexPermissionProfile>,
    pub configured_model: Option<String>,
    pub configured_reasoning_effort: Option<String>,
    pub configured_service_tier: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexPermissionProfile {
    pub id: String,
    pub description: Option<String>,
    pub allowed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkill {
    pub name: String,
    pub description: String,
    pub short_description: Option<String>,
    pub path: String,
    pub scope: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexPlugin {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub marketplace: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginSession {
    pub login_id: String,
    pub authorization_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ComposerInput {
    Text {
        text: String,
    },
    Image {
        url: String,
        #[serde(default)]
        detail: Option<String>,
    },
    LocalImage {
        path: String,
        #[serde(default)]
        detail: Option<String>,
        #[serde(default)]
        allow_outside_workspace: bool,
    },
    File {
        path: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        allow_outside_workspace: bool,
    },
    Skill {
        name: String,
        path: String,
    },
    Plugin {
        id: String,
        name: String,
    },
}

pub fn build_wire_inputs(workspace_path: &str, inputs: Vec<ComposerInput>) -> Result<Vec<Value>> {
    if inputs.is_empty() {
        return Err(anyhow!("A turn requires at least one input"));
    }
    let mut result = Vec::with_capacity(inputs.len());
    for input in inputs {
        match input {
            ComposerInput::Text { text } => {
                if text.trim().is_empty() {
                    continue;
                }
                result.push(json!({
                    "type": "text",
                    "text": text,
                    "text_elements": []
                }));
            }
            ComposerInput::Image { url, detail } => {
                const MAX_INLINE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
                let supported_prefix = [
                    "data:image/png;base64,",
                    "data:image/jpeg;base64,",
                    "data:image/gif;base64,",
                    "data:image/webp;base64,",
                ]
                .into_iter()
                .find(|prefix| url.starts_with(prefix));
                let Some(prefix) = supported_prefix else {
                    return Err(anyhow!(
                        "Inline images must be PNG, JPEG, GIF, or WebP data URLs"
                    ));
                };
                let encoded = &url[prefix.len()..];
                let estimated_bytes = encoded.len().saturating_mul(3) / 4;
                if encoded.is_empty() || estimated_bytes > MAX_INLINE_IMAGE_BYTES {
                    return Err(anyhow!("Inline images are limited to 10 MB"));
                }
                if !encoded
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
                {
                    return Err(anyhow!("Inline image data is not valid base64"));
                }
                let mut value = json!({ "type": "image", "url": url });
                if let Some(detail) = detail {
                    if !["auto", "low", "high", "original"].contains(&detail.as_str()) {
                        return Err(anyhow!("Unsupported image detail value"));
                    }
                    value["detail"] = Value::String(detail);
                }
                result.push(value);
            }
            ComposerInput::LocalImage {
                path,
                detail,
                allow_outside_workspace,
            } => {
                let path = process::validate_attachment_path(
                    workspace_path,
                    &path,
                    allow_outside_workspace,
                )?;
                let mut value = json!({ "type": "localImage", "path": path });
                if let Some(detail) = detail {
                    if !["auto", "low", "high", "original"].contains(&detail.as_str()) {
                        return Err(anyhow!("Unsupported image detail value"));
                    }
                    value["detail"] = Value::String(detail);
                }
                result.push(value);
            }
            ComposerInput::File {
                path,
                name,
                allow_outside_workspace,
            } => {
                let path = process::validate_attachment_path(
                    workspace_path,
                    &path,
                    allow_outside_workspace,
                )?;
                let fallback = Path::new(&path)
                    .file_name()
                    .and_then(|entry| entry.to_str())
                    .unwrap_or("file")
                    .to_string();
                result.push(json!({
                    "type": "mention",
                    "name": name.filter(|value| !value.trim().is_empty()).unwrap_or(fallback),
                    "path": path
                }));
            }
            ComposerInput::Skill { name, path } => {
                if name.trim().is_empty() || path.trim().is_empty() {
                    return Err(anyhow!("Skill input requires a name and path"));
                }
                result.push(json!({ "type": "skill", "name": name, "path": path }));
            }
            ComposerInput::Plugin { id, name } => {
                let valid_id = !id.is_empty()
                    && id.len() <= 512
                    && id.chars().all(|character| {
                        character.is_ascii_alphanumeric()
                            || matches!(character, '-' | '_' | '.' | '@')
                    });
                let valid_name = !name.trim().is_empty()
                    && name.len() <= 256
                    && !name.chars().any(char::is_control);
                if !valid_id || !valid_name {
                    return Err(anyhow!("Plugin input requires a valid installed plugin"));
                }
                result.push(json!({
                    "type": "mention",
                    "name": name,
                    "path": format!("plugin://{id}")
                }));
            }
        }
    }
    if result.is_empty() {
        return Err(anyhow!("A turn requires non-empty input"));
    }
    Ok(result)
}

pub fn normalize_thread(value: &Value, archived: bool) -> Result<CodexThread> {
    let id = required_string(value, "id")?;
    let preview = optional_string(value, "preview").unwrap_or_default();
    let title = optional_string(value, "name")
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            preview
                .lines()
                .next()
                .unwrap_or("New thread")
                .trim()
                .chars()
                .take(120)
                .collect()
        });
    let mut turns = value
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|turn| normalize_turn(turn).ok())
        .collect::<Vec<_>>();
    for turn in &mut turns {
        for item in &mut turn.items {
            if let Some(activity) = item.browser_activity.as_mut() {
                activity.thread_id = Some(id.clone());
                activity.turn_id = Some(turn.id.clone());
            }
        }
    }
    Ok(CodexThread {
        id: id.clone(),
        session_id: optional_string(value, "sessionId").unwrap_or_else(|| id.clone()),
        forked_from_id: optional_string(value, "forkedFromId"),
        parent_thread_id: optional_string(value, "parentThreadId"),
        title: if title.is_empty() {
            "New thread".to_string()
        } else {
            title
        },
        preview,
        cwd: optional_string(value, "cwd").unwrap_or_default(),
        model_provider: optional_string(value, "modelProvider").unwrap_or_default(),
        created_at: value
            .get("createdAt")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        updated_at: value
            .get("updatedAt")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        recency_at: value.get("recencyAt").and_then(Value::as_i64),
        status: value
            .pointer("/status/type")
            .and_then(Value::as_str)
            .unwrap_or("notLoaded")
            .to_string(),
        source: value
            .get("source")
            .map(value_label)
            .unwrap_or_else(|| "unknown".to_string()),
        cli_version: optional_string(value, "cliVersion").unwrap_or_default(),
        archived,
        turns,
    })
}

pub fn normalize_turn(value: &Value) -> Result<CodexTurn> {
    Ok(CodexTurn {
        id: required_string(value, "id")?,
        status: optional_string(value, "status").unwrap_or_else(|| "inProgress".to_string()),
        items: value
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| normalize_item(item).ok())
            .collect(),
        items_view: value
            .get("itemsView")
            .map(value_label)
            .unwrap_or_else(|| "full".to_string()),
        error: value
            .get("error")
            .filter(|error| !error.is_null())
            .map(normalize_error),
        started_at: value.get("startedAt").and_then(Value::as_i64),
        completed_at: value.get("completedAt").and_then(Value::as_i64),
        duration_ms: value.get("durationMs").and_then(Value::as_i64),
    })
}

pub fn normalize_item(value: &Value) -> Result<CodexItem> {
    let kind = required_string(value, "type")?;
    let id = optional_string(value, "id").unwrap_or_else(|| format!("unknown-{kind}"));
    let mut item = CodexItem {
        id,
        client_id: optional_string(value, "clientId"),
        kind: kind.clone(),
        status: value.get("status").map(value_label),
        phase: value
            .get("phase")
            .filter(|value| !value.is_null())
            .map(value_label),
        duration_ms: value.get("durationMs").and_then(Value::as_i64),
        ..CodexItem::default()
    };
    match kind.as_str() {
        "userMessage" => {
            item.content = value
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(normalize_input_part)
                .collect();
        }
        "agentMessage" | "plan" => {
            item.text = optional_string(value, "text")
                .map(|text| tail_bounded(text, MAX_HISTORY_TEXT_CHARS))
        }
        "reasoning" => {
            item.summary = string_array(value.get("summary"))
                .into_iter()
                .map(|text| tail_bounded(text, MAX_HISTORY_TEXT_CHARS))
                .collect();
            item.reasoning = string_array(value.get("content"))
                .into_iter()
                .map(|text| tail_bounded(text, MAX_HISTORY_TEXT_CHARS))
                .collect();
        }
        "commandExecution" => {
            item.command = optional_string(value, "command");
            item.cwd = optional_string(value, "cwd");
            item.output = optional_string(value, "aggregatedOutput")
                .map(|output| tail_bounded(output, MAX_HISTORY_COMMAND_OUTPUT_CHARS));
            item.exit_code = value.get("exitCode").and_then(Value::as_i64);
        }
        "fileChange" => {
            item.changes = normalize_changes(value.get("changes"));
        }
        "mcpToolCall" => {
            item.tool_server = optional_string(value, "server");
            item.tool_name = optional_string(value, "tool");
            let is_browser =
                is_playwright_tool(item.tool_server.as_deref(), item.tool_name.as_deref());
            item.tool_arguments = value.get("arguments").map(|arguments| {
                if is_browser {
                    bounded_json(&redact_browser_value(arguments, None))
                } else {
                    bounded_json(arguments)
                }
            });
            item.tool_result =
                value
                    .get("result")
                    .filter(|result| !result.is_null())
                    .map(|result| {
                        if is_browser {
                            bounded_json(&redact_browser_value(result, None))
                        } else {
                            bounded_json(result)
                        }
                    });
            item.error = value
                .get("error")
                .filter(|error| !error.is_null())
                .map(value_label);
            if is_browser {
                item.browser_activity = normalize_browser_activity(value, &item);
            }
        }
        "dynamicToolCall" | "collabAgentToolCall" => {
            item.tool_name = optional_string(value, "tool");
            item.tool_arguments = value.get("arguments").map(bounded_json);
            item.tool_result = value.get("contentItems").map(bounded_json);
        }
        "webSearch" => {
            item.tool_name = Some("Web search".to_string());
            item.details = Some(bounded_json(value));
        }
        "imageView" | "imageGeneration" => {
            item.details = Some(bounded_json(value));
        }
        _ => {
            item.details = Some(bounded_json(value));
        }
    }
    Ok(item)
}

fn normalize_input_part(value: &Value) -> CodexInputPart {
    CodexInputPart {
        kind: optional_string(value, "type").unwrap_or_else(|| "unknown".to_string()),
        text: optional_string(value, "text").map(|text| tail_bounded(text, MAX_HISTORY_TEXT_CHARS)),
        path: optional_string(value, "path"),
        url: optional_string(value, "url").map(|url| {
            if url.starts_with("data:") && url.len() > 4_096 {
                format!(
                    "data:application/x-atcontroller-history-placeholder,{}-bytes-omitted",
                    url.len()
                )
            } else {
                tail_bounded(url, MAX_HISTORY_TEXT_CHARS)
            }
        }),
        name: optional_string(value, "name"),
    }
}

fn normalize_changes(value: Option<&Value>) -> Vec<CodexFileChange> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|change| {
            Some(CodexFileChange {
                path: optional_string(change, "path")?,
                kind: change.get("kind").map(value_label).unwrap_or_default(),
                diff: optional_string(change, "diff")
                    .map(|diff| tail_bounded(diff, MAX_HISTORY_DIFF_CHARS))
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn tail_bounded(value: String, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value;
    }
    let keep = max_chars.saturating_sub(HISTORY_TRUNCATION_MARKER.chars().count());
    let tail = value
        .chars()
        .skip(char_count.saturating_sub(keep))
        .collect::<String>();
    format!("{HISTORY_TRUNCATION_MARKER}{tail}")
}

fn bounded_json(value: &Value) -> Value {
    let Ok(encoded) = serde_json::to_string(value) else {
        return json!({ "truncated": true, "reason": "Unable to serialize structured detail" });
    };
    if encoded.chars().count() <= MAX_HISTORY_JSON_CHARS {
        return value.clone();
    }
    json!({
        "truncated": true,
        "originalBytes": encoded.len(),
        "preview": tail_bounded(encoded, MAX_HISTORY_JSON_CHARS)
    })
}

fn is_playwright_tool(server: Option<&str>, tool: Option<&str>) -> bool {
    let Some(tool) = tool else {
        return false;
    };
    if !tool.starts_with("browser_") {
        return false;
    }
    server.is_some_and(|server| {
        let normalized = server.to_ascii_lowercase();
        normalized == "atcontroller-playwright"
            || normalized == "playwright"
            || normalized.contains("playwright")
    })
}

fn normalize_browser_activity(value: &Value, item: &CodexItem) -> Option<BrowserActivity> {
    let server = item.tool_server.clone()?;
    let tool = item.tool_name.clone()?;
    let arguments = value.get("arguments").unwrap_or(&Value::Null);
    let result = value.get("result").unwrap_or(&Value::Null);
    let result_text = browser_result_text(result);
    let status = item
        .status
        .clone()
        .unwrap_or_else(|| "inProgress".to_string());
    let error = item.error.clone();
    let activity_type = browser_activity_type(&tool, arguments, error.is_some());
    let target = browser_target(arguments);
    let page_title = browser_labeled_line(&result_text, "Page Title:");
    let url = optional_string(arguments, "url")
        .or_else(|| browser_labeled_line(&result_text, "Page URL:"))
        .map(|url| redact_browser_url(&url));
    let screenshot_reference = extract_screenshot_reference(arguments, &result_text);
    let console_error_count = if tool == "browser_console_messages" {
        count_browser_console_errors(&result_text)
    } else {
        0
    };
    let failed_request_count =
        if tool == "browser_network_requests" || tool == "browser_network_request" {
            count_browser_failed_requests(&result_text)
        } else {
            0
        };
    let summary_lines = browser_summary_lines(
        &tool,
        &result_text,
        console_error_count,
        failed_request_count,
    );
    Some(BrowserActivity {
        id: item.id.clone(),
        label: browser_activity_label(&tool, arguments, target.as_deref(), &status, error.as_ref()),
        activity_type,
        status,
        server,
        tool,
        thread_id: None,
        turn_id: None,
        browser_session_id: None,
        page_id: browser_labeled_line(&result_text, "Page ID:"),
        page_title,
        url,
        target,
        duration_ms: item.duration_ms,
        screenshot_reference,
        console_error_count,
        failed_request_count,
        summary_lines,
        details: item
            .tool_result
            .clone()
            .or_else(|| item.tool_arguments.clone()),
        error,
        timestamp: Utc::now(),
    })
}

fn browser_activity_type(tool: &str, arguments: &Value, failed: bool) -> String {
    if failed {
        return "toolError".to_string();
    }
    match tool {
        "browser_navigate" | "browser_navigate_back" => "navigation",
        "browser_click" => "click",
        "browser_type" | "browser_fill_form" | "browser_press_key" => "type",
        "browser_select_option" => "select",
        "browser_hover" => "hover",
        "browser_drag" | "browser_drop" => "drag",
        "browser_file_upload" => "fileUpload",
        "browser_take_screenshot" => "screenshot",
        "browser_snapshot" => "pageInspected",
        "browser_console_messages" => "consoleInspected",
        "browser_network_requests" | "browser_network_request" => "networkInspected",
        "browser_close" => "browserStopped",
        "browser_tabs" => match optional_string(arguments, "action").as_deref() {
            Some("new") => "tabOpened",
            Some("close") => "tabClosed",
            _ => "tabsInspected",
        },
        "browser_resize" | "browser_wait_for" | "browser_evaluate" => "browserInteraction",
        _ => "browserTool",
    }
    .to_string()
}

fn browser_activity_label(
    tool: &str,
    arguments: &Value,
    target: Option<&str>,
    status: &str,
    error: Option<&String>,
) -> String {
    if error.is_some() || status == "failed" {
        return match tool {
            "browser_navigate" => "Navigation failed".to_string(),
            "browser_take_screenshot" => "Screenshot failed".to_string(),
            _ => "Browser action failed".to_string(),
        };
    }
    let target = target
        .map(|target| format!(" “{}”", target.chars().take(100).collect::<String>()))
        .unwrap_or_default();
    match tool {
        "browser_navigate" => optional_string(arguments, "url")
            .map(|url| format!("Opened {}", redact_browser_url(&url)))
            .unwrap_or_else(|| "Opened page".to_string()),
        "browser_navigate_back" => "Went back".to_string(),
        "browser_click" => format!("Clicked{target}"),
        "browser_type" => format!("Typed into{target}"),
        "browser_fill_form" => "Filled form".to_string(),
        "browser_press_key" => optional_string(arguments, "key")
            .map(|key| format!("Pressed {key}"))
            .unwrap_or_else(|| "Pressed key".to_string()),
        "browser_select_option" => format!("Selected option in{target}"),
        "browser_hover" => format!("Hovered over{target}"),
        "browser_drag" => "Dragged element".to_string(),
        "browser_drop" => "Dropped content".to_string(),
        "browser_file_upload" => "Uploaded file".to_string(),
        "browser_take_screenshot" => "Captured screenshot".to_string(),
        "browser_snapshot" => "Inspected page".to_string(),
        "browser_console_messages" => "Inspected console".to_string(),
        "browser_network_requests" | "browser_network_request" => "Inspected network".to_string(),
        "browser_close" => "Closed browser".to_string(),
        "browser_tabs" => match optional_string(arguments, "action").as_deref() {
            Some("new") => "Opened tab".to_string(),
            Some("close") => "Closed tab".to_string(),
            Some("select") => "Selected tab".to_string(),
            _ => "Inspected tabs".to_string(),
        },
        "browser_resize" => "Resized browser".to_string(),
        "browser_wait_for" => "Waited for page".to_string(),
        "browser_evaluate" => "Inspected page behavior".to_string(),
        _ => "Used browser".to_string(),
    }
}

fn browser_target(arguments: &Value) -> Option<String> {
    optional_string(arguments, "element")
        .or_else(|| optional_string(arguments, "target"))
        .map(|value| value.chars().take(160).collect())
}

fn browser_result_text(value: &Value) -> String {
    fn collect(value: &Value, output: &mut Vec<String>, depth: usize) {
        if depth > 10 || output.len() >= 128 {
            return;
        }
        match value {
            Value::String(value) => output.push(value.clone()),
            Value::Array(values) => {
                for value in values {
                    collect(value, output, depth + 1);
                }
            }
            Value::Object(map) => {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    output.push(text.to_string());
                }
                for (key, value) in map {
                    if key != "text" && key != "data" {
                        collect(value, output, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }
    let mut output = Vec::new();
    collect(value, &mut output, 0);
    output.join("\n")
}

fn browser_labeled_line(text: &str, label: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(label).map(str::trim))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_screenshot_reference(arguments: &Value, result_text: &str) -> Option<String> {
    let _ = arguments;
    result_text.lines().find_map(|line| {
        let candidate = line.replace('\\', "/");
        let relative = candidate.split("browser-cache/playwright/").nth(1)?;
        let relative = relative
            .trim()
            .trim_matches('`')
            .trim_matches('<')
            .trim_matches('>')
            .trim_end_matches(')');
        safe_screenshot_reference(relative).then(|| relative.to_string())
    })
}

fn safe_screenshot_reference(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && value.len() <= 1_024
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        && matches!(
            path.extension()
                .and_then(std::ffi::OsStr::to_str)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("png" | "jpg" | "jpeg" | "webp")
        )
}

fn count_browser_console_errors(text: &str) -> u32 {
    u32::try_from(
        text.lines()
            .filter(|line| {
                let line = line.to_ascii_lowercase();
                line.contains("[error]") || line.contains("uncaught") || line.contains("unhandled")
            })
            .count(),
    )
    .unwrap_or(u32::MAX)
}

fn count_browser_failed_requests(text: &str) -> u32 {
    u32::try_from(
        text.lines()
            .filter(|line| {
                let line = line.to_ascii_lowercase();
                line.contains("=> [4")
                    || line.contains("=> [5")
                    || line.contains("net::err_")
                    || line.contains("failed")
            })
            .count(),
    )
    .unwrap_or(u32::MAX)
}

fn browser_summary_lines(
    tool: &str,
    result_text: &str,
    console_errors: u32,
    failed_requests: u32,
) -> Vec<String> {
    match tool {
        "browser_console_messages" => {
            let mut lines = vec![if console_errors == 0 {
                "No console errors detected".to_string()
            } else {
                format!(
                    "{console_errors} console error{} detected",
                    if console_errors == 1 { "" } else { "s" }
                )
            }];
            lines.extend(
                result_text
                    .lines()
                    .filter(|line| {
                        let lower = line.to_ascii_lowercase();
                        lower.contains("[error]")
                            || lower.contains("uncaught")
                            || lower.contains("unhandled")
                    })
                    .map(redact_browser_diagnostic_line)
                    .filter(|line| !line.is_empty())
                    .take(5),
            );
            lines
        }
        "browser_network_requests" | "browser_network_request" => {
            let mut lines = vec![if failed_requests == 0 {
                "No failed requests detected".to_string()
            } else {
                format!(
                    "{failed_requests} failed request{} detected",
                    if failed_requests == 1 { "" } else { "s" }
                )
            }];
            lines.extend(
                result_text
                    .lines()
                    .filter(|line| {
                        let lower = line.to_ascii_lowercase();
                        lower.contains("=> [4")
                            || lower.contains("=> [5")
                            || lower.contains("net::err_")
                            || lower.contains("failed")
                    })
                    .map(redact_browser_diagnostic_line)
                    .filter(|line| !line.is_empty())
                    .take(5),
            );
            lines
        }
        "browser_snapshot" => browser_labeled_line(result_text, "Page Title:")
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

fn redact_browser_diagnostic_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if [
        "authorization:",
        "proxy-authorization:",
        "cookie:",
        "set-cookie:",
        "api-key:",
        "x-api-key:",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return "[Sensitive browser detail redacted]".to_string();
    }
    line.split_whitespace()
        .map(|part| {
            let (prefix, value) = if let Some(value) = part.strip_prefix('(') {
                ("(", value)
            } else {
                ("", part)
            };
            let trailing = value
                .chars()
                .rev()
                .take_while(|character| ".,;:)]}".contains(*character))
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            let core = value.trim_end_matches(|character| ".,;:)]}".contains(character));
            if core.starts_with("http://") || core.starts_with("https://") {
                format!("{prefix}{}{trailing}", redact_browser_url(core))
            } else if lower.contains("token=") || lower.contains("key=") {
                "[Sensitive value redacted]".to_string()
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(600)
        .collect()
}

pub(crate) fn redact_browser_value(value: &Value, key: Option<&str>) -> Value {
    if key.is_some_and(is_sensitive_browser_key) {
        return Value::String("[redacted]".to_string());
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), redact_browser_value(value, Some(key.as_str()))))
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| redact_browser_value(value, key))
                .collect(),
        ),
        Value::String(value) if value.starts_with("http://") || value.starts_with("https://") => {
            Value::String(redact_browser_url(value))
        }
        Value::String(value) if value.len() > 8_000 => {
            Value::String(format!("[{} characters omitted]", value.chars().count()))
        }
        _ => value.clone(),
    }
}

fn is_sensitive_browser_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "text"
            | "value"
            | "values"
            | "password"
            | "secret"
            | "token"
            | "authorization"
            | "cookie"
            | "cookies"
            | "headers"
            | "formdata"
            | "formcontent"
    )
}

pub fn redact_browser_url(value: &str) -> String {
    let without_fragment = value.split('#').next().unwrap_or(value);
    let Some((base, query)) = without_fragment.split_once('?') else {
        return without_fragment.chars().take(4_096).collect();
    };
    let query = query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (key, raw_value) = part.split_once('=').unwrap_or((part, ""));
            if is_sensitive_query_key(key) {
                format!("{key}=[redacted]")
            } else {
                let value = raw_value.chars().take(160).collect::<String>();
                if raw_value.is_empty() {
                    key.to_string()
                } else {
                    format!("{key}={value}")
                }
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    if query.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{query}")
    }
}

fn is_sensitive_query_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "access_token",
        "auth",
        "authorization",
        "code",
        "credential",
        "jwt",
        "key",
        "oauth",
        "password",
        "secret",
        "session",
        "signature",
        "sig",
        "token",
    ]
    .iter()
    .any(|sensitive| normalized == *sensitive || normalized.contains(sensitive))
}

pub fn normalize_notification(sequence: u64, method: &str, params: &Value) -> CodexEvent {
    let mut event = CodexEvent {
        sequence,
        kind: event_kind(method).to_string(),
        method: method.to_string(),
        thread_id: optional_string(params, "threadId"),
        turn_id: optional_string(params, "turnId"),
        item_id: optional_string(params, "itemId"),
        ..CodexEvent::default()
    };
    match method {
        "thread/started" => {
            event.thread = params
                .get("thread")
                .and_then(|thread| normalize_thread(thread, false).ok());
            event.thread_id = event.thread.as_ref().map(|thread| thread.id.clone());
        }
        "thread/archived" | "thread/unarchived" | "thread/deleted" | "thread/closed" => {}
        "thread/status/changed" => event.status = params.get("status").map(value_label),
        "thread/name/updated" => event.data = Some(params.clone()),
        "thread/settings/updated" => event.data = params.get("threadSettings").cloned(),
        "thread/tokenUsage/updated" => {
            event.token_usage = params.get("tokenUsage").map(normalize_token_usage)
        }
        "turn/started" | "turn/completed" => {
            event.turn = params
                .get("turn")
                .and_then(|turn| normalize_turn(turn).ok());
            event.turn_id = event.turn.as_ref().map(|turn| turn.id.clone());
            event.status = event.turn.as_ref().map(|turn| turn.status.clone());
        }
        "item/started" | "item/completed" => {
            event.item = params
                .get("item")
                .and_then(|item| normalize_item(item).ok());
            event.item_id = event.item.as_ref().map(|item| item.id.clone());
            if let Some(activity) = event
                .item
                .as_mut()
                .and_then(|item| item.browser_activity.as_mut())
            {
                activity.thread_id = event.thread_id.clone();
                activity.turn_id = event.turn_id.clone();
            }
        }
        "item/agentMessage/delta"
        | "item/plan/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta"
        | "item/commandExecution/outputDelta"
        | "item/fileChange/outputDelta" => {
            event.delta = optional_string(params, "delta");
        }
        "item/mcpToolCall/progress" => {
            event.delta = optional_string(params, "message");
        }
        "item/reasoning/summaryPartAdded" => {
            event.delta = Some(String::new());
        }
        "item/fileChange/patchUpdated" => {
            event.item = Some(CodexItem {
                id: event.item_id.clone().unwrap_or_default(),
                kind: "fileChange".to_string(),
                changes: normalize_changes(params.get("changes")),
                ..CodexItem::default()
            });
        }
        "turn/plan/updated" => {
            let item_id = event
                .turn_id
                .as_ref()
                .map(|turn_id| format!("plan-{turn_id}"))
                .unwrap_or_else(|| "plan-current".to_string());
            let status = params
                .get("plan")
                .and_then(Value::as_array)
                .map(|steps| {
                    if steps.is_empty() {
                        "pending"
                    } else if steps.iter().any(|step| {
                        step.get("status").and_then(Value::as_str) == Some("inProgress")
                    }) {
                        "inProgress"
                    } else if steps
                        .iter()
                        .all(|step| step.get("status").and_then(Value::as_str) == Some("completed"))
                    {
                        "completed"
                    } else {
                        "pending"
                    }
                })
                .unwrap_or("pending")
                .to_string();
            event.item_id = Some(item_id.clone());
            event.item = Some(CodexItem {
                id: item_id,
                kind: "plan".to_string(),
                status: Some(status),
                text: optional_string(params, "explanation"),
                details: Some(params.clone()),
                ..CodexItem::default()
            });
        }
        // Git remains the source of truth for the inspector. The app server's
        // full turn diff can be very large, and sending a duplicate across the
        // WebKit bridge on every patch update creates avoidable serialization
        // and garbage-collection pressure.
        "turn/diff/updated" => {}
        "serverRequest/resolved" => {
            event.data = params
                .get("requestId")
                .cloned()
                .map(|request_id| json!({ "requestId": request_id }));
        }
        "account/updated" | "account/rateLimits/updated" | "account/login/completed" => {}
        "error" => {
            event.error = params.get("error").map(normalize_error);
            if let Some(error) = event.error.as_mut() {
                error.will_retry = params
                    .get("willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
        }
        _ => event.data = Some(params.clone()),
    }
    event
}

pub fn normalize_server_request(
    sequence: u64,
    request_id: Value,
    method: &str,
    params: &Value,
) -> CodexEvent {
    let thread_id =
        optional_string(params, "threadId").or_else(|| optional_string(params, "conversationId"));
    let turn_id = optional_string(params, "turnId");
    let item_id = optional_string(params, "itemId").or_else(|| optional_string(params, "callId"));
    let command = optional_string(params, "command").or_else(|| {
        params
            .get("command")
            .and_then(Value::as_array)
            .map(|arguments| {
                arguments
                    .iter()
                    .filter_map(Value::as_str)
                    .map(display_command_argument)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|command| !command.is_empty())
    });
    let (approval_type, decisions) = match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => (
            "commandExecution",
            vec!["accept", "acceptForSession", "decline", "cancel"],
        ),
        "item/fileChange/requestApproval" | "applyPatchApproval" => (
            "fileChange",
            vec!["accept", "acceptForSession", "decline", "cancel"],
        ),
        "item/permissions/requestApproval" => {
            ("permissions", vec!["accept", "acceptForSession", "decline"])
        }
        "item/tool/requestUserInput" => ("userInput", vec!["answer", "cancel"]),
        "mcpServer/elicitation/request" => ("mcpElicitation", vec!["accept", "decline", "cancel"]),
        _ => ("unsupported", vec!["cancel"]),
    };
    CodexEvent {
        sequence,
        kind: "approvalRequested".to_string(),
        method: method.to_string(),
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
        item_id: item_id.clone(),
        approval: Some(CodexApprovalRequest {
            request_id,
            approval_type: approval_type.to_string(),
            thread_id,
            turn_id,
            item_id,
            command,
            cwd: optional_string(params, "cwd"),
            reason: optional_string(params, "reason"),
            network_host: params
                .pointer("/networkApprovalContext/host")
                .and_then(Value::as_str)
                .map(str::to_string),
            network_protocol: params
                .pointer("/networkApprovalContext/protocol")
                .map(value_label),
            grant_root: optional_string(params, "grantRoot"),
            requested_permissions: params.get("permissions").cloned(),
            available_decisions: decisions.into_iter().map(str::to_string).collect(),
            payload: matches!(
                method,
                "item/tool/requestUserInput" | "mcpServer/elicitation/request"
            )
            .then(|| params.clone()),
        }),
        ..CodexEvent::default()
    }
}

fn display_command_argument(argument: &str) -> String {
    if !argument.is_empty()
        && argument
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@%_+=:,./-".contains(&byte))
    {
        argument.to_string()
    } else {
        format!("'{}'", argument.replace('\'', "'\"'\"'"))
    }
}

fn event_kind(method: &str) -> &'static str {
    match method {
        "thread/started" => "threadStarted",
        "thread/archived" => "threadArchived",
        "thread/unarchived" => "threadUnarchived",
        "thread/deleted" => "threadDeleted",
        "thread/closed" => "threadClosed",
        "thread/status/changed" => "threadStatusChanged",
        "thread/name/updated" => "threadNameUpdated",
        "thread/settings/updated" => "threadSettingsUpdated",
        "thread/tokenUsage/updated" => "tokenUsageUpdated",
        "skills/changed" => "skillsChanged",
        "turn/started" => "turnStarted",
        "turn/completed" => "turnCompleted",
        "item/started" => "itemStarted",
        "item/completed" => "itemCompleted",
        "item/agentMessage/delta" => "agentMessageDelta",
        "item/plan/delta" => "planDelta",
        "item/reasoning/summaryTextDelta" => "reasoningSummaryDelta",
        "item/reasoning/summaryPartAdded" => "reasoningSummaryPartAdded",
        "item/reasoning/textDelta" => "reasoningDelta",
        "item/commandExecution/outputDelta" => "commandOutputDelta",
        "item/fileChange/outputDelta" => "fileChangeOutputDelta",
        "item/fileChange/patchUpdated" => "fileChangeUpdated",
        "item/mcpToolCall/progress" => "mcpToolCallProgress",
        "turn/diff/updated" => "turnDiffUpdated",
        "turn/plan/updated" => "turnPlanUpdated",
        "serverRequest/resolved" => "approvalResolved",
        "account/updated" => "accountUpdated",
        "account/rateLimits/updated" => "rateLimitsUpdated",
        "account/login/completed" => "accountLoginCompleted",
        "error" => "error",
        "warning" | "guardianWarning" | "deprecationNotice" | "configWarning" => "warning",
        _ => "generic",
    }
}

pub fn normalize_thread_page(result: &Value, archived: bool) -> Result<CodexThreadPage> {
    Ok(CodexThreadPage {
        data: result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("thread/list response is missing data"))?
            .iter()
            .map(|thread| normalize_thread(thread, archived))
            .collect::<Result<Vec<_>>>()?,
        next_cursor: optional_string(result, "nextCursor"),
        backwards_cursor: optional_string(result, "backwardsCursor"),
    })
}

pub fn normalize_thread_session(
    result: &Value,
    requested: &ThreadPreferences,
) -> Result<CodexThreadSession> {
    let thread = normalize_thread(
        result
            .get("thread")
            .ok_or_else(|| anyhow!("Thread response is missing thread"))?,
        false,
    )?;
    let effective_model = optional_string(result, "model");
    let effective_effort = optional_string(result, "reasoningEffort");
    let effective_tier = optional_string(result, "serviceTier");
    let sandbox = result
        .pointer("/sandbox/type")
        .and_then(Value::as_str)
        .unwrap_or(requested.permission_mode.sandbox_mode())
        .to_string();
    Ok(CodexThreadSession {
        settings: EffectiveThreadSettings {
            requested_model: requested.model.clone(),
            model_resolution: resolution(&requested.model, &effective_model),
            effective_model,
            requested_reasoning_effort: requested.reasoning_effort.clone(),
            reasoning_effort_resolution: resolution(&requested.reasoning_effort, &effective_effort),
            effective_reasoning_effort: effective_effort,
            requested_service_tier: requested.service_tier.clone(),
            service_tier_resolution: resolution(&requested.service_tier, &effective_tier),
            effective_service_tier: effective_tier,
            permission_mode: requested.permission_mode,
            permission_profile: requested.permission_mode.profile_id().to_string(),
            approval_policy: result
                .get("approvalPolicy")
                .map(value_label)
                .unwrap_or_else(|| requested.permission_mode.approval_policy().to_string()),
            sandbox_policy: sandbox,
            cwd: optional_string(result, "cwd").unwrap_or_else(|| thread.cwd.clone()),
        },
        instruction_sources: result
            .get("instructionSources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        thread,
    })
}

fn resolution(requested: &Option<String>, effective: &Option<String>) -> String {
    match requested {
        None => "runtimeDefault".to_string(),
        Some(requested) if effective.as_deref() == Some(requested.as_str()) => {
            "applied".to_string()
        }
        Some(_) => "runtimeFallback".to_string(),
    }
}

pub fn normalize_catalog(
    models: &Value,
    account: &Value,
    limits: &Value,
    profiles: &Value,
    config: &Value,
) -> Result<CodexRuntimeCatalog> {
    let models = models
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("model/list response is missing data"))?
        .iter()
        .filter_map(|model| normalize_model(model).ok())
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Err(anyhow!("Codex returned no selectable models"));
    }
    let account_value = account.get("account").filter(|value| !value.is_null());
    let auth_mode = account_value.and_then(|value| optional_string(value, "type"));
    let plan_type = account_value.and_then(|value| optional_string(value, "planType"));
    let (five_hour_limit, weekly_limit) = normalize_rate_limits(limits);
    let config = config.get("config").unwrap_or(&Value::Null);
    Ok(CodexRuntimeCatalog {
        models,
        account: CodexAccount {
            signed_in: account_value.is_some(),
            authentication_mode: auth_mode,
            plan_type,
            requires_openai_auth: account
                .get("requiresOpenaiAuth")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            five_hour_limit,
            weekly_limit,
        },
        permission_profiles: profiles
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|profile| {
                Some(CodexPermissionProfile {
                    id: optional_string(profile, "id")?,
                    description: optional_string(profile, "description"),
                    allowed: profile
                        .get("allowed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .collect(),
        configured_model: optional_string(config, "model"),
        configured_reasoning_effort: optional_string(config, "model_reasoning_effort"),
        configured_service_tier: optional_string(config, "service_tier"),
    })
}

fn normalize_model(value: &Value) -> Result<CodexModel> {
    Ok(CodexModel {
        id: required_string(value, "id")?,
        model: optional_string(value, "model").unwrap_or_default(),
        display_name: optional_string(value, "displayName").unwrap_or_default(),
        description: optional_string(value, "description").unwrap_or_default(),
        hidden: value
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_default: value
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        default_reasoning_effort: optional_string(value, "defaultReasoningEffort")
            .unwrap_or_default(),
        reasoning_efforts: value
            .get("supportedReasoningEfforts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|effort| {
                Some(CodexReasoningOption {
                    value: optional_string(effort, "reasoningEffort")?,
                    description: optional_string(effort, "description").unwrap_or_default(),
                })
            })
            .collect(),
        service_tiers: value
            .get("serviceTiers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|tier| {
                Some(CodexServiceTier {
                    id: optional_string(tier, "id")?,
                    name: optional_string(tier, "name").unwrap_or_default(),
                    description: optional_string(tier, "description").unwrap_or_default(),
                })
            })
            .collect(),
        default_service_tier: optional_string(value, "defaultServiceTier"),
        input_modalities: value
            .get("inputModalities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(value_label)
            .collect(),
    })
}

fn normalize_rate_limits(
    result: &Value,
) -> (Option<CodexRateLimitWindow>, Option<CodexRateLimitWindow>) {
    const FIVE_HOURS: i64 = 300;
    const WEEK: i64 = 10_080;

    // Newer runtimes report independent model and reserve buckets alongside
    // the general Codex allowance. Those buckets can use the same 5-hour or
    // weekly durations, so selecting solely by duration can display an unused
    // model bucket as 100% remaining. Restrict the aggregate UI to the known
    // general Codex buckets and retain the legacy single-snapshot fallback.
    let mut snapshots = Vec::new();
    if let Some(limits) = result.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for limit_id in ["codex", "burst"] {
            if let Some(snapshot) = limits.get(limit_id) {
                snapshots.push(snapshot);
            }
        }
        for snapshot in limits.values() {
            let limit_id = snapshot.get("limitId").and_then(Value::as_str);
            if matches!(limit_id, Some("codex" | "burst"))
                && !snapshots.iter().any(|known| std::ptr::eq(*known, snapshot))
            {
                snapshots.push(snapshot);
            }
        }
    }
    if snapshots.is_empty() {
        snapshots.extend(result.get("rateLimits"));
    }
    let windows = snapshots
        .into_iter()
        .flat_map(|snapshot| [snapshot.get("primary"), snapshot.get("secondary")])
        .flatten()
        .filter_map(normalize_rate_window)
        .collect::<Vec<_>>();
    let tolerance = |actual: Option<i64>, expected: i64| {
        actual.is_some_and(|actual| (actual - expected).abs() <= expected / 20)
    };
    (
        windows
            .iter()
            .find(|window| tolerance(window.window_duration_mins, FIVE_HOURS))
            .cloned(),
        windows
            .iter()
            .find(|window| tolerance(window.window_duration_mins, WEEK))
            .cloned(),
    )
}

fn normalize_rate_window(value: &Value) -> Option<CodexRateLimitWindow> {
    Some(CodexRateLimitWindow {
        used_percent: value.get("usedPercent")?.as_f64()?,
        window_duration_mins: value.get("windowDurationMins").and_then(Value::as_i64),
        resets_at: value.get("resetsAt").and_then(Value::as_i64),
    })
}

pub fn normalize_skills(result: &Value) -> Vec<CodexSkill> {
    result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|skill| {
            Some(CodexSkill {
                name: optional_string(skill, "name")?,
                description: optional_string(skill, "description").unwrap_or_default(),
                short_description: optional_string(skill, "shortDescription"),
                path: optional_string(skill, "path")?,
                scope: skill.get("scope").map(value_label).unwrap_or_default(),
                enabled: skill
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            })
        })
        .collect()
}

pub fn normalize_plugins(result: &Value) -> Vec<CodexPlugin> {
    let mut plugins = result
        .get("marketplaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|marketplace| {
            let marketplace_name = optional_string(marketplace, "name").unwrap_or_default();
            marketplace
                .get("plugins")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |plugin| {
                    let installed = plugin
                        .get("installed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let enabled = plugin
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let disabled_by_admin = plugin.get("availability").and_then(Value::as_str)
                        == Some("DISABLED_BY_ADMIN");
                    if !installed || !enabled || disabled_by_admin {
                        return None;
                    }
                    let id = optional_string(plugin, "id")?;
                    let name = optional_string(plugin, "name")?;
                    let interface = plugin.get("interface").unwrap_or(&Value::Null);
                    let display_name = optional_string(interface, "displayName")
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| name.clone());
                    let description =
                        optional_string(interface, "shortDescription").unwrap_or_default();
                    Some(CodexPlugin {
                        id,
                        name,
                        display_name,
                        description,
                        marketplace: marketplace_name.clone(),
                        enabled,
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    plugins.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    plugins
}

fn normalize_token_usage(value: &Value) -> CodexTokenUsage {
    let total = value.get("total").unwrap_or(&Value::Null);
    let last = value.get("last").unwrap_or(&Value::Null);
    CodexTokenUsage {
        total_tokens: integer(total, "totalTokens"),
        input_tokens: integer(total, "inputTokens"),
        cached_input_tokens: integer(total, "cachedInputTokens"),
        output_tokens: integer(total, "outputTokens"),
        reasoning_output_tokens: integer(total, "reasoningOutputTokens"),
        last_total_tokens: integer(last, "totalTokens"),
        model_context_window: value.get("modelContextWindow").and_then(Value::as_i64),
    }
}

fn normalize_error(value: &Value) -> CodexError {
    CodexError {
        message: optional_string(value, "message").unwrap_or_else(|| value_label(value)),
        details: optional_string(value, "additionalDetails"),
        kind: value.get("codexErrorInfo").map(value_label),
        will_retry: false,
    }
}

fn required_string(value: &Value, key: &str) -> Result<String> {
    optional_string(value, key).with_context(|| format!("Missing string field {key}"))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn integer(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

pub fn value_label(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Object(map) => map
            .get("type")
            .or_else(|| map.get("kind"))
            .or_else(|| map.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default()),
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        build_wire_inputs, normalize_item, normalize_notification, normalize_plugins,
        normalize_rate_limits, normalize_server_request, ComposerInput,
    };

    #[test]
    fn normalizes_structured_command_items() {
        let item = normalize_item(&json!({
            "type": "commandExecution",
            "id": "item-1",
            "command": "git status",
            "cwd": "/tmp/repo",
            "status": "completed",
            "aggregatedOutput": " M src/lib.rs",
            "exitCode": 0,
            "durationMs": 42
        }))
        .expect("command item should normalize");
        assert_eq!(item.kind, "commandExecution");
        assert_eq!(item.command.as_deref(), Some("git status"));
        assert_eq!(item.output.as_deref(), Some(" M src/lib.rs"));
        assert_eq!(item.exit_code, Some(0));
    }

    #[test]
    fn preserves_client_user_message_ids_for_optimistic_reconciliation() {
        let item = normalize_item(&json!({
            "type": "userMessage",
            "id": "item-user-1",
            "clientId": "atcontroller-message-1",
            "content": [{"type": "text", "text": "Run the tests", "text_elements": []}]
        }))
        .expect("user message should normalize");
        assert_eq!(item.client_id.as_deref(), Some("atcontroller-message-1"));
        assert_eq!(item.content[0].text.as_deref(), Some("Run the tests"));
    }

    #[test]
    fn bounds_verbose_history_payloads_before_the_tauri_boundary() {
        let command = normalize_item(&json!({
            "type": "commandExecution",
            "id": "large-command",
            "aggregatedOutput": "x".repeat(700_000)
        }))
        .expect("large command should normalize");
        let output = command
            .output
            .expect("command output should remain available");
        assert!(output.len() < 136_000);
        assert!(output.contains("Earlier content truncated"));

        let tool = normalize_item(&json!({
            "type": "mcpToolCall",
            "id": "large-tool",
            "server": "fixture",
            "tool": "fixture",
            "result": { "content": "y".repeat(400_000) }
        }))
        .expect("large tool result should normalize");
        let result = tool
            .tool_result
            .expect("tool result should remain structured");
        assert_eq!(result.get("truncated").and_then(Value::as_bool), Some(true));
        assert!(result.get("preview").and_then(Value::as_str).is_some());
    }

    #[test]
    fn playwright_tool_calls_become_redacted_browser_activity() {
        let item = normalize_item(&json!({
            "type": "mcpToolCall",
            "id": "browser-1",
            "server": "atcontroller-playwright",
            "tool": "browser_fill_form",
            "status": "completed",
            "arguments": {
                "fields": [
                    {
                        "name": "Password",
                        "ref": "input-2",
                        "type": "textbox",
                        "value": "do-not-persist"
                    }
                ]
            },
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": "Page Title: Sign in\nPage URL: https://example.test/login?token=secret&tab=main"
                    }
                ]
            }
        }))
        .expect("browser item should normalize");
        let activity = item.browser_activity.expect("browser activity");
        assert_eq!(activity.activity_type, "type");
        assert_eq!(activity.page_title.as_deref(), Some("Sign in"));
        assert_eq!(
            activity.url.as_deref(),
            Some("https://example.test/login?token=[redacted]&tab=main")
        );
        let arguments = item.tool_arguments.expect("redacted arguments");
        assert_eq!(arguments["fields"][0]["value"], "[redacted]");
        let result = item.tool_result.expect("redacted result");
        assert_eq!(result["content"][0]["text"], "[redacted]");
    }

    #[test]
    fn browser_named_tools_from_unrelated_servers_remain_generic_mcp_items() {
        let item = normalize_item(&json!({
            "type": "mcpToolCall",
            "id": "not-playwright",
            "server": "unrelated-tools",
            "tool": "browser_click",
            "status": "completed",
            "arguments": { "element": "Submit" }
        }))
        .expect("generic item should normalize");
        assert!(item.browser_activity.is_none());
        assert_eq!(item.tool_arguments.unwrap()["element"], "Submit");
    }

    #[test]
    fn browser_console_and_network_failures_are_grouped() {
        let console = normalize_item(&json!({
            "type": "mcpToolCall",
            "id": "console-1",
            "server": "playwright",
            "tool": "browser_console_messages",
            "status": "completed",
            "result": { "content": [{ "text": "[error] first\nUncaught second\n[log] ok" }] }
        }))
        .expect("console item")
        .browser_activity
        .expect("console activity");
        assert_eq!(console.console_error_count, 2);
        assert!(console
            .summary_lines
            .iter()
            .any(|line| line.contains("[error] first")));

        let network = normalize_item(&json!({
            "type": "mcpToolCall",
            "id": "network-1",
            "server": "playwright",
            "tool": "browser_network_requests",
            "status": "completed",
            "result": { "content": [{ "text": "GET /ok => [200]\nPOST /bad => [500]\nGET /gone => [404]" }] }
        }))
        .expect("network item")
        .browser_activity
        .expect("network activity");
        assert_eq!(network.failed_request_count, 2);
    }

    #[test]
    fn unknown_notifications_remain_generic_and_lossless() {
        let event = normalize_notification(
            7,
            "future/runtime/event",
            &json!({"threadId":"thread-1","newField":true}),
        );
        assert_eq!(event.kind, "generic");
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.data.unwrap()["newField"], true);
    }

    #[test]
    fn skill_change_notifications_invalidate_composer_discovery() {
        let event = normalize_notification(
            8,
            "skills/changed",
            &json!({"paths":["/tmp/project/.github/skills/review/SKILL.md"]}),
        );
        assert_eq!(event.kind, "skillsChanged");
        assert_eq!(
            event.data.unwrap()["paths"][0],
            "/tmp/project/.github/skills/review/SKILL.md"
        );
    }

    #[test]
    fn high_frequency_notifications_keep_only_ui_relevant_payloads() {
        let diff = normalize_notification(
            9,
            "turn/diff/updated",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "diff": "large duplicate diff"
            }),
        );
        assert_eq!(diff.kind, "turnDiffUpdated");
        assert!(diff.data.is_none());

        let resolved = normalize_notification(
            10,
            "serverRequest/resolved",
            &json!({
                "threadId": "thread-1",
                "requestId": 42,
                "largeUnusedPayload": "not forwarded"
            }),
        );
        assert_eq!(resolved.data.unwrap(), json!({ "requestId": 42 }));
    }

    #[test]
    fn rate_limit_windows_are_selected_by_duration() {
        let (five_hour, weekly) = normalize_rate_limits(&json!({
            "rateLimitsByLimitId": {
                "burst": { "primary": { "usedPercent": 12.5, "windowDurationMins": 300 } },
                "codex": { "primary": { "usedPercent": 33.0, "windowDurationMins": 10080 } }
            }
        }));
        assert_eq!(five_hour.unwrap().used_percent, 12.5);
        assert_eq!(weekly.unwrap().used_percent, 33.0);
    }

    #[test]
    fn rate_limit_windows_ignore_model_specific_and_reserve_buckets() {
        let (five_hour, weekly) = normalize_rate_limits(&json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 1.0, "windowDurationMins": 10080 }
            },
            "rateLimitsByLimitId": {
                "base_model_inference": {
                    "limitId": "base_model_inference",
                    "primary": { "usedPercent": 0.0, "windowDurationMins": 10080 }
                },
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 1.0, "windowDurationMins": 10080 }
                },
                "codex_bengalfox": {
                    "limitId": "codex_bengalfox",
                    "primary": { "usedPercent": 0.0, "windowDurationMins": 300 },
                    "secondary": { "usedPercent": 0.0, "windowDurationMins": 10080 }
                }
            }
        }));

        assert!(five_hour.is_none());
        assert_eq!(weekly.unwrap().used_percent, 1.0);
    }

    #[test]
    fn legacy_approval_fields_are_normalized_for_the_structured_ui() {
        let event = normalize_server_request(
            8,
            json!("approval-1"),
            "execCommandApproval",
            &json!({
                "conversationId": "thread-1",
                "callId": "command-1",
                "command": ["printf", "hello world"],
                "cwd": "/tmp/project",
                "reason": "write access"
            }),
        );
        let approval = event.approval.expect("approval");
        assert_eq!(approval.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(approval.item_id.as_deref(), Some("command-1"));
        assert_eq!(approval.command.as_deref(), Some("printf 'hello world'"));
    }

    #[test]
    fn turn_plan_updates_become_a_stable_structured_item() {
        let event = normalize_notification(
            9,
            "turn/plan/updated",
            &json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "explanation": "Implement and verify",
                "plan": [
                    {"step": "Implement", "status": "completed"},
                    {"step": "Verify", "status": "inProgress"}
                ]
            }),
        );
        let item = event.item.expect("plan item");
        assert_eq!(item.id, "plan-turn-1");
        assert_eq!(item.kind, "plan");
        assert_eq!(item.status.as_deref(), Some("inProgress"));
        assert_eq!(item.details.unwrap()["plan"][1]["step"], "Verify");
    }

    #[test]
    fn empty_text_inputs_are_rejected() {
        let error = build_wire_inputs(
            "/tmp",
            vec![ComposerInput::Text {
                text: "  ".to_string(),
            }],
        )
        .expect_err("empty input should fail");
        assert!(error.to_string().contains("non-empty"));
    }

    #[test]
    fn plugin_inputs_use_the_structured_plugin_mention_scheme() {
        let inputs = build_wire_inputs(
            "/tmp",
            vec![ComposerInput::Plugin {
                id: "computer-use@openai-bundled".to_string(),
                name: "Computer Use".to_string(),
            }],
        )
        .expect("installed plugin mention should serialize");
        assert_eq!(
            inputs,
            vec![json!({
                "type": "mention",
                "name": "Computer Use",
                "path": "plugin://computer-use@openai-bundled"
            })]
        );
    }

    #[test]
    fn installed_plugins_are_normalized_for_composer_mentions() {
        let plugins = normalize_plugins(&json!({
            "marketplaces": [{
                "name": "openai-bundled",
                "plugins": [
                    {
                        "id": "computer-use@openai-bundled",
                        "name": "computer-use",
                        "installed": true,
                        "enabled": true,
                        "availability": "AVAILABLE",
                        "interface": {
                            "displayName": "Computer Use",
                            "shortDescription": "Control Mac apps"
                        }
                    },
                    {
                        "id": "disabled@openai-bundled",
                        "name": "disabled",
                        "installed": true,
                        "enabled": false,
                        "availability": "AVAILABLE"
                    }
                ]
            }]
        }));
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "computer-use@openai-bundled");
        assert_eq!(plugins[0].display_name, "Computer Use");
    }
}
