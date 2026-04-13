use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader as StdBufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::git_tools;
use crate::models::{
    ClaudeTurnCompletionSummary, ContextFilePreview, ContextPreview, ImportableClaudeProject,
    ImportableClaudeSession, PreparedNativeFork, RunClaudeRequest, RunClaudeResponse, RunExitEvent,
    RunMetadata, Settings, StreamEvent, TerminalDataEvent, TerminalExitEvent,
    TerminalOutputSnapshot, TerminalReadyEvent, TerminalSshAuthStatusEvent, TerminalStartResponse,
    TerminalTurnCompletedEvent, ThreadRunStatus, TranscriptEntry, WorkspaceKind,
    WorkspaceShellStartResponse,
};
use crate::skills;
use crate::storage;

const STREAM_EVENT: &str = "claude://run-stream";
const EXIT_EVENT: &str = "claude://run-exit";
const TERMINAL_DATA_EVENT: &str = "terminal:data";
const TERMINAL_READY_EVENT: &str = "terminal:ready";
const TERMINAL_SSH_AUTH_STATUS_EVENT: &str = "terminal:ssh-auth-status";
const TERMINAL_TURN_COMPLETED_EVENT: &str = "terminal:turn-completed";
const TERMINAL_EXIT_EVENT: &str = "terminal:exit";
const THREAD_UPDATED_EVENT: &str = "thread:updated";
const LAUNCH_OUTPUT_PARSE_BUFFER_MAX: usize = 16 * 1024;
const POST_CONNECT_PROMPT_BUFFER_MAX: usize = 16 * 1024;
const POST_CONNECT_COMMAND_AFTER_SSH_START_TIMEOUT: Duration = Duration::from_secs(6);
const CLAUDE_TURN_COMPLETION_POLL_INTERVAL: Duration = Duration::from_millis(250);
const TERMINAL_LOG_SNAPSHOT_MAX_BYTES: u64 = 512 * 1024;
const TERMINAL_STREAM_TAIL_MAX_CHARS: u64 = 280_000;
const TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS: u64 = 40_000;
const _: () = assert!(TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS < TERMINAL_STREAM_TAIL_MAX_CHARS);
const TERMINAL_ENV_DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(8);
const COMMIT_MESSAGE_TIMEOUT: Duration = Duration::from_secs(90);
const COMMAND_TIMEOUT_POLL_INTERVAL: Duration = Duration::from_millis(20);
const FORK_CLONE_FINGERPRINT_UUID_LIMIT: usize = 3;
const FORK_CLONE_FINGERPRINT_SCAN_LIMIT: usize = 64;

fn run_std_command_with_timeout(
    mut command: StdCommand,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let started = Instant::now();

    loop {
        if child.try_wait()?.is_some() {
            return Ok(child.wait_with_output()?);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("{label} timed out after {}s", timeout.as_secs()));
        }
        std::thread::sleep(COMMAND_TIMEOUT_POLL_INTERVAL);
    }
}

fn should_redact_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
        || upper.contains("PASSWD")
        || upper.contains("CREDENTIAL")
        || upper.contains("PRIVATE_KEY")
        || upper.contains("AUTH")
        || upper.contains("COOKIE")
        || upper.contains("SESSION")
        || upper.contains("BEARER")
        || upper.ends_with("_KEY")
}

fn redact_env_line(line: &str) -> String {
    let Some((key, _value)) = line.split_once('=') else {
        return line.to_string();
    };
    if should_redact_env_key(key) {
        format!("{key}=<redacted>")
    } else {
        line.to_string()
    }
}

fn sanitize_env_diagnostics_stdout(raw: &str) -> String {
    let mut result = String::new();
    let mut env_section = true;
    for line in raw.lines() {
        if env_section && line.trim() == "---" {
            env_section = false;
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if env_section {
            result.push_str(&redact_env_line(line));
        } else {
            result.push_str(line);
        }
        result.push('\n');
    }
    if !raw.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    }
    result
}

fn sanitize_claude_project_dir_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn claude_projects_root() -> Result<PathBuf> {
    if let Ok(override_root) = env::var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT") {
        if !override_root.trim().is_empty() {
            return Ok(PathBuf::from(override_root));
        }
    }
    let home_dir = dirs::home_dir().ok_or_else(|| anyhow!("Unable to resolve home directory"))?;
    Ok(home_dir.join(".claude").join("projects"))
}

fn claude_project_dir_for_workspace(workspace_path: &str) -> PathBuf {
    let normalized_workspace_path = fs::canonicalize(workspace_path)
        .unwrap_or_else(|_| PathBuf::from(workspace_path))
        .to_string_lossy()
        .to_string();
    PathBuf::from(sanitize_claude_project_dir_name(&normalized_workspace_path))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionsIndex {
    #[serde(default)]
    original_path: Option<String>,
    #[serde(default)]
    entries: Vec<ClaudeSessionsIndexEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionsIndexEntry {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    first_prompt: Option<String>,
    #[serde(default)]
    message_count: Option<u64>,
    #[serde(default)]
    created: Option<DateTime<Utc>>,
    #[serde(default)]
    modified: Option<DateTime<Utc>>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeJsonlMessage {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    content: Option<Value>,
    #[serde(default, rename = "stop_reason")]
    stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeJsonlForkedFrom {
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeJsonlEntry {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    message: Option<ClaudeJsonlMessage>,
    #[serde(default)]
    forked_from: Option<ClaudeJsonlForkedFrom>,
    #[serde(default)]
    timestamp: Option<DateTime<Utc>>,
}

fn canonicalize_path_or_original(path: &str) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

fn overlay_worktree_repo_root_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }

    for ancestor in Path::new(trimmed).ancestors() {
        let Some(worktrees_dir) = ancestor.parent() else {
            continue;
        };
        if worktrees_dir.file_name().and_then(|name| name.to_str()) != Some("worktrees") {
            continue;
        }

        let Some(claude_dir) = worktrees_dir.parent() else {
            continue;
        };
        if claude_dir.file_name().and_then(|name| name.to_str()) != Some(".claude") {
            continue;
        }

        let Some(repo_root) = claude_dir.parent() else {
            continue;
        };
        let repo_root = repo_root.to_string_lossy().to_string();
        if repo_root.trim().is_empty() {
            continue;
        }
        return Some(canonicalize_path_or_original(&repo_root));
    }

    None
}

fn normalize_importable_project_path(project_path: &str) -> String {
    let canonical_path = canonicalize_path_or_original(project_path);
    let current_worktree_root = git_tools::resolve_worktree_root_path(project_path)
        .ok()
        .flatten();
    let main_repo_root = git_tools::resolve_main_repo_root_path(project_path)
        .ok()
        .flatten();

    match (current_worktree_root, main_repo_root) {
        (Some(current_root), Some(main_root)) if current_root != main_root => main_root,
        _ if overlay_worktree_repo_root_path(project_path).is_some() => {
            overlay_worktree_repo_root_path(project_path).unwrap_or(canonical_path)
        }
        _ => canonical_path,
    }
}

fn resolve_terminal_workspace_context_path(path: &str) -> String {
    git_tools::resolve_worktree_root_path(path)
        .ok()
        .flatten()
        .or_else(|| overlay_worktree_repo_root_path(path))
        .unwrap_or_else(|| canonicalize_path_or_original(path))
}

fn trim_to_option(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn session_sort_timestamp(session: &ImportableClaudeSession) -> i64 {
    session
        .modified_at
        .or(session.created_at)
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or(0)
}

fn sort_importable_sessions(sessions: &mut [ImportableClaudeSession]) {
    sessions.sort_by(|left, right| {
        session_sort_timestamp(right)
            .cmp(&session_sort_timestamp(left))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
}

fn project_sort_timestamp(project: &ImportableClaudeProject) -> i64 {
    project
        .sessions
        .iter()
        .map(session_sort_timestamp)
        .max()
        .unwrap_or(0)
}

fn claude_project_name(project_path: &str) -> String {
    Path::new(project_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| project_path.to_string())
}

fn load_local_workspace_lookup() -> Result<HashMap<String, (String, String)>> {
    let mut lookup = HashMap::new();
    for workspace in storage::load_workspaces()? {
        if workspace.kind != WorkspaceKind::Local {
            continue;
        }
        lookup.insert(
            canonicalize_path_or_original(&workspace.path),
            (workspace.id, workspace.name),
        );
    }
    Ok(lookup)
}

fn build_importable_project(
    project_path: String,
    mut sessions: Vec<ImportableClaudeSession>,
    workspace_lookup: &HashMap<String, (String, String)>,
) -> Option<ImportableClaudeProject> {
    if sessions.is_empty() {
        return None;
    }

    let normalized_path = normalize_importable_project_path(&project_path);
    sort_importable_sessions(&mut sessions);
    let workspace_match = workspace_lookup.get(&normalized_path);

    Some(ImportableClaudeProject {
        name: claude_project_name(&normalized_path),
        path_exists: Path::new(&normalized_path).is_dir(),
        path: normalized_path,
        workspace_id: workspace_match.map(|(workspace_id, _)| workspace_id.clone()),
        workspace_name: workspace_match.map(|(_, workspace_name)| workspace_name.clone()),
        sessions,
    })
}

fn discover_sessions_from_index(
    project_dir: &Path,
    workspace_lookup: &HashMap<String, (String, String)>,
) -> Result<Option<ImportableClaudeProject>> {
    let index_path = project_dir.join("sessions-index.json");
    if !index_path.is_file() {
        return Ok(None);
    }

    let raw = fs::read_to_string(index_path)?;
    let index: ClaudeSessionsIndex = serde_json::from_str(&raw)?;

    let project_path = trim_to_option(index.original_path.clone()).or_else(|| {
        index
            .entries
            .iter()
            .find_map(|entry| trim_to_option(entry.project_path.clone()))
    });
    let Some(project_path) = project_path else {
        return Ok(None);
    };

    let mut by_session_id = HashMap::new();
    for entry in index.entries {
        let Some(session_id) = trim_to_option(entry.session_id) else {
            continue;
        };
        by_session_id.insert(
            session_id.clone(),
            ImportableClaudeSession {
                session_id,
                summary: trim_to_option(entry.summary),
                first_prompt: trim_to_option(entry.first_prompt),
                message_count: entry.message_count.unwrap_or(0),
                created_at: entry.created,
                modified_at: entry.modified,
                git_branch: trim_to_option(entry.git_branch),
            },
        );
    }

    Ok(build_importable_project(
        project_path,
        by_session_id.into_values().collect(),
        workspace_lookup,
    ))
}

fn json_value_to_prompt_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) => items.iter().find_map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(ToString::to_string)
        }),
        _ => None,
    }
}

fn discover_sessions_from_jsonl(
    project_dir: &Path,
    workspace_lookup: &HashMap<String, (String, String)>,
) -> Result<Option<ImportableClaudeProject>> {
    let mut project_path = None;
    let mut sessions_by_id: HashMap<String, ImportableClaudeSession> = HashMap::new();

    for entry in fs::read_dir(project_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
        {
            continue;
        }

        let file_session_id = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .filter(|stem| !stem.trim().is_empty());
        let Some(file_session_id) = file_session_id else {
            continue;
        };
        // The filename stem is the canonical session identifier and is used
        // as the HashMap key. A separate `session_id` tracks the in-file
        // value for the ImportableClaudeSession record.
        let mut session_id = file_session_id.clone();

        let metadata = entry.metadata()?;
        let mut created_at = metadata.created().ok().map(DateTime::<Utc>::from);
        let modified_at = metadata.modified().ok().map(DateTime::<Utc>::from);
        if created_at.is_none() {
            created_at = modified_at;
        }

        let file = File::open(&path)?;
        let reader = StdBufReader::new(file);
        let mut first_prompt = None;
        let mut git_branch = None;
        let mut observed_project_path = None;
        let mut message_count = 0_u64;
        let mut latest_timestamp = modified_at;

        for line in reader.lines() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let Ok(parsed) = serde_json::from_str::<ClaudeJsonlEntry>(trimmed) else {
                continue;
            };
            if observed_project_path.is_none() {
                observed_project_path = trim_to_option(parsed.cwd.clone());
            }
            if git_branch.is_none() {
                git_branch = trim_to_option(parsed.git_branch.clone());
            }
            if let Some(parsed_session_id) = trim_to_option(parsed.session_id.clone()) {
                session_id = parsed_session_id;
            }
            if let Some(timestamp) = parsed.timestamp {
                latest_timestamp = Some(
                    latest_timestamp
                        .map(|current| current.max(timestamp))
                        .unwrap_or(timestamp),
                );
                if created_at.is_none() {
                    created_at = Some(timestamp);
                }
            }
            if parsed.r#type.as_deref() == Some("user")
                && parsed
                    .message
                    .as_ref()
                    .and_then(|message| message.role.as_deref())
                    == Some("user")
            {
                message_count += 1;
                if first_prompt.is_none() {
                    first_prompt = parsed
                        .message
                        .as_ref()
                        .and_then(|message| message.content.as_ref())
                        .and_then(json_value_to_prompt_text);
                }
            }

            // Early-exit: we have enough metadata for import discovery.
            // git_branch is not required because non-git projects will never
            // populate it, and the remaining fields are sufficient for display.
            if first_prompt.is_some() && observed_project_path.is_some() && message_count > 0 {
                break;
            }
        }

        if project_path.is_none() {
            project_path = observed_project_path;
        }

        let session = sessions_by_id
            .entry(file_session_id.clone())
            .or_insert_with(|| ImportableClaudeSession {
                session_id: session_id.clone(),
                summary: None,
                first_prompt: None,
                message_count: 0,
                created_at,
                modified_at: latest_timestamp,
                git_branch: git_branch.clone(),
            });

        if session.first_prompt.is_none() {
            session.first_prompt = first_prompt;
        }
        session.message_count = session.message_count.max(message_count);
        if session.created_at.is_none() {
            session.created_at = created_at;
        }
        session.modified_at = match (session.modified_at, latest_timestamp) {
            (Some(current), Some(next)) => Some(current.max(next)),
            (current, None) => current,
            (None, next) => next,
        };
        if session.git_branch.is_none() {
            session.git_branch = git_branch;
        }
    }

    let Some(project_path) = project_path else {
        return Ok(None);
    };

    Ok(build_importable_project(
        project_path,
        sessions_by_id.into_values().collect(),
        workspace_lookup,
    ))
}

pub fn discover_importable_claude_sessions() -> Result<Vec<ImportableClaudeProject>> {
    let projects_root = claude_projects_root()?;
    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }

    let workspace_lookup = load_local_workspace_lookup()?;
    let mut projects = Vec::new();

    for entry in fs::read_dir(projects_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let project_dir = entry.path();
        let discovered = match discover_sessions_from_index(&project_dir, &workspace_lookup)? {
            Some(project) => Some(project),
            None => discover_sessions_from_jsonl(&project_dir, &workspace_lookup)?,
        };
        if let Some(project) = discovered {
            projects.push(project);
        }
    }

    projects.sort_by(|left, right| {
        project_sort_timestamp(right)
            .cmp(&project_sort_timestamp(left))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(projects)
}

fn find_importable_session_in_project_dir(
    project_dir: &Path,
    claude_session_id: &str,
) -> Result<Option<ImportableClaudeSession>> {
    let workspace_lookup: HashMap<String, (String, String)> = HashMap::new();

    if let Some(project) = discover_sessions_from_index(project_dir, &workspace_lookup)? {
        if let Some(session) = project
            .sessions
            .into_iter()
            .find(|session| session.session_id == claude_session_id)
        {
            return Ok(Some(session));
        }
    }

    if let Some(project) = discover_sessions_from_jsonl(project_dir, &workspace_lookup)? {
        if let Some(session) = project
            .sessions
            .into_iter()
            .find(|session| session.session_id == claude_session_id)
        {
            return Ok(Some(session));
        }
    }

    Ok(None)
}

fn project_dir_index_mentions_claude_session(
    project_dir: &Path,
    claude_session_id: &str,
) -> Result<bool> {
    let index_path = project_dir.join("sessions-index.json");
    if !index_path.is_file() {
        return Ok(false);
    }

    let raw = fs::read_to_string(index_path)?;
    let index: ClaudeSessionsIndex = serde_json::from_str(&raw)?;
    Ok(index
        .entries
        .into_iter()
        .filter_map(|entry| trim_to_option(entry.session_id))
        .any(|session_id| session_id == claude_session_id))
}

fn project_dir_contains_claude_session(
    project_dir: &Path,
    claude_session_id: &str,
) -> Result<bool> {
    if project_dir
        .join(format!("{claude_session_id}.jsonl"))
        .is_file()
    {
        return Ok(true);
    }

    project_dir_index_mentions_claude_session(project_dir, claude_session_id)
}

fn find_any_claude_session_project_dir(
    projects_root: &Path,
    claude_session_id: &str,
) -> Result<Option<PathBuf>> {
    let jsonl_file_name = format!("{claude_session_id}.jsonl");
    for entry in fs::read_dir(projects_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let candidate = entry.path();
        if candidate.join(&jsonl_file_name).is_file() {
            return Ok(Some(candidate));
        }
    }

    for entry in fs::read_dir(projects_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let candidate = entry.path();
        if project_dir_index_mentions_claude_session(&candidate, claude_session_id)? {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn find_any_claude_session_jsonl_project_dir(
    projects_root: &Path,
    claude_session_id: &str,
) -> Result<Option<PathBuf>> {
    let jsonl_file_name = format!("{claude_session_id}.jsonl");
    for entry in fs::read_dir(projects_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let candidate = entry.path();
        if candidate.join(&jsonl_file_name).is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn resolve_importable_claude_session_project_dir(
    workspace_path: &str,
    claude_session_id: &str,
) -> Result<PathBuf> {
    let projects_root = claude_projects_root()?;
    if !projects_root.is_dir() {
        return Err(anyhow!(
            "Claude local session history was not found in {}.",
            projects_root.to_string_lossy()
        ));
    }

    let expected_project_dir = projects_root.join(claude_project_dir_for_workspace(workspace_path));
    if project_dir_contains_claude_session(&expected_project_dir, claude_session_id)? {
        return Ok(expected_project_dir);
    }

    let expected_workspace_root = normalize_importable_project_path(workspace_path);
    if let Some(project_dir) =
        find_any_claude_session_jsonl_project_dir(&projects_root, claude_session_id)?
    {
        let session_path = project_dir.join(format!("{claude_session_id}.jsonl"));
        let belongs_to_expected_workspace = latest_claude_session_cwd_from_jsonl(&session_path)
            .map(|cwd| normalize_importable_project_path(&cwd) == expected_workspace_root)
            .unwrap_or(false);
        if belongs_to_expected_workspace {
            return Ok(project_dir);
        }
        return Err(anyhow!(
            "This Claude session belongs to a different workspace. Import it from the original project folder instead."
        ));
    }

    Err(anyhow!(
        "No local Claude conversation was found with session ID {claude_session_id}."
    ))
}

#[derive(Debug, Clone)]
struct ForkChildCandidate {
    session_id: String,
    created_at_ms: i64,
}

fn list_project_session_ids(project_dir: &Path) -> Result<Vec<String>> {
    let mut session_ids = Vec::new();

    let index_path = project_dir.join("sessions-index.json");
    if index_path.is_file() {
        let raw = fs::read_to_string(index_path)?;
        let index: ClaudeSessionsIndex = serde_json::from_str(&raw)?;
        for entry in index.entries {
            let Some(session_id) = trim_to_option(entry.session_id) else {
                continue;
            };
            if !session_ids.iter().any(|existing| existing == &session_id) {
                session_ids.push(session_id);
            }
        }
    }

    for entry in fs::read_dir(project_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
        {
            continue;
        }
        let Some(session_id) = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        if !session_ids.iter().any(|existing| existing == &session_id) {
            session_ids.push(session_id);
        }
    }

    Ok(session_ids)
}

fn session_jsonl_fork_parent_session_id(
    session_path: &Path,
) -> Result<Option<(String, String, Option<i64>)>> {
    let fallback_session_id = session_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_default();

    let file = File::open(session_path)?;
    let reader = StdBufReader::new(file);
    let mut observed_session_id = fallback_session_id;
    let mut fork_parent_session_id = None;
    let mut earliest_timestamp_ms = None;
    let mut parsed_entry_count: usize = 0;

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(parsed) = serde_json::from_str::<ClaudeJsonlEntry>(trimmed) else {
            continue;
        };
        parsed_entry_count += 1;
        if let Some(timestamp) = parsed.timestamp {
            let timestamp_ms = timestamp.timestamp_millis();
            earliest_timestamp_ms = Some(
                earliest_timestamp_ms
                    .map(|current: i64| current.min(timestamp_ms))
                    .unwrap_or(timestamp_ms),
            );
        }
        if let Some(session_id) = trim_to_option(parsed.session_id) {
            observed_session_id = session_id;
        }
        if fork_parent_session_id.is_none() {
            fork_parent_session_id = parsed
                .forked_from
                .and_then(|forked_from| trim_to_option(forked_from.session_id));
        }
        if !observed_session_id.is_empty() && fork_parent_session_id.is_some() {
            break;
        }
        // The forkedFrom field only appears in the first JSONL entry.  If we
        // have parsed a few entries without finding it, stop early to avoid
        // reading multi-megabyte files for non-forked sessions.
        if parsed_entry_count >= 5 && fork_parent_session_id.is_none() {
            break;
        }
    }

    if observed_session_id.is_empty() {
        return Ok(None);
    }

    Ok(fork_parent_session_id.map(|parent_session_id| {
        (
            observed_session_id,
            parent_session_id,
            earliest_timestamp_ms,
        )
    }))
}

fn session_path_modified_at_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(DateTime::<Utc>::from)
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or(0)
}

fn session_jsonl_clone_fingerprint(session_path: &Path) -> Result<Option<Vec<String>>> {
    let file = File::open(session_path)?;
    let reader = StdBufReader::new(file);
    let mut fingerprint = Vec::new();
    let mut candidate_entry_count = 0usize;

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(parsed) = serde_json::from_str::<ClaudeJsonlEntry>(trimmed) else {
            continue;
        };

        // Skip entries that never carry UUIDs (e.g. file-history-snapshot
        // records that --fork-session prepends). Only count entries that
        // could contribute to the fingerprint toward the scan limit.
        let is_snapshot = parsed.r#type.as_deref() == Some("file-history-snapshot");
        if is_snapshot {
            continue;
        }
        candidate_entry_count += 1;

        if let Some(entry_uuid) = trim_to_option(parsed.uuid) {
            fingerprint.push(entry_uuid);
            if fingerprint.len() >= FORK_CLONE_FINGERPRINT_UUID_LIMIT {
                break;
            }
        }

        if candidate_entry_count >= FORK_CLONE_FINGERPRINT_SCAN_LIMIT {
            break;
        }
    }

    if fingerprint.is_empty() {
        return Ok(None);
    }

    Ok(Some(fingerprint))
}

fn remember_fork_child_candidate(
    candidates_by_session_id: &mut HashMap<String, ForkChildCandidate>,
    candidate: ForkChildCandidate,
) {
    match candidates_by_session_id.get(&candidate.session_id) {
        Some(existing) if existing.created_at_ms <= candidate.created_at_ms => {}
        _ => {
            candidates_by_session_id.insert(candidate.session_id.clone(), candidate);
        }
    }
}

fn collect_fork_child_candidates_from_dir(
    project_dir: &Path,
    source_claude_session_id: &str,
    excluded_child_session_ids: &HashSet<String>,
    candidates_by_session_id: &mut HashMap<String, ForkChildCandidate>,
) -> Result<()> {
    for session_id in list_project_session_ids(project_dir)? {
        if session_id == source_claude_session_id
            || excluded_child_session_ids.contains(&session_id)
        {
            continue;
        }

        let session_path = project_dir.join(format!("{session_id}.jsonl"));
        if !session_path.is_file() {
            continue;
        }

        let Some((resolved_session_id, parent_session_id, session_created_at_ms)) =
            session_jsonl_fork_parent_session_id(&session_path)?
        else {
            continue;
        };
        if parent_session_id != source_claude_session_id
            || resolved_session_id == source_claude_session_id
            || excluded_child_session_ids.contains(&resolved_session_id)
        {
            continue;
        }

        let candidate = ForkChildCandidate {
            session_id: resolved_session_id.clone(),
            created_at_ms: session_created_at_ms
                .unwrap_or_else(|| session_path_modified_at_ms(&session_path)),
        };
        remember_fork_child_candidate(candidates_by_session_id, candidate);
    }
    Ok(())
}

fn collect_fork_child_candidates(
    source_claude_session_id: &str,
    excluded_child_session_ids: &HashSet<String>,
) -> Result<Vec<ForkChildCandidate>> {
    let projects_root = claude_projects_root()?;
    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut candidates_by_session_id: HashMap<String, ForkChildCandidate> = HashMap::new();

    // Optimisation: the forked child session is almost always created in
    // the same project directory as the source.  Locate that directory
    // first and scan only it.  Fall back to a full scan only if the
    // source directory cannot be found or yields no candidates.
    if let Some(source_project_dir) =
        find_any_claude_session_project_dir(&projects_root, source_claude_session_id)?
    {
        collect_fork_child_candidates_from_dir(
            &source_project_dir,
            source_claude_session_id,
            excluded_child_session_ids,
            &mut candidates_by_session_id,
        )?;
        if !candidates_by_session_id.is_empty() {
            return Ok(candidates_by_session_id.into_values().collect());
        }
    }

    // Full fallback: scan every project directory.
    for entry in fs::read_dir(projects_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        collect_fork_child_candidates_from_dir(
            &entry.path(),
            source_claude_session_id,
            excluded_child_session_ids,
            &mut candidates_by_session_id,
        )?;
    }

    Ok(candidates_by_session_id.into_values().collect())
}

fn collect_fork_clone_candidates_from_dir(
    project_dir: &Path,
    source_claude_session_id: &str,
    source_fingerprint: &[String],
    excluded_child_session_ids: &HashSet<String>,
    requested_after_ms: i64,
    candidates_by_session_id: &mut HashMap<String, ForkChildCandidate>,
) -> Result<()> {
    for entry in fs::read_dir(project_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
        {
            continue;
        }

        let Some(session_id) = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        if session_id == source_claude_session_id
            || excluded_child_session_ids.contains(&session_id)
        {
            continue;
        }

        let modified_at_ms = session_path_modified_at_ms(&path);
        if modified_at_ms < requested_after_ms {
            continue;
        }

        let Some(candidate_fingerprint) = session_jsonl_clone_fingerprint(&path)? else {
            continue;
        };
        if candidate_fingerprint != source_fingerprint {
            continue;
        }

        remember_fork_child_candidate(
            candidates_by_session_id,
            ForkChildCandidate {
                session_id,
                created_at_ms: modified_at_ms,
            },
        );
    }

    Ok(())
}

fn collect_fork_clone_candidates(
    source_claude_session_id: &str,
    excluded_child_session_ids: &HashSet<String>,
    requested_after_ms: i64,
) -> Result<Vec<ForkChildCandidate>> {
    let projects_root = claude_projects_root()?;
    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }

    let Some(source_project_dir) =
        find_any_claude_session_project_dir(&projects_root, source_claude_session_id)?
    else {
        return Ok(Vec::new());
    };
    let source_session_path = source_project_dir.join(format!("{source_claude_session_id}.jsonl"));
    if !source_session_path.is_file() {
        return Ok(Vec::new());
    }
    let Some(source_fingerprint) = session_jsonl_clone_fingerprint(&source_session_path)? else {
        return Ok(Vec::new());
    };

    let mut candidates_by_session_id: HashMap<String, ForkChildCandidate> = HashMap::new();

    collect_fork_clone_candidates_from_dir(
        &source_project_dir,
        source_claude_session_id,
        &source_fingerprint,
        excluded_child_session_ids,
        requested_after_ms,
        &mut candidates_by_session_id,
    )?;
    if !candidates_by_session_id.is_empty() {
        return Ok(candidates_by_session_id.into_values().collect());
    }

    for entry in fs::read_dir(projects_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        collect_fork_clone_candidates_from_dir(
            &entry.path(),
            source_claude_session_id,
            &source_fingerprint,
            excluded_child_session_ids,
            requested_after_ms,
            &mut candidates_by_session_id,
        )?;
    }

    Ok(candidates_by_session_id.into_values().collect())
}

pub fn known_fork_child_session_ids(source_claude_session_id: &str) -> Result<Vec<String>> {
    let normalized = source_claude_session_id.trim();
    if !is_uuid_like(normalized) {
        return Ok(Vec::new());
    }

    let mut session_ids = collect_fork_child_candidates(normalized, &HashSet::new())?
        .into_iter()
        .map(|candidate| candidate.session_id)
        .collect::<Vec<_>>();
    session_ids.sort();
    Ok(session_ids)
}

pub fn resolve_thread_fork_candidate(
    source_claude_session_id: String,
    known_child_session_ids: Vec<String>,
    requested_after: Option<String>,
) -> Result<Option<String>> {
    let normalized_source_claude_session_id = source_claude_session_id.trim();
    if !is_uuid_like(normalized_source_claude_session_id) {
        return Ok(None);
    }

    let excluded_child_session_ids = known_child_session_ids
        .into_iter()
        .map(|session_id| session_id.trim().to_string())
        .filter(|session_id| is_uuid_like(session_id))
        .collect::<HashSet<_>>();
    let requested_after_ms = requested_after
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc).timestamp_millis());
    let mut candidates = collect_fork_child_candidates(
        normalized_source_claude_session_id,
        &excluded_child_session_ids,
    )?;
    if let Some(requested_after_ms) = requested_after_ms {
        candidates.retain(|candidate| candidate.created_at_ms >= requested_after_ms);
        if candidates.is_empty() {
            candidates = collect_fork_clone_candidates(
                normalized_source_claude_session_id,
                &excluded_child_session_ids,
                requested_after_ms,
            )?;
        }
    }
    candidates.sort_by(|left, right| {
        left.created_at_ms
            .cmp(&right.created_at_ms)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(candidates
        .into_iter()
        .next()
        .map(|candidate| candidate.session_id))
}

fn shell_escape_arg(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn resolve_login_shell() -> String {
    env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

fn build_claude_shell_command(
    cli_path: &str,
    session_id: &str,
    session_mode: TerminalSessionMode,
    full_access_flag: bool,
    use_session_id_for_resume: bool,
) -> String {
    let mut parts = vec![
        "env".to_string(),
        "TERM=xterm-256color".to_string(),
        "COLORTERM=truecolor".to_string(),
        "CLICOLOR=1".to_string(),
        "CLICOLOR_FORCE=1".to_string(),
        "FORCE_COLOR=1".to_string(),
        shell_escape_arg(cli_path),
    ];
    match session_mode {
        TerminalSessionMode::Resumed => {
            parts.push(
                if use_session_id_for_resume {
                    "--session-id"
                } else {
                    "--resume"
                }
                .to_string(),
            );
            parts.push(shell_escape_arg(session_id));
        }
        TerminalSessionMode::New => {
            parts.push("--session-id".to_string());
            parts.push(shell_escape_arg(session_id));
        }
        TerminalSessionMode::Forked => {
            parts.push("--resume".to_string());
            parts.push(shell_escape_arg(session_id));
            parts.push("--fork-session".to_string());
        }
    }
    if full_access_flag {
        parts.push("--dangerously-skip-permissions".to_string());
    }
    parts.join(" ")
}

fn build_terminal_shell_command(
    workspace_kind: WorkspaceKind,
    rdev_ssh_command: Option<&str>,
    ssh_command: Option<&str>,
    remote_path: Option<&str>,
    claude_shell_command: &str,
) -> Result<(String, Option<String>)> {
    if workspace_kind == WorkspaceKind::Local {
        return Ok((claude_shell_command.to_string(), None));
    }

    let remote_command = match workspace_kind {
        WorkspaceKind::Rdev => {
            let command = rdev_ssh_command
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Missing rdev ssh command for remote workspace"))?;
            ensure_rdev_non_tmux(command)
        }
        WorkspaceKind::Ssh => ssh_command
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("Missing ssh command for remote workspace"))?
            .to_string(),
        WorkspaceKind::Local => unreachable!(),
    };
    let base_exec_claude_command = format!("exec {claude_shell_command}");

    if remote_command.contains("{CLAUDE_CMD}") {
        return Ok((
            remote_command.replace("{CLAUDE_CMD}", &base_exec_claude_command),
            None,
        ));
    }

    let exec_claude_command = if workspace_kind == WorkspaceKind::Ssh {
        if let Some(path) = remote_path.map(str::trim).filter(|value| !value.is_empty()) {
            format!(
                "cd {} && exec {}",
                shell_escape_arg(path),
                claude_shell_command
            )
        } else {
            base_exec_claude_command
        }
    } else {
        base_exec_claude_command
    };

    Ok((remote_command, Some(exec_claude_command)))
}

fn build_workspace_shell_command(
    workspace_kind: WorkspaceKind,
    shell_path: &str,
    rdev_ssh_command: Option<&str>,
    ssh_command: Option<&str>,
    remote_path: Option<&str>,
) -> Result<(Option<String>, Option<String>)> {
    match workspace_kind {
        WorkspaceKind::Local => Ok((None, None)),
        WorkspaceKind::Rdev => {
            let remote_command = rdev_ssh_command
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Missing rdev ssh command for remote workspace"))?;
            Ok((Some(ensure_rdev_non_tmux(remote_command)), None))
        }
        WorkspaceKind::Ssh => {
            let remote_command = ssh_command
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Missing ssh command for remote workspace"))?
                .to_string();
            let post_connect_command = remote_path
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| {
                    format!(
                        "cd {} && exec {}",
                        shell_escape_arg(value),
                        shell_escape_arg(shell_path)
                    )
                });
            Ok((Some(remote_command), post_connect_command))
        }
    }
}

fn resolve_claude_command_for_workspace(
    workspace_kind: WorkspaceKind,
    settings: &Settings,
) -> Result<String> {
    if workspace_kind == WorkspaceKind::Rdev || workspace_kind == WorkspaceKind::Ssh {
        return Ok("claude".to_string());
    }

    detect_claude_cli_path(settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))
}

fn ensure_rdev_non_tmux(remote_command: &str) -> String {
    let trimmed = remote_command.trim();
    let has_explicit_tmux_mode = trimmed
        .split_whitespace()
        .any(|token| matches!(token, "--tmux" | "--non-tmux" | "-d"));
    if has_explicit_tmux_mode {
        trimmed.to_string()
    } else if trimmed.contains("{CLAUDE_CMD}") {
        trimmed.replacen("{CLAUDE_CMD}", "--non-tmux {CLAUDE_CMD}", 1)
    } else {
        format!("{trimmed} --non-tmux")
    }
}

fn trim_prompt_probe_buffer(buffer: &mut String) {
    if buffer.len() <= POST_CONNECT_PROMPT_BUFFER_MAX {
        return;
    }
    let drain_len = buffer.len() - (POST_CONNECT_PROMPT_BUFFER_MAX / 2);
    buffer.drain(..drain_len);
}

fn looks_like_shell_prompt(buffer: &str) -> bool {
    for line in buffer.replace('\r', "\n").lines().rev().take(8) {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("for shortcuts")
            || lower.contains("bypass permissions")
            || lower.contains("claude code")
            || lower.contains("starting ssh connection")
            || lower.contains("uploading gh auth token")
            || lower.contains("now ready to use")
        {
            continue;
        }

        if trimmed.ends_with('$')
            || trimmed.ends_with('#')
            || trimmed.ends_with('%')
            || trimmed.ends_with('>')
            || trimmed.ends_with('❯')
            || trimmed.ends_with('❱')
            || trimmed.ends_with('➜')
        {
            return true;
        }
    }
    false
}

fn should_dispatch_post_connect_command(
    prompt_probe: &str,
    saw_ssh_connection_start: bool,
    elapsed_since_connect_start: Duration,
) -> bool {
    looks_like_shell_prompt(prompt_probe)
        || (saw_ssh_connection_start
            && elapsed_since_connect_start >= POST_CONNECT_COMMAND_AFTER_SSH_START_TIMEOUT)
}

fn trim_launch_output_parse_buffer(buffer: &mut String) {
    if buffer.len() <= LAUNCH_OUTPUT_PARSE_BUFFER_MAX {
        return;
    }
    let drain_len = buffer.len() - (LAUNCH_OUTPUT_PARSE_BUFFER_MAX / 2);
    buffer.drain(..drain_len);
}

fn normalize_launch_probe_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn looks_like_launch_command_echo_line(line: &str, launch_command: &str) -> bool {
    let normalized_line = normalize_launch_probe_text(line);
    if normalized_line.is_empty() {
        return false;
    }

    let normalized_command = normalize_launch_probe_text(launch_command);
    if normalized_command.is_empty() {
        return false;
    }

    if normalized_command.contains(&normalized_line)
        || normalized_line.contains(&normalized_command)
    {
        return true;
    }

    for marker in [" exec ", " env ", " claude ", "claude "] {
        if let Some(index) = normalized_line.find(marker.trim_start()) {
            let tail = normalized_line[index..].trim();
            if !tail.is_empty()
                && (normalized_command.contains(tail) || tail.contains(&normalized_command))
            {
                return true;
            }
        }
    }

    false
}

fn chunk_mentions_launch_command(
    probe_buffer: &mut String,
    chunk: &str,
    launch_command: &str,
) -> bool {
    let clean = strip_ansi_sequences(chunk);
    if clean.is_empty() {
        return false;
    }

    probe_buffer.push_str(&clean);
    trim_launch_output_parse_buffer(probe_buffer);
    let normalized_probe = normalize_launch_probe_text(probe_buffer);
    let normalized_command = normalize_launch_probe_text(launch_command);
    !normalized_probe.is_empty()
        && !normalized_command.is_empty()
        && (normalized_probe.contains(&normalized_command)
            || normalized_command.contains(&normalized_probe))
}

fn chunk_has_non_echo_launch_output(
    output_probe: &mut String,
    chunk: &str,
    launch_command: &str,
) -> bool {
    let clean = strip_ansi_sequences(chunk);
    if clean.trim().is_empty() {
        return false;
    }

    output_probe.push_str(&clean.replace('\r', "\n"));
    trim_launch_output_parse_buffer(output_probe);

    output_probe
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .any(|line| !looks_like_launch_command_echo_line(line, launch_command))
}

fn is_uuid_like(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    for (index, ch) in value.chars().enumerate() {
        let hyphen_index = matches!(index, 8 | 13 | 18 | 23);
        if hyphen_index {
            if ch != '-' {
                return false;
            }
            continue;
        }

        if !ch.is_ascii_hexdigit() {
            return false;
        }
    }

    true
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            output.push(ch);
            continue;
        }

        let Some(next) = chars.peek().copied() else {
            break;
        };

        if next == '[' {
            let _ = chars.next();
            for ctrl in chars.by_ref() {
                if ('@'..='~').contains(&ctrl) {
                    break;
                }
            }
        } else if next == ']' {
            // OSC: ESC ] ... BEL or ESC ] ... ESC \
            let _ = chars.next();
            let mut saw_escape = false;
            while let Some(ctrl) = chars.next() {
                if ctrl == '\u{7}' {
                    break;
                }
                if saw_escape && ctrl == '\\' {
                    break;
                }
                saw_escape = ctrl == '\u{1b}';
            }
        } else if matches!(next, 'P' | '_' | '^') {
            // DCS/APC/PM: ESC P ... ESC \ (and variants).
            let _ = chars.next();
            let mut saw_escape = false;
            while let Some(ctrl) = chars.next() {
                if saw_escape && ctrl == '\\' {
                    break;
                }
                saw_escape = ctrl == '\u{1b}';
            }
        } else {
            let _ = chars.next();
        }
    }

    output
}

fn extract_claude_resume_session_id(text: &str) -> Option<String> {
    for marker in ["claude --resume ", "--resume "] {
        let mut offset = 0usize;
        while let Some(index) = text[offset..].find(marker) {
            let start = offset + index + marker.len();
            let candidate: String = text[start..]
                .chars()
                .take_while(|ch| ch.is_ascii_hexdigit() || *ch == '-')
                .collect();
            if is_uuid_like(&candidate) {
                return Some(candidate.to_lowercase());
            }
            offset = start;
        }
    }

    None
}

fn recover_session_id_from_logs(workspace_id: &str, thread_id: &str) -> Option<String> {
    let snapshot = terminal_get_last_log(workspace_id, thread_id).ok()?;
    if snapshot.text.trim().is_empty() {
        return None;
    }
    extract_claude_resume_session_id(&strip_ansi_sequences(&snapshot.text))
}

fn emit_terminal_ready(app: &AppHandle, thread_id: &str, session_id: &str) {
    let _ = app.emit(
        TERMINAL_READY_EVENT,
        TerminalReadyEvent {
            session_id: session_id.to_string(),
            thread_id: Some(thread_id.to_string()),
        },
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshStartupBlockReason {
    HostVerificationRequired,
    PasswordAuthUnsupported,
    InteractiveAuthUnsupported,
}

impl SshStartupBlockReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::HostVerificationRequired => "host-verification-required",
            Self::PasswordAuthUnsupported => "password-auth-unsupported",
            Self::InteractiveAuthUnsupported => "interactive-auth-unsupported",
        }
    }
}

fn detect_ssh_startup_block_reason(prompt_probe: &str) -> Option<SshStartupBlockReason> {
    for line in prompt_probe.replace('\r', "\n").lines().rev().take(12) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("are you sure you want to continue connecting")
            || lower.contains("continue connecting (yes/no")
            || lower.contains("host key verification failed")
        {
            return Some(SshStartupBlockReason::HostVerificationRequired);
        }

        if lower.ends_with("password:")
            || lower.contains("'s password:")
            || lower.starts_with("password:")
        {
            return Some(SshStartupBlockReason::PasswordAuthUnsupported);
        }

        if lower.contains("enter passphrase for key")
            || lower.ends_with("passphrase:")
            || lower.starts_with("passphrase:")
            || (lower.contains("verification code") && lower.ends_with(':'))
            || (lower.contains("one-time password") && lower.ends_with(':'))
            || (lower.contains("passcode or option") && lower.ends_with(':'))
            || (lower.contains("passcode or select one of the following options")
                && lower.ends_with(':'))
            || lower.starts_with("passcode:")
            || lower.ends_with("passcode:")
        {
            return Some(SshStartupBlockReason::InteractiveAuthUnsupported);
        }
    }

    None
}

fn should_probe_ssh_startup_auth(
    workspace_kind: WorkspaceKind,
    ssh_startup_detection_active: bool,
    ssh_startup_block_reason: Option<SshStartupBlockReason>,
    ready_emitted: bool,
    clean_chunk: &str,
) -> bool {
    // Intentionally independent of launch-command dispatch state so inline SSH
    // commands such as `ssh host {CLAUDE_CMD}` still inspect startup auth prompts.
    workspace_kind == WorkspaceKind::Ssh
        && ssh_startup_detection_active
        && ssh_startup_block_reason.is_none()
        && !ready_emitted
        && !clean_chunk.is_empty()
}

fn emit_terminal_ssh_auth_status(
    app: &AppHandle,
    session_id: &str,
    workspace_id: &str,
    thread_id: Option<&str>,
    reason: SshStartupBlockReason,
) {
    let _ = app.emit(
        TERMINAL_SSH_AUTH_STATUS_EVENT,
        TerminalSshAuthStatusEvent {
            session_id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.map(str::to_string),
            reason: reason.as_str().to_string(),
        },
    );
}

fn assistant_content_has_type(content: Option<&Value>, expected_type: &str) -> bool {
    match content {
        Some(Value::Array(items)) => items.iter().any(|item| {
            item.as_object()
                .and_then(|record| record.get("type"))
                .and_then(Value::as_str)
                == Some(expected_type)
        }),
        _ => false,
    }
}

fn assistant_content_text(content: Option<&Value>) -> Option<String> {
    let Some(Value::Array(items)) = content else {
        return None;
    };

    let text = items
        .iter()
        .filter_map(|item| {
            let record = item.as_object()?;
            if record.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            record.get("text").and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaudeTurnCompletion {
    status: &'static str,
    has_meaningful_output: bool,
    completed_at_ms: i64,
}

fn is_qualifying_claude_turn_completion(completion: &ClaudeTurnCompletion) -> bool {
    completion.has_meaningful_output || completion.status == "Failed"
}

fn classify_claude_turn_completion_entry(entry: &ClaudeJsonlEntry) -> Option<ClaudeTurnCompletion> {
    if entry.r#type.as_deref() != Some("assistant") {
        return None;
    }
    let Some(message) = entry.message.as_ref() else {
        return None;
    };
    if message.role.as_deref() != Some("assistant") {
        return None;
    }
    if !assistant_content_has_type(message.content.as_ref(), "text") {
        return None;
    }
    if assistant_content_has_type(message.content.as_ref(), "tool_use") {
        return None;
    }

    let completed_at_ms = entry
        .timestamp
        .as_ref()
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    let text = assistant_content_text(message.content.as_ref()).unwrap_or_default();

    match message.stop_reason.as_deref() {
        Some("end_turn") => Some(ClaudeTurnCompletion {
            status: "Succeeded",
            has_meaningful_output: true,
            completed_at_ms,
        }),
        Some("stop_sequence") => {
            if text == "No response requested." {
                Some(ClaudeTurnCompletion {
                    status: "Succeeded",
                    has_meaningful_output: false,
                    completed_at_ms,
                })
            } else if text.starts_with("API Error:") || text.starts_with("Prompt is too long") {
                Some(ClaudeTurnCompletion {
                    status: "Failed",
                    has_meaningful_output: true,
                    completed_at_ms,
                })
            } else {
                Some(ClaudeTurnCompletion {
                    status: "Succeeded",
                    has_meaningful_output: true,
                    completed_at_ms,
                })
            }
        }
        _ => None,
    }
}

fn claude_session_jsonl_path(workspace_path: &str, claude_session_id: &str) -> Result<PathBuf> {
    let projects_root = claude_projects_root()?;
    let default_path = projects_root
        .join(claude_project_dir_for_workspace(workspace_path))
        .join(format!("{claude_session_id}.jsonl"));
    if default_path.is_file() {
        return Ok(default_path);
    }

    if let Some(project_dir) =
        find_any_claude_session_project_dir(&projects_root, claude_session_id)?
    {
        return Ok(project_dir.join(format!("{claude_session_id}.jsonl")));
    }

    Ok(default_path)
}

fn latest_qualifying_claude_turn_completion(
    session_path: &Path,
    claude_session_id: &str,
) -> Option<ClaudeTurnCompletionSummary> {
    let file = File::open(session_path).ok()?;
    let mut reader = StdBufReader::new(file);
    let mut latest_completion = None;
    let mut qualifying_completion_count = 0_u64;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).ok()?;
        if bytes_read == 0 {
            break;
        }
        if !line.ends_with('\n') {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<ClaudeJsonlEntry>(trimmed) else {
            continue;
        };
        let Some(completion) = classify_claude_turn_completion_entry(&entry) else {
            continue;
        };
        if !is_qualifying_claude_turn_completion(&completion) {
            continue;
        }
        qualifying_completion_count = qualifying_completion_count.saturating_add(1);
        latest_completion = Some(ClaudeTurnCompletionSummary {
            claude_session_id: claude_session_id.to_string(),
            completion_index: qualifying_completion_count,
            completed_at_ms: completion.completed_at_ms,
            status: completion.status.to_string(),
            has_meaningful_output: completion.has_meaningful_output,
        });
    }

    latest_completion
}

fn existing_claude_session_project_dir(
    workspace_path: &str,
    claude_session_id: &str,
) -> Result<Option<PathBuf>> {
    let projects_root = claude_projects_root()?;
    let default_project_dir = projects_root.join(claude_project_dir_for_workspace(workspace_path));
    if project_dir_contains_claude_session(&default_project_dir, claude_session_id)? {
        return Ok(Some(default_project_dir));
    }

    find_any_claude_session_project_dir(&projects_root, claude_session_id)
}

fn resumed_session_requires_session_id_launch(
    workspace_path: &str,
    launch_cwd: &str,
    claude_session_id: &str,
) -> Result<bool> {
    let Some(existing_project_dir) =
        existing_claude_session_project_dir(workspace_path, claude_session_id)?
    else {
        return Ok(false);
    };

    let projects_root = claude_projects_root()?;
    let launch_project_dir = projects_root.join(claude_project_dir_for_workspace(launch_cwd));
    Ok(existing_project_dir != launch_project_dir)
}

fn latest_claude_session_cwd_from_jsonl(session_path: &Path) -> Option<String> {
    let file = File::open(session_path).ok()?;
    let mut reader = StdBufReader::new(file);
    let mut latest_cwd = None;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).ok()?;
        if bytes_read == 0 {
            break;
        }
        if !line.ends_with('\n') {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(entry) = serde_json::from_str::<ClaudeJsonlEntry>(trimmed) else {
            continue;
        };
        let Some(cwd) = trim_to_option(entry.cwd) else {
            continue;
        };
        latest_cwd = Some(canonicalize_path_or_original(&cwd));
    }

    latest_cwd
}

#[cfg(test)]
fn latest_claude_turn_completion_after(
    session_path: &Path,
    after_ms: i64,
) -> Option<ClaudeTurnCompletion> {
    let file = File::open(session_path).ok()?;
    let mut reader = StdBufReader::new(file);
    let mut latest_completion = None;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).ok()?;
        if bytes_read == 0 {
            break;
        }
        if !line.ends_with('\n') {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<ClaudeJsonlEntry>(trimmed) else {
            continue;
        };
        let Some(completion) = classify_claude_turn_completion_entry(&entry) else {
            continue;
        };
        if completion.completed_at_ms <= after_ms {
            continue;
        }
        latest_completion = Some(completion);
    }

    latest_completion
}

fn spawn_claude_turn_completion_watcher(
    app: AppHandle,
    session: Arc<TerminalSession>,
    thread_id: String,
    claude_session_id: String,
) {
    let session_id = session.session_id.clone();
    let mut observed_claude_session_id = claude_session_id;
    let mut session_path =
        match claude_session_jsonl_path(&session.workspace_path, &observed_claude_session_id) {
            Ok(path) => path,
            Err(_) => return,
        };
    let initial_read_offset = fs::metadata(&session_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let initial_qualifying_completion_index =
        latest_qualifying_claude_turn_completion(&session_path, &observed_claude_session_id)
            .map(|summary| summary.completion_index)
            .unwrap_or(0);

    std::thread::spawn(move || {
        let mut read_offset = initial_read_offset;
        let mut emitted_completion_count = 0_u64;
        let mut absolute_qualifying_completion_index = initial_qualifying_completion_index;
        let mut current_cwd = session
            .current_cwd
            .lock()
            .ok()
            .map(|value| value.clone())
            .filter(|value| !value.trim().is_empty());

        loop {
            if session.killed.load(Ordering::Acquire) {
                break;
            }

            let next_observed_claude_session_id = session
                .observed_claude_session_id
                .lock()
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| observed_claude_session_id.clone());
            if next_observed_claude_session_id != observed_claude_session_id {
                observed_claude_session_id = next_observed_claude_session_id;
                session_path = match claude_session_jsonl_path(
                    &session.workspace_path,
                    &observed_claude_session_id,
                ) {
                    Ok(path) => path,
                    Err(_) => {
                        std::thread::sleep(CLAUDE_TURN_COMPLETION_POLL_INTERVAL);
                        continue;
                    }
                };
                read_offset = fs::metadata(&session_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                absolute_qualifying_completion_index = latest_qualifying_claude_turn_completion(
                    &session_path,
                    &observed_claude_session_id,
                )
                .map(|summary| summary.completion_index)
                .unwrap_or(0);
                if let Ok(Some(entry_cwd)) = latest_claude_session_cwd(
                    session.workspace_path.clone(),
                    observed_claude_session_id.clone(),
                ) {
                    current_cwd = Some(entry_cwd.clone());
                    if let Ok(mut session_cwd) = session.current_cwd.lock() {
                        *session_cwd = entry_cwd;
                    }
                }
            }

            let metadata = match fs::metadata(&session_path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    std::thread::sleep(CLAUDE_TURN_COMPLETION_POLL_INTERVAL);
                    continue;
                }
            };

            if metadata.len() < read_offset {
                read_offset = 0;
                absolute_qualifying_completion_index = 0;
            }

            if metadata.len() > read_offset {
                let file = match File::open(&session_path) {
                    Ok(file) => file,
                    Err(_) => {
                        std::thread::sleep(CLAUDE_TURN_COMPLETION_POLL_INTERVAL);
                        continue;
                    }
                };
                let mut reader = StdBufReader::new(file);
                if reader.seek(SeekFrom::Start(read_offset)).is_ok() {
                    let mut line = String::new();
                    loop {
                        line.clear();
                        let bytes_read = match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(bytes_read) => bytes_read,
                            Err(_) => break,
                        };
                        if !line.ends_with('\n') {
                            break;
                        }
                        read_offset = read_offset.saturating_add(bytes_read as u64);
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let Ok(entry) = serde_json::from_str::<ClaudeJsonlEntry>(trimmed) else {
                            continue;
                        };
                        if let Some(entry_cwd) = trim_to_option(entry.cwd.clone()) {
                            current_cwd = Some(entry_cwd.clone());
                            if let Ok(mut session_cwd) = session.current_cwd.lock() {
                                *session_cwd = entry_cwd;
                            }
                        }
                        let Some(completion) = classify_claude_turn_completion_entry(&entry) else {
                            continue;
                        };

                        let submitted_prompt_count =
                            session.submitted_prompt_count.load(Ordering::Acquire);
                        if emitted_completion_count >= submitted_prompt_count {
                            continue;
                        }
                        emitted_completion_count = emitted_completion_count.saturating_add(1);
                        let completion_index = if is_qualifying_claude_turn_completion(&completion)
                        {
                            absolute_qualifying_completion_index =
                                absolute_qualifying_completion_index.saturating_add(1);
                            Some(absolute_qualifying_completion_index)
                        } else {
                            None
                        };
                        let _ = app.emit(
                            TERMINAL_TURN_COMPLETED_EVENT,
                            TerminalTurnCompletedEvent {
                                session_id: session_id.clone(),
                                thread_id: Some(thread_id.clone()),
                                status: completion.status.to_string(),
                                has_meaningful_output: completion.has_meaningful_output,
                                completed_at_ms: completion.completed_at_ms,
                                completion_index,
                                current_cwd: current_cwd.clone(),
                            },
                        );
                    }
                }
            }

            std::thread::sleep(CLAUDE_TURN_COMPLETION_POLL_INTERVAL);
        }
    });
}

fn normalize_terminal_input_chunk(chunk: &str) -> String {
    chunk.replace("\u{1b}\r", "\n")
}

fn update_prompt_submit_buffer(buffer: &mut String, chunk: &str) -> bool {
    let normalized = normalize_terminal_input_chunk(chunk);
    let mut submitted_prompt = false;

    for char in normalized.chars() {
        if char == '\n' {
            buffer.push('\n');
            continue;
        }

        if char == '\r' {
            if !submitted_prompt && !buffer.trim().is_empty() {
                submitted_prompt = true;
            }
            buffer.clear();
            continue;
        }

        if char == '\u{7f}' || char == '\u{8}' {
            buffer.pop();
            continue;
        }

        if char >= ' ' && char != '\u{7f}' {
            buffer.push(char);
        }
    }

    submitted_prompt
}

#[cfg(test)]
fn input_chunk_submits_prompt(chunk: &str) -> bool {
    let mut buffer = String::new();
    update_prompt_submit_buffer(&mut buffer, chunk)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalSessionMode {
    Resumed,
    New,
    Forked,
}

impl TerminalSessionMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Resumed => "resumed",
            Self::New => "new",
            Self::Forked => "forked",
        }
    }
}

pub type TerminalSessionId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalSessionKind {
    ClaudeThread,
    WorkspaceShell,
}

struct TerminalSession {
    session_id: TerminalSessionId,
    workspace_id: String,
    workspace_path: String,
    current_cwd: Mutex<String>,
    observed_claude_session_id: Mutex<String>,
    kind: TerminalSessionKind,
    thread_id: Option<String>,
    session_mode: Option<TerminalSessionMode>,
    resume_session_id: Option<String>,
    pending_confirmation_session_id: Mutex<Option<String>>,
    submitted_input_buffer: Mutex<String>,
    process_id: Option<u32>,
    started_at: chrono::DateTime<Utc>,
    command: Vec<String>,
    output_log_path: PathBuf,
    output_state: Arc<TerminalOutputState>,
    submitted_prompt_count: AtomicU64,
    claude_session_id_confirmed: AtomicBool,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    killed: Arc<AtomicBool>,
}

fn terminate_terminal_session_process(session: &TerminalSession) {
    session.killed.store(true, Ordering::Release);
    if let Some(pid) = session.process_id {
        let result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        if result == 0 {
            return;
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return;
        }
    }
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
}

#[derive(Default)]
pub struct TerminalSessionManager {
    sessions: Mutex<HashMap<TerminalSessionId, Arc<TerminalSession>>>,
}

impl TerminalSessionManager {
    fn insert(&self, session: Arc<TerminalSession>) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        sessions.insert(session.session_id.clone(), session);
        Ok(())
    }

    fn get(&self, session_id: &str) -> Result<Option<Arc<TerminalSession>>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        Ok(sessions.get(session_id).cloned())
    }

    fn remove(&self, session_id: &str) -> Result<Option<Arc<TerminalSession>>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        Ok(sessions.remove(session_id))
    }

    fn remove_for_thread(
        &self,
        workspace_id: &str,
        thread_id: &str,
    ) -> Result<Vec<Arc<TerminalSession>>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        let matching_session_ids = sessions
            .iter()
            .filter(|(_, session)| {
                session.workspace_id == workspace_id
                    && session.thread_id.as_deref() == Some(thread_id)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        let mut removed = Vec::new();
        for session_id in matching_session_ids {
            if let Some(session) = sessions.remove(&session_id) {
                removed.push(session);
            }
        }
        Ok(removed)
    }

    fn remove_for_workspace_shell(&self, workspace_id: &str) -> Result<Vec<Arc<TerminalSession>>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        let matching_session_ids = sessions
            .iter()
            .filter(|(_, session)| {
                session.workspace_id == workspace_id
                    && session.kind == TerminalSessionKind::WorkspaceShell
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        let mut removed = Vec::new();
        for session_id in matching_session_ids {
            if let Some(session) = sessions.remove(&session_id) {
                removed.push(session);
            }
        }
        Ok(removed)
    }

    pub fn shutdown_for_workspace_id(&self, workspace_id: &str) -> Result<()> {
        let sessions = {
            let mut guard = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
            let matching_session_ids = guard
                .iter()
                .filter(|(_, session)| session.workspace_id == workspace_id)
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            let mut removed = Vec::new();
            for session_id in matching_session_ids {
                if let Some(session) = guard.remove(&session_id) {
                    removed.push(session);
                }
            }
            removed
        };

        for session in sessions {
            terminate_terminal_session_process(&session);
        }
        Ok(())
    }

    pub fn shutdown_for_workspace_context(&self, workspace_path: &str) -> Result<()> {
        let target_context_path = resolve_terminal_workspace_context_path(workspace_path);
        let sessions = {
            let mut guard = self
                .sessions
                .lock()
                .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
            let matching_session_ids = guard
                .iter()
                .filter(|(_, session)| {
                    session
                        .current_cwd
                        .lock()
                        .ok()
                        .map(|cwd| cwd.clone())
                        .filter(|cwd| !cwd.trim().is_empty())
                        .map(|cwd| {
                            resolve_terminal_workspace_context_path(&cwd) == target_context_path
                        })
                        .unwrap_or_else(|| {
                            resolve_terminal_workspace_context_path(&session.workspace_path)
                                == target_context_path
                        })
                })
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>();
            let mut removed = Vec::new();
            for session_id in matching_session_ids {
                if let Some(session) = guard.remove(&session_id) {
                    removed.push(session);
                }
            }
            removed
        };

        for session in sessions {
            terminate_terminal_session_process(&session);
        }
        Ok(())
    }

    pub fn shutdown_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut guard) => guard
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            terminate_terminal_session_process(&session);
        }
    }
}

#[derive(Default)]
pub struct RunnerState {
    pub processes: AsyncMutex<HashMap<String, Arc<AsyncMutex<Child>>>>,
    pub terminal_sessions: TerminalSessionManager,
}

pub fn detect_claude_cli_path(settings: &Settings) -> Option<String> {
    if let Some(path) = &settings.claude_cli_path {
        if Path::new(path).exists() {
            return Some(path.clone());
        }
    }

    let mut candidates = vec![
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    if let Some(home) = dirs::home_dir().map(|dir| dir.to_string_lossy().to_string()) {
        candidates.push(format!("{home}/.volta/bin/claude"));
        candidates.push(format!("{home}/.npm-global/bin/claude"));
        candidates.push(format!("{home}/.local/bin/claude"));
    }

    for path in candidates {
        if Path::new(&path).exists() {
            return Some(path);
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && Path::new(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

fn decode_utf8_chunk(buffer: &[u8], carry: &mut Vec<u8>) -> Option<String> {
    carry.extend_from_slice(buffer);
    if carry.is_empty() {
        return None;
    }

    let mut output = String::new();

    loop {
        match std::str::from_utf8(carry) {
            Ok(text) => {
                output.push_str(text);
                carry.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    if let Ok(text) = std::str::from_utf8(&carry[..valid]) {
                        output.push_str(text);
                    }
                }

                match error.error_len() {
                    Some(error_len) => {
                        // Replace invalid UTF-8 runes while preserving stream continuity.
                        output.push('\u{fffd}');
                        let drain = valid.saturating_add(error_len);
                        carry.drain(..drain);
                        if carry.is_empty() {
                            break;
                        }
                    }
                    None => {
                        // Incomplete UTF-8 sequence at chunk boundary: keep bytes for next read.
                        carry.drain(..valid);
                        break;
                    }
                }
            }
        }
    }

    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}

fn terminal_position_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

fn utf16_boundary_after_units(text: &str, min_units: u64) -> (usize, u64) {
    if min_units == 0 {
        return (0, 0);
    }

    let mut consumed_units = 0_u64;
    for (index, ch) in text.char_indices() {
        consumed_units = consumed_units.saturating_add(ch.len_utf16() as u64);
        if consumed_units >= min_units {
            return (index + ch.len_utf8(), consumed_units);
        }
    }

    (text.len(), consumed_units)
}

#[derive(Debug, Clone)]
struct TerminalOutputBuffer {
    text: String,
    start_position: u64,
    end_position: u64,
    text_len: u64,
}

impl TerminalOutputBuffer {
    fn new() -> Self {
        Self {
            text: String::new(),
            start_position: 0,
            end_position: 0,
            text_len: 0,
        }
    }

    fn snapshot(&self) -> TerminalOutputSnapshot {
        TerminalOutputSnapshot {
            text: self.text.clone(),
            start_position: self.start_position,
            end_position: self.end_position,
            truncated: self.start_position > 0,
        }
    }

    fn append(&mut self, chunk: &str) -> (u64, u64) {
        let start_position = self.end_position;
        let delta = terminal_position_len(chunk);
        self.text.push_str(chunk);
        self.end_position = self.end_position.saturating_add(delta);
        self.text_len = self.text_len.saturating_add(delta);

        if self.text_len > TERMINAL_STREAM_TAIL_MAX_CHARS + TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS {
            let min_units_to_trim = self.text_len
                - (TERMINAL_STREAM_TAIL_MAX_CHARS - TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS);
            let (trim_end, trimmed_units) =
                utf16_boundary_after_units(&self.text, min_units_to_trim);
            if trim_end > 0 {
                self.text.drain(..trim_end);
                self.start_position = self.start_position.saturating_add(trimmed_units);
                self.text_len = self.text_len.saturating_sub(trimmed_units);
            }
        }

        (start_position, self.end_position)
    }
}

#[derive(Debug)]
struct TerminalOutputState {
    buffer: Mutex<TerminalOutputBuffer>,
    reader_done: Mutex<bool>,
    reader_done_cv: Condvar,
}

impl TerminalOutputState {
    fn new() -> Self {
        Self {
            buffer: Mutex::new(TerminalOutputBuffer::new()),
            reader_done: Mutex::new(false),
            reader_done_cv: Condvar::new(),
        }
    }

    fn append(&self, chunk: &str) -> Result<(u64, u64)> {
        let mut buffer = self
            .buffer
            .lock()
            .map_err(|_| anyhow!("Terminal output buffer lock poisoned"))?;
        Ok(buffer.append(chunk))
    }

    fn snapshot(&self) -> Result<TerminalOutputSnapshot> {
        let buffer = self
            .buffer
            .lock()
            .map_err(|_| anyhow!("Terminal output buffer lock poisoned"))?;
        Ok(buffer.snapshot())
    }

    fn end_position(&self) -> Result<u64> {
        let buffer = self
            .buffer
            .lock()
            .map_err(|_| anyhow!("Terminal output buffer lock poisoned"))?;
        Ok(buffer.end_position)
    }

    fn mark_reader_done(&self) -> Result<()> {
        let mut done = self
            .reader_done
            .lock()
            .map_err(|_| anyhow!("Terminal reader state lock poisoned"))?;
        *done = true;
        self.reader_done_cv.notify_all();
        Ok(())
    }

    fn wait_until_reader_done(&self) -> Result<()> {
        let mut done = self
            .reader_done
            .lock()
            .map_err(|_| anyhow!("Terminal reader state lock poisoned"))?;
        while !*done {
            done = self
                .reader_done_cv
                .wait(done)
                .map_err(|_| anyhow!("Terminal reader state lock poisoned"))?;
        }
        Ok(())
    }
}

fn read_log_snapshot(path: &Path) -> Result<(String, bool)> {
    let mut file = File::open(path)?;
    let total_len = file.metadata()?.len();
    let start_offset = total_len.saturating_sub(TERMINAL_LOG_SNAPSHOT_MAX_BYTES);
    if start_offset > 0 {
        file.seek(SeekFrom::Start(start_offset))?;
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).to_string();

    if start_offset > 0 {
        if let Some(newline_index) = text.find('\n') {
            text = text[(newline_index + 1)..].to_string();
        }
        return Ok((text, true));
    }

    Ok((text, false))
}

pub fn build_context_preview(workspace_path: &str, context_pack: &str) -> Result<ContextPreview> {
    match context_pack.to_lowercase().as_str() {
        "git diff" | "gitdiff" | "git_diff" => build_git_diff_context(workspace_path),
        "debug" => build_debug_context(workspace_path),
        _ => Ok(ContextPreview {
            files: vec![],
            total_size: 0,
            context_text: String::new(),
        }),
    }
}

fn build_git_diff_context(workspace_path: &str) -> Result<ContextPreview> {
    let summary = git_tools::get_git_diff_summary(workspace_path)?;
    let stat = summary.stat;
    let diff = summary.diff_excerpt;

    let files = vec![
        ContextFilePreview {
            path: "git.diff.stat".to_string(),
            size: stat.len(),
        },
        ContextFilePreview {
            path: "git.diff.patch".to_string(),
            size: diff.len(),
        },
    ];
    let total_size = stat.len() + diff.len();
    let context_text = format!(
        "## Git Diff Summary\n{}\n\n## Git Diff\n{}",
        if stat.is_empty() {
            "(No changes)"
        } else {
            &stat
        },
        if diff.is_empty() {
            "(No diff output)"
        } else {
            &diff
        }
    );

    Ok(ContextPreview {
        files,
        total_size,
        context_text,
    })
}

fn build_debug_context(workspace_path: &str) -> Result<ContextPreview> {
    let mut files = Vec::new();
    let mut context_parts = Vec::new();
    let mut total_size = 0usize;

    let logs_dir = Path::new(workspace_path).join("logs");
    if logs_dir.exists() {
        for entry in fs::read_dir(logs_dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if !looks_like_log(&path) {
                continue;
            }

            let content = fs::read_to_string(&path).unwrap_or_default();
            let max = 8_000;
            let trimmed = if content.len() > max {
                content
                    .chars()
                    .rev()
                    .take(max)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect()
            } else {
                content
            };
            let file_name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "log.txt".to_string());
            total_size += trimmed.len();
            files.push(ContextFilePreview {
                path: format!("logs/{file_name}"),
                size: trimmed.len(),
            });
            context_parts.push(format!("## {file_name}\n{trimmed}"));

            if files.len() >= 5 {
                break;
            }
        }
    }

    Ok(ContextPreview {
        files,
        total_size,
        context_text: context_parts.join("\n\n"),
    })
}

fn looks_like_log(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext, "log" | "txt" | "out"))
        .unwrap_or(false)
}

pub async fn cancel_run(state: Arc<RunnerState>, run_id: String) -> Result<bool> {
    let child_handle = {
        let processes = state.processes.lock().await;
        processes.get(&run_id).cloned()
    };

    if let Some(child_handle) = child_handle {
        let mut child = child_handle.lock().await;
        child.kill().await?;
        return Ok(true);
    }

    if state.terminal_sessions.get(&run_id)?.is_some() {
        return terminal_kill(state, run_id);
    }

    Ok(false)
}

fn read_run_end_position(run_dir: &Path, fallback_text: &str) -> u64 {
    let metadata_path = run_dir.join("metadata.json");
    let Ok(raw) = fs::read_to_string(metadata_path) else {
        return terminal_position_len(fallback_text);
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return terminal_position_len(fallback_text);
    };
    value
        .get("endPosition")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| terminal_position_len(fallback_text))
}

fn find_latest_output_log_path(runs_root: &Path) -> Result<Option<PathBuf>> {
    let mut latest_log: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(runs_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let output_log = path.join("output.log");
        if !output_log.is_file() {
            continue;
        }
        let modified = fs::metadata(&output_log)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        match latest_log.as_ref() {
            Some((current_modified, _)) if modified <= *current_modified => {}
            _ => latest_log = Some((modified, output_log)),
        }
    }
    Ok(latest_log.map(|(_, path)| path))
}

pub fn terminal_get_last_log(
    workspace_id: &str,
    thread_id: &str,
) -> Result<TerminalOutputSnapshot> {
    let runs_root = storage::runs_dir(workspace_id, thread_id)?;
    if !runs_root.exists() {
        return Ok(TerminalOutputSnapshot {
            text: String::new(),
            start_position: 0,
            end_position: 0,
            truncated: false,
        });
    }

    let pointer_log = storage::latest_thread_run_dir(workspace_id, thread_id)
        .ok()
        .flatten()
        .map(|run_dir| run_dir.join("output.log"))
        .filter(|path| path.is_file());
    let Some(last_log) = pointer_log.or(find_latest_output_log_path(&runs_root)?) else {
        return Ok(TerminalOutputSnapshot {
            text: String::new(),
            start_position: 0,
            end_position: 0,
            truncated: false,
        });
    };

    let run_dir = last_log.parent().unwrap_or_else(|| Path::new(""));
    let (text, truncated) = read_log_snapshot(&last_log)?;
    let end_position = read_run_end_position(run_dir, &text);
    let text_len = terminal_position_len(&text);
    let start_position = end_position.saturating_sub(text_len);
    Ok(TerminalOutputSnapshot {
        text,
        start_position,
        end_position,
        truncated,
    })
}

pub fn latest_claude_session_cwd(
    workspace_path: String,
    claude_session_id: String,
) -> Result<Option<String>> {
    let normalized_session_id = claude_session_id.trim();
    if normalized_session_id.is_empty() {
        return Ok(None);
    }

    let session_path = claude_session_jsonl_path(&workspace_path, normalized_session_id)?;
    let latest_cwd = latest_claude_session_cwd_from_jsonl(&session_path);
    Ok(match latest_cwd {
        Some(cwd) if Path::new(&cwd).is_dir() => Some(cwd),
        Some(cwd) if overlay_worktree_repo_root_path(&cwd).is_some() => {
            Some(canonicalize_path_or_original(&workspace_path))
        }
        Some(_) => None,
        None => None,
    })
}

pub fn latest_claude_turn_completion(
    workspace_path: String,
    claude_session_id: String,
) -> Result<Option<ClaudeTurnCompletionSummary>> {
    let normalized_session_id = claude_session_id.trim();
    if normalized_session_id.is_empty() {
        return Ok(None);
    }

    let session_path = claude_session_jsonl_path(&workspace_path, normalized_session_id)?;
    Ok(latest_qualifying_claude_turn_completion(
        &session_path,
        normalized_session_id,
    ))
}

pub fn terminal_read_output(
    state: Arc<RunnerState>,
    session_id: String,
) -> Result<TerminalOutputSnapshot> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Err(anyhow!("Terminal session not found"));
    };

    session.output_state.snapshot()
}

pub fn prepare_thread_native_fork(
    state: Arc<RunnerState>,
    workspace_id: String,
    thread_id: String,
    terminal_session_id: String,
) -> Result<PreparedNativeFork> {
    let workspace = storage::load_workspaces()?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| anyhow!("Workspace not found"))?;
    if workspace.kind != WorkspaceKind::Local {
        return Err(anyhow!(
            "Thread forking is only supported for local workspaces"
        ));
    }

    let thread = storage::read_thread_metadata(&workspace_id, &thread_id)?;
    let session = state
        .terminal_sessions
        .get(&terminal_session_id)?
        .ok_or_else(|| anyhow!("Terminal session not found"))?;
    if session.workspace_id != workspace_id
        || session.thread_id.as_deref() != Some(thread_id.as_str())
    {
        return Err(anyhow!(
            "Terminal session does not match the selected thread"
        ));
    }

    let source_claude_session_id = thread
        .claude_session_id
        .as_deref()
        .filter(|session_id| is_uuid_like(session_id))
        .map(ToString::to_string)
        .or_else(|| {
            session
                .pending_confirmation_session_id
                .lock()
                .ok()
                .and_then(|pending| pending.clone())
                .filter(|session_id| is_uuid_like(session_id))
        })
        .or_else(|| {
            session
                .resume_session_id
                .clone()
                .filter(|session_id| is_uuid_like(session_id))
        })
        .ok_or_else(|| anyhow!("Unable to resolve the source Claude session id for this thread"))?;
    let known_child_session_ids = known_fork_child_session_ids(&source_claude_session_id)?;
    let requested_at = Utc::now();

    Ok(PreparedNativeFork {
        source_claude_session_id,
        known_child_session_ids,
        requested_at,
    })
}

pub async fn terminal_start_session(
    app: AppHandle,
    state: Arc<RunnerState>,
    workspace_path: String,
    initial_cwd: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    full_access_flag: bool,
    thread_id: String,
) -> Result<TerminalStartResponse> {
    let workspace = storage::resolve_workspace_by_path(&workspace_path)?.ok_or_else(|| {
        anyhow!("Workspace not registered. Add workspace before starting terminal.")
    })?;
    let workspace_id = workspace.id.clone();
    let stale_sessions = state
        .terminal_sessions
        .remove_for_thread(&workspace_id, &thread_id)?;
    for stale_session in stale_sessions {
        terminate_terminal_session_process(&stale_session);
    }

    let mut thread = storage::read_thread_metadata(&workspace_id, &thread_id)?;
    let started_at = Utc::now();
    if thread.full_access != full_access_flag {
        thread.full_access = full_access_flag;
    }
    if thread
        .claude_session_id
        .as_deref()
        .is_some_and(|session_id| !is_uuid_like(session_id))
    {
        thread.claude_session_id = None;
    }
    if thread
        .pending_fork_source_claude_session_id
        .as_deref()
        .is_some_and(|session_id| !is_uuid_like(session_id))
    {
        thread.pending_fork_source_claude_session_id = None;
        thread.pending_fork_known_child_session_ids.clear();
        thread.pending_fork_requested_at = None;
        thread.pending_fork_launch_consumed = false;
    }
    if thread.pending_fork_launch_consumed
        && thread
            .pending_fork_source_claude_session_id
            .as_deref()
            .is_some_and(is_uuid_like)
        && thread
            .claude_session_id
            .as_deref()
            .map(str::trim)
            .is_none_or(|session_id| {
                thread.pending_fork_source_claude_session_id.as_deref() == Some(session_id)
            })
    {
        return Err(anyhow!(
            "Thread is waiting for fork resolution before it can be resumed"
        ));
    }

    let pending_fork_source_session_id = thread
        .pending_fork_source_claude_session_id
        .clone()
        .filter(|session_id| is_uuid_like(session_id))
        .filter(|_| !thread.pending_fork_launch_consumed);
    let pending_fork_restore_snapshot = pending_fork_source_session_id.as_ref().map(|session_id| {
        (
            session_id.clone(),
            thread.pending_fork_known_child_session_ids.clone(),
            thread.pending_fork_requested_at.unwrap_or(started_at),
        )
    });

    let (launch_session_id, session_mode, generated_session_id) =
        if let Some(source_claude_session_id) = pending_fork_source_session_id {
            thread.last_new_session_at = Some(started_at);
            thread.claude_session_id = None;
            (
                Some(source_claude_session_id),
                TerminalSessionMode::Forked,
                false,
            )
        } else {
            let mut launch_session_id = thread
                .claude_session_id
                .clone()
                .filter(|session_id| is_uuid_like(session_id));
            if launch_session_id.is_none() {
                if let Some(recovered) = recover_session_id_from_logs(&workspace_id, &thread_id) {
                    launch_session_id = Some(recovered);
                }
            }
            let generated_session_id = if launch_session_id.is_none() {
                launch_session_id = Some(Uuid::new_v4().to_string());
                true
            } else {
                false
            };

            let session_mode = if generated_session_id {
                thread.last_new_session_at = Some(started_at);
                thread.claude_session_id = None;
                TerminalSessionMode::New
            } else {
                thread.last_resume_at = Some(started_at);
                thread.claude_session_id = launch_session_id.clone();
                TerminalSessionMode::Resumed
            };
            (launch_session_id, session_mode, generated_session_id)
        };
    let launch_session_id =
        launch_session_id.ok_or_else(|| anyhow!("Missing Claude session id"))?;
    let resume_session_id = if session_mode == TerminalSessionMode::Resumed {
        Some(launch_session_id.clone())
    } else {
        None
    };
    thread.updated_at = started_at;
    storage::write_thread_metadata(&thread)?;

    let settings = storage::load_settings()?;
    let claude_command = resolve_claude_command_for_workspace(workspace.kind, &settings)?;

    let cwd = if workspace.kind == WorkspaceKind::Local {
        initial_cwd.unwrap_or_else(|| workspace_path.clone())
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .to_string_lossy()
            .to_string()
    };
    let session_id = Uuid::new_v4().to_string();
    let run_dir = storage::runs_dir(&workspace_id, &thread_id)?.join(&session_id);
    fs::create_dir_all(&run_dir)?;

    let shell_path = resolve_login_shell();
    let use_session_id_for_resume = session_mode == TerminalSessionMode::Resumed
        && workspace.kind == WorkspaceKind::Local
        && resumed_session_requires_session_id_launch(&workspace_path, &cwd, &launch_session_id)?;
    let claude_shell_command = build_claude_shell_command(
        &claude_command,
        &launch_session_id,
        session_mode,
        full_access_flag,
        use_session_id_for_resume,
    );
    let (shell_command, post_connect_command) = build_terminal_shell_command(
        workspace.kind,
        workspace.rdev_ssh_command.as_deref(),
        workspace.ssh_command.as_deref(),
        workspace.remote_path.as_deref(),
        &claude_shell_command,
    )?;
    let launch_command_for_readiness = post_connect_command
        .clone()
        .unwrap_or_else(|| shell_command.clone());
    let command_manifest = vec![
        shell_path.clone(),
        "-lic".to_string(),
        shell_command.clone(),
    ];
    storage::write_json_file(
        &run_dir.join("input_manifest.json"),
        &serde_json::json!({
            "sessionId": session_id,
            "threadId": thread_id,
            "workspacePath": workspace_path,
            "workspaceId": workspace_id,
            "fullAccess": full_access_flag,
            "sessionMode": session_mode.as_str(),
            "resumeSessionId": resume_session_id.clone(),
            "claudeSessionId": thread.claude_session_id.clone(),
            "launchSessionId": launch_session_id.clone(),
            "cwd": cwd,
            "envVars": env_vars,
            "command": command_manifest,
            "shell": shell_path,
            "shellCommand": shell_command,
            "startedAt": started_at,
            "mode": "interactive-terminal"
            ,
            "workspaceKind": match workspace.kind {
                WorkspaceKind::Local => "local",
                WorkspaceKind::Rdev => "rdev",
                WorkspaceKind::Ssh => "ssh"
            },
            "postConnectCommand": post_connect_command.clone()
        }),
    )?;

    let pty_system = native_pty_system();
    let pty_pair = pty_system.openpty(PtySize {
        rows: 32,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(shell_path.clone());
    command.arg("-lic");
    command.arg(shell_command.clone());
    command.cwd(cwd.clone());
    command.env_clear();
    for (key, value) in env::vars() {
        if key == "TERM" || key.eq_ignore_ascii_case("NO_COLOR") {
            continue;
        }
        command.env(key, value);
    }
    if let Some(extra_env) = &env_vars {
        for (key, value) in extra_env {
            if key.eq_ignore_ascii_case("NO_COLOR") {
                continue;
            }
            command.env(key, value);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("CLICOLOR", "1");
    command.env("CLICOLOR_FORCE", "1");
    command.env("FORCE_COLOR", "1");
    command.env("ZSH_DISABLE_COMPFIX", "true");

    let child = pty_pair.slave.spawn_command(command)?;
    let process_id = child.process_id();
    let mut reader = pty_pair.master.try_clone_reader()?;
    let writer = pty_pair.master.take_writer()?;
    let output_log_path = run_dir.join("output.log");
    let output_log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_log_path)?,
    ));
    let output_state = Arc::new(TerminalOutputState::new());

    let session_killed = Arc::new(AtomicBool::new(false));
    let session = Arc::new(TerminalSession {
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        workspace_path: workspace_path.clone(),
        current_cwd: Mutex::new(cwd.clone()),
        observed_claude_session_id: Mutex::new(launch_session_id.clone()),
        kind: TerminalSessionKind::ClaudeThread,
        thread_id: Some(thread_id.clone()),
        session_mode: Some(session_mode),
        resume_session_id: resume_session_id.clone(),
        pending_confirmation_session_id: Mutex::new(if generated_session_id {
            Some(launch_session_id.clone())
        } else {
            None
        }),
        submitted_input_buffer: Mutex::new(String::new()),
        process_id,
        started_at,
        command: command_manifest.clone(),
        output_log_path,
        output_state: output_state.clone(),
        submitted_prompt_count: AtomicU64::new(0),
        claude_session_id_confirmed: AtomicBool::new(false),
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
        killed: session_killed.clone(),
    });
    if session_mode == TerminalSessionMode::Forked {
        match storage::mark_thread_pending_fork_consumed(&workspace_id, &thread_id) {
            Ok(updated_thread) => thread = updated_thread,
            Err(error) => {
                terminate_terminal_session_process(&session);
                return Err(error);
            }
        }
    }
    if let Err(error) = state.terminal_sessions.insert(session.clone()) {
        if let Some((source_session_id, known_child_session_ids, requested_at)) =
            &pending_fork_restore_snapshot
        {
            let _ = storage::set_thread_pending_fork(
                &workspace_id,
                &thread_id,
                source_session_id,
                known_child_session_ids.clone(),
                *requested_at,
            );
        }
        terminate_terminal_session_process(&session);
        return Err(error);
    }
    if workspace.kind == WorkspaceKind::Local {
        spawn_claude_turn_completion_watcher(
            app.clone(),
            session.clone(),
            thread_id.clone(),
            launch_session_id.clone(),
        );
    }

    let data_session_id = session_id.clone();
    let data_thread_id = thread_id.clone();
    let data_workspace_id = workspace_id.clone();
    let data_output_log = output_log.clone();
    let data_output_state = output_state.clone();
    let data_app = app.clone();
    let post_connect_writer = session.writer.clone();
    let post_connect_started_at = Instant::now();
    let mut pending_post_connect_command = post_connect_command;
    let mut post_connect_prompt_probe = String::new();
    let mut saw_ssh_connection_start = false;
    let mut launch_command_dispatched =
        workspace.kind == WorkspaceKind::Local || pending_post_connect_command.is_none();
    let mut launch_dispatch_probe = String::new();
    let mut launch_output_probe = String::new();
    let mut ready_emitted = false;
    let mut ssh_startup_block_reason = None;
    let mut ssh_startup_detection_active = workspace.kind == WorkspaceKind::Ssh;
    std::thread::spawn(move || {
        let mut buffer = [0u8; 32_768];
        let mut utf8_carry = Vec::<u8>::new();
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => size,
                Err(_) => break,
            };

            if let Ok(mut file) = data_output_log.lock() {
                let _ = file.write_all(&buffer[..read]);
            }

            if let Some(chunk) = decode_utf8_chunk(&buffer[..read], &mut utf8_carry) {
                let clean_chunk = strip_ansi_sequences(&chunk);
                if should_probe_ssh_startup_auth(
                    workspace.kind,
                    ssh_startup_detection_active,
                    ssh_startup_block_reason,
                    ready_emitted,
                    &clean_chunk,
                ) {
                    post_connect_prompt_probe.push_str(&clean_chunk);
                    trim_prompt_probe_buffer(&mut post_connect_prompt_probe);
                    let lower = clean_chunk.to_ascii_lowercase();
                    if lower.contains("starting ssh connection")
                        || lower.contains("connected to")
                        || lower.contains("now ready to use")
                    {
                        saw_ssh_connection_start = true;
                    }
                    if let Some(reason) =
                        detect_ssh_startup_block_reason(&post_connect_prompt_probe)
                    {
                        ssh_startup_block_reason = Some(reason);
                        ssh_startup_detection_active = false;
                        pending_post_connect_command = None;
                        emit_terminal_ssh_auth_status(
                            &data_app,
                            &data_session_id,
                            &data_workspace_id,
                            Some(&data_thread_id),
                            reason,
                        );
                    }
                }

                if pending_post_connect_command.is_some() && ssh_startup_block_reason.is_none() {
                    if !clean_chunk.is_empty() {
                        if workspace.kind != WorkspaceKind::Ssh {
                            post_connect_prompt_probe.push_str(&clean_chunk);
                            trim_prompt_probe_buffer(&mut post_connect_prompt_probe);
                        }
                        let lower = clean_chunk.to_ascii_lowercase();
                        if lower.contains("starting ssh connection")
                            || lower.contains("connected to")
                            || lower.contains("now ready to use")
                        {
                            saw_ssh_connection_start = true;
                        }
                    }

                    let should_send_post_connect = should_dispatch_post_connect_command(
                        &post_connect_prompt_probe,
                        saw_ssh_connection_start,
                        post_connect_started_at.elapsed(),
                    );
                    if should_send_post_connect {
                        if let Some(command) = pending_post_connect_command.take() {
                            if let Ok(mut writer) = post_connect_writer.lock() {
                                let _ = writer.write_all(format!("{command}\r").as_bytes());
                                let _ = writer.flush();
                                launch_dispatch_probe.clear();
                                launch_output_probe.clear();
                            }
                        }
                        ssh_startup_detection_active = false;
                        post_connect_prompt_probe.clear();
                    }
                }

                if !launch_command_dispatched
                    && chunk_mentions_launch_command(
                        &mut launch_dispatch_probe,
                        &chunk,
                        &launch_command_for_readiness,
                    )
                {
                    launch_command_dispatched = true;
                    ssh_startup_detection_active = false;
                    launch_dispatch_probe.clear();
                    launch_output_probe.clear();
                }

                if !ready_emitted
                    && ssh_startup_block_reason.is_none()
                    && launch_command_dispatched
                    && !session_killed.load(Ordering::Acquire)
                    && chunk_has_non_echo_launch_output(
                        &mut launch_output_probe,
                        &chunk,
                        &launch_command_for_readiness,
                    )
                {
                    ready_emitted = true;
                    emit_terminal_ready(&data_app, &data_thread_id, &data_session_id);
                }
                let (start_position, end_position) =
                    data_output_state.append(&chunk).unwrap_or((0, 0));
                let _ = data_app.emit(
                    TERMINAL_DATA_EVENT,
                    TerminalDataEvent {
                        session_id: data_session_id.clone(),
                        thread_id: Some(data_thread_id.clone()),
                        data: chunk,
                        start_position,
                        end_position,
                    },
                );
            }
        }

        if !utf8_carry.is_empty() {
            let trailing = String::from_utf8_lossy(&utf8_carry).to_string();
            if !ready_emitted
                && ssh_startup_block_reason.is_none()
                && launch_command_dispatched
                && !session_killed.load(Ordering::Acquire)
                && chunk_has_non_echo_launch_output(
                    &mut launch_output_probe,
                    &trailing,
                    &launch_command_for_readiness,
                )
            {
                emit_terminal_ready(&data_app, &data_thread_id, &data_session_id);
            }
            let (start_position, end_position) =
                data_output_state.append(&trailing).unwrap_or((0, 0));
            let _ = data_app.emit(
                TERMINAL_DATA_EVENT,
                TerminalDataEvent {
                    session_id: data_session_id.clone(),
                    thread_id: Some(data_thread_id.clone()),
                    data: trailing,
                    start_position,
                    end_position,
                },
            );
        }

        if let Ok(file) = data_output_log.lock() {
            let _ = file.sync_data();
        }
        let _ = data_output_state.mark_reader_done();
    });

    let wait_state = state.clone();
    let wait_session = session.clone();
    let wait_session_id = session_id.clone();
    std::thread::spawn(move || {
        let (code, signal) = {
            let mut child = match wait_session.child.lock() {
                Ok(child) => child,
                Err(_) => return,
            };
            match child.wait() {
                Ok(status) => (Some(status.exit_code() as i32), None),
                Err(_) => (None, None),
            }
        };
        let _ = wait_session.output_state.wait_until_reader_done();
        let end_position = wait_session.output_state.end_position().unwrap_or(0);

        wait_session.killed.store(true, Ordering::Release);
        let _ = wait_state.terminal_sessions.remove(&wait_session_id);

        let ended_at = Utc::now();
        let duration_ms = (ended_at - wait_session.started_at).num_milliseconds();
        let thread_id = match wait_session.thread_id.as_deref() {
            Some(thread_id) => thread_id,
            None => return,
        };
        let run_folder = storage::runs_dir(&wait_session.workspace_id, thread_id)
            .unwrap_or_else(|_| PathBuf::from(""))
            .join(&wait_session_id);

        let _ = storage::write_json_file(
            &run_folder.join("metadata.json"),
            &serde_json::json!({
                "sessionId": wait_session_id,
                "threadId": thread_id,
                "workspaceId": wait_session.workspace_id,
                "sessionMode": wait_session.session_mode.map(|mode| mode.as_str()),
                "resumeSessionId": wait_session.resume_session_id,
                "command": wait_session.command,
                "durationMs": duration_ms,
                "exitCode": code,
                "signal": signal,
                "startedAt": wait_session.started_at,
                "endedAt": ended_at,
                "endPosition": end_position,
                "rawOutputLogPath": wait_session.output_log_path,
                "userInputsLogPath": serde_json::Value::Null,
                "outputLogPath": wait_session.output_log_path,
            }),
        );

        let status = if signal.is_some() || code == Some(130) {
            ThreadRunStatus::Canceled
        } else if code == Some(0) {
            ThreadRunStatus::Succeeded
        } else {
            ThreadRunStatus::Failed
        };
        let _ = storage::set_thread_run_state(
            &wait_session.workspace_id,
            thread_id,
            status,
            None,
            Some(ended_at),
        );

        let diff_workspace_path = wait_session
            .current_cwd
            .lock()
            .ok()
            .map(|cwd| cwd.clone())
            .filter(|cwd| !cwd.trim().is_empty())
            .unwrap_or_else(|| wait_session.workspace_path.clone());
        if let Ok(diff) = git_tools::capture_patch_diff(&diff_workspace_path) {
            let _ = fs::write(run_folder.join("patch.diff"), diff);
        }

        let _ = storage::set_latest_thread_run_id(
            &wait_session.workspace_id,
            thread_id,
            &wait_session_id,
        );

        let _ = app.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitEvent {
                session_id: wait_session_id,
                code,
                signal,
            },
        );
    });

    Ok(TerminalStartResponse {
        session_id,
        session_mode: session_mode.as_str().to_string(),
        resume_session_id,
        turn_completion_mode: if workspace.kind == WorkspaceKind::Local {
            "jsonl".to_string()
        } else {
            "idle".to_string()
        },
        thread,
    })
}

pub async fn workspace_shell_start_session(
    app: AppHandle,
    state: Arc<RunnerState>,
    workspace_path: String,
    initial_cwd: Option<String>,
    env_vars: Option<HashMap<String, String>>,
) -> Result<WorkspaceShellStartResponse> {
    let workspace = storage::resolve_workspace_by_path(&workspace_path)?.ok_or_else(|| {
        anyhow!("Workspace not registered. Add workspace before starting terminal.")
    })?;
    let workspace_id = workspace.id.clone();
    let stale_sessions = state
        .terminal_sessions
        .remove_for_workspace_shell(&workspace_id)?;
    for stale_session in stale_sessions {
        terminate_terminal_session_process(&stale_session);
    }

    let shell_path = resolve_login_shell();
    let cwd = if workspace.kind == WorkspaceKind::Local {
        initial_cwd.unwrap_or_else(|| workspace_path.clone())
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .to_string_lossy()
            .to_string()
    };

    let session_id = Uuid::new_v4().to_string();
    let run_dir = storage::workspace_shell_sessions_dir(&workspace_id)?.join(&session_id);
    fs::create_dir_all(&run_dir)?;

    let (shell_command, post_connect_command) = build_workspace_shell_command(
        workspace.kind,
        &shell_path,
        workspace.rdev_ssh_command.as_deref(),
        workspace.ssh_command.as_deref(),
        workspace.remote_path.as_deref(),
    )?;
    let mut command_manifest = vec![shell_path.clone()];

    let pty_system = native_pty_system();
    let pty_pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut command = CommandBuilder::new(shell_path.clone());
    if let Some(shell_command) = shell_command.clone() {
        command.arg("-lic");
        command.arg(shell_command.clone());
        command_manifest.push("-lic".to_string());
        command_manifest.push(shell_command);
    } else {
        command.arg("-li");
        command_manifest.push("-li".to_string());
    }
    command.cwd(cwd.clone());
    command.env_clear();
    for (key, value) in env::vars() {
        if key == "TERM" || key.eq_ignore_ascii_case("NO_COLOR") {
            continue;
        }
        command.env(key, value);
    }
    if let Some(extra_env) = &env_vars {
        for (key, value) in extra_env {
            if key.eq_ignore_ascii_case("NO_COLOR") {
                continue;
            }
            command.env(key, value);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("CLICOLOR", "1");
    command.env("CLICOLOR_FORCE", "1");
    command.env("FORCE_COLOR", "1");
    command.env("ZSH_DISABLE_COMPFIX", "true");

    storage::write_json_file(
        &run_dir.join("input_manifest.json"),
        &serde_json::json!({
            "sessionId": session_id,
            "workspacePath": workspace_path,
            "workspaceId": workspace_id,
            "cwd": cwd,
            "envVars": env_vars,
            "command": command_manifest,
            "shell": shell_path,
            "shellCommand": shell_command,
            "startedAt": Utc::now(),
            "mode": "workspace-shell-terminal",
            "workspaceKind": match workspace.kind {
                WorkspaceKind::Local => "local",
                WorkspaceKind::Rdev => "rdev",
                WorkspaceKind::Ssh => "ssh",
            },
            "postConnectCommand": post_connect_command,
        }),
    )?;

    let child = pty_pair.slave.spawn_command(command)?;
    let process_id = child.process_id();
    let mut reader = pty_pair.master.try_clone_reader()?;
    let writer = pty_pair.master.take_writer()?;
    let output_log_path = run_dir.join("output.log");
    let output_log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_log_path)?,
    ));
    let output_state = Arc::new(TerminalOutputState::new());

    let started_at = Utc::now();
    let session = Arc::new(TerminalSession {
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        workspace_path: workspace_path.clone(),
        current_cwd: Mutex::new(cwd.clone()),
        observed_claude_session_id: Mutex::new(String::new()),
        kind: TerminalSessionKind::WorkspaceShell,
        thread_id: None,
        session_mode: None,
        resume_session_id: None,
        pending_confirmation_session_id: Mutex::new(None),
        submitted_input_buffer: Mutex::new(String::new()),
        process_id,
        started_at,
        command: command_manifest.clone(),
        output_log_path: output_log_path.clone(),
        output_state: output_state.clone(),
        submitted_prompt_count: AtomicU64::new(0),
        claude_session_id_confirmed: AtomicBool::new(false),
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
        killed: Arc::new(AtomicBool::new(false)),
    });
    state.terminal_sessions.insert(session.clone())?;

    let data_session_id = session_id.clone();
    let data_workspace_id = workspace_id.clone();
    let data_output_log = output_log.clone();
    let data_output_state = output_state.clone();
    let data_app = app.clone();
    let post_connect_writer = session.writer.clone();
    let post_connect_started_at = Instant::now();
    let mut pending_post_connect_command = post_connect_command;
    let mut post_connect_prompt_probe = String::new();
    let mut saw_ssh_connection_start = false;
    let mut ssh_startup_block_reason = None;
    let mut ssh_startup_detection_active = workspace.kind == WorkspaceKind::Ssh;
    std::thread::spawn(move || {
        let mut buffer = [0u8; 32_768];
        let mut utf8_carry = Vec::<u8>::new();
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => size,
                Err(_) => break,
            };

            if let Ok(mut file) = data_output_log.lock() {
                let _ = file.write_all(&buffer[..read]);
            }

            if let Some(chunk) = decode_utf8_chunk(&buffer[..read], &mut utf8_carry) {
                let clean_chunk = strip_ansi_sequences(&chunk);
                if should_probe_ssh_startup_auth(
                    workspace.kind,
                    ssh_startup_detection_active,
                    ssh_startup_block_reason,
                    false,
                    &clean_chunk,
                ) {
                    post_connect_prompt_probe.push_str(&clean_chunk);
                    trim_prompt_probe_buffer(&mut post_connect_prompt_probe);
                    let lower = clean_chunk.to_ascii_lowercase();
                    if lower.contains("starting ssh connection")
                        || lower.contains("connected to")
                        || lower.contains("now ready to use")
                    {
                        saw_ssh_connection_start = true;
                    }
                    if let Some(reason) =
                        detect_ssh_startup_block_reason(&post_connect_prompt_probe)
                    {
                        ssh_startup_block_reason = Some(reason);
                        ssh_startup_detection_active = false;
                        pending_post_connect_command = None;
                        emit_terminal_ssh_auth_status(
                            &data_app,
                            &data_session_id,
                            &data_workspace_id,
                            None,
                            reason,
                        );
                    } else if should_dispatch_post_connect_command(
                        &post_connect_prompt_probe,
                        saw_ssh_connection_start,
                        post_connect_started_at.elapsed(),
                    ) {
                        if let Some(command) = pending_post_connect_command.take() {
                            if let Ok(mut writer) = post_connect_writer.lock() {
                                let _ = writer.write_all(format!("{command}\r").as_bytes());
                                let _ = writer.flush();
                            }
                        }
                        post_connect_prompt_probe.clear();
                        ssh_startup_detection_active = false;
                    }
                }

                if pending_post_connect_command.is_some() && ssh_startup_block_reason.is_none() {
                    if !clean_chunk.is_empty() {
                        if workspace.kind != WorkspaceKind::Ssh {
                            post_connect_prompt_probe.push_str(&clean_chunk);
                            trim_prompt_probe_buffer(&mut post_connect_prompt_probe);
                        }
                        let lower = clean_chunk.to_ascii_lowercase();
                        if lower.contains("starting ssh connection")
                            || lower.contains("connected to")
                            || lower.contains("now ready to use")
                        {
                            saw_ssh_connection_start = true;
                        }
                    }

                    let should_send_post_connect = should_dispatch_post_connect_command(
                        &post_connect_prompt_probe,
                        saw_ssh_connection_start,
                        post_connect_started_at.elapsed(),
                    );
                    if should_send_post_connect {
                        if let Some(command) = pending_post_connect_command.take() {
                            if let Ok(mut writer) = post_connect_writer.lock() {
                                let _ = writer.write_all(format!("{command}\r").as_bytes());
                                let _ = writer.flush();
                            }
                        }
                        post_connect_prompt_probe.clear();
                    }
                }

                let (start_position, end_position) =
                    data_output_state.append(&chunk).unwrap_or((0, 0));
                let _ = data_app.emit(
                    TERMINAL_DATA_EVENT,
                    TerminalDataEvent {
                        session_id: data_session_id.clone(),
                        thread_id: None,
                        data: chunk,
                        start_position,
                        end_position,
                    },
                );
            }
        }

        if !utf8_carry.is_empty() {
            let trailing = String::from_utf8_lossy(&utf8_carry).to_string();
            let (start_position, end_position) =
                data_output_state.append(&trailing).unwrap_or((0, 0));
            let _ = data_app.emit(
                TERMINAL_DATA_EVENT,
                TerminalDataEvent {
                    session_id: data_session_id.clone(),
                    thread_id: None,
                    data: trailing,
                    start_position,
                    end_position,
                },
            );
        }

        if let Ok(file) = data_output_log.lock() {
            let _ = file.sync_data();
        }
        let _ = data_output_state.mark_reader_done();
    });

    let wait_state = state.clone();
    let wait_session = session.clone();
    let wait_session_id = session_id.clone();
    std::thread::spawn(move || {
        let (code, signal) = {
            let mut child = match wait_session.child.lock() {
                Ok(child) => child,
                Err(_) => return,
            };
            match child.wait() {
                Ok(status) => (Some(status.exit_code() as i32), None),
                Err(_) => (None, None),
            }
        };
        let _ = wait_session.output_state.wait_until_reader_done();
        let end_position = wait_session.output_state.end_position().unwrap_or(0);

        wait_session.killed.store(true, Ordering::Release);
        let _ = wait_state.terminal_sessions.remove(&wait_session_id);

        let ended_at = Utc::now();
        let duration_ms = (ended_at - wait_session.started_at).num_milliseconds();
        let _ = storage::write_json_file(
            &run_dir.join("metadata.json"),
            &serde_json::json!({
                "sessionId": wait_session_id,
                "workspaceId": wait_session.workspace_id,
                "command": wait_session.command,
                "durationMs": duration_ms,
                "exitCode": code,
                "signal": signal,
                "startedAt": wait_session.started_at,
                "endedAt": ended_at,
                "endPosition": end_position,
                "outputLogPath": wait_session.output_log_path,
            }),
        );

        let _ = app.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitEvent {
                session_id: wait_session_id,
                code,
                signal,
            },
        );
    });

    Ok(WorkspaceShellStartResponse { session_id })
}

pub fn terminal_write(
    app: AppHandle,
    state: Arc<RunnerState>,
    session_id: String,
    data: String,
) -> Result<bool> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    let mut writer = session
        .writer
        .lock()
        .map_err(|_| anyhow!("Terminal writer lock poisoned"))?;
    writer.write_all(data.as_bytes())?;
    writer.flush()?;
    drop(writer);

    let submitted_prompt = if session.kind == TerminalSessionKind::ClaudeThread {
        let mut input_buffer = session
            .submitted_input_buffer
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        update_prompt_submit_buffer(&mut input_buffer, &data)
    } else {
        false
    };

    if session.kind == TerminalSessionKind::ClaudeThread && submitted_prompt {
        session
            .submitted_prompt_count
            .fetch_add(1, Ordering::AcqRel);
        // Skip storage call if session ID was already confirmed set.
        if !session.claude_session_id_confirmed.load(Ordering::Acquire) {
            let pending_session_id = session
                .pending_confirmation_session_id
                .lock()
                .map_err(|_| anyhow!("Terminal session lock poisoned"))?
                .clone();
            if let (Some(thread_id), Some(launch_session_id)) =
                (session.thread_id.as_deref(), pending_session_id)
            {
                if let Ok(updated_thread) = storage::set_thread_claude_session_id_if_missing(
                    &session.workspace_id,
                    thread_id,
                    &launch_session_id,
                ) {
                    if let Ok(mut pending_confirmation_session_id) =
                        session.pending_confirmation_session_id.lock()
                    {
                        *pending_confirmation_session_id = None;
                    }
                    session
                        .claude_session_id_confirmed
                        .store(true, Ordering::Release);
                    if let Some(thread) = updated_thread {
                        let _ = app.emit(THREAD_UPDATED_EVENT, thread);
                    }
                }
            }
        }
    }

    Ok(true)
}

pub fn terminal_rebind_claude_session(
    state: Arc<RunnerState>,
    session_id: String,
    claude_session_id: String,
) -> Result<bool> {
    let normalized_claude_session_id = claude_session_id.trim();
    if !is_uuid_like(normalized_claude_session_id) {
        return Err(anyhow!("Claude session id must be a UUID"));
    }

    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };
    if session.kind != TerminalSessionKind::ClaudeThread {
        return Ok(false);
    }

    {
        let mut observed_claude_session_id = session
            .observed_claude_session_id
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        *observed_claude_session_id = normalized_claude_session_id.to_string();
    }

    if let Some(current_cwd) = latest_claude_session_cwd(
        session.workspace_path.clone(),
        normalized_claude_session_id.to_string(),
    )? {
        if let Ok(mut session_cwd) = session.current_cwd.lock() {
            *session_cwd = current_cwd;
        }
    }

    Ok(true)
}

pub fn terminal_resize(
    state: Arc<RunnerState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    let clamped_cols = cols.clamp(20, 400);
    let clamped_rows = rows.clamp(8, 240);
    let master = session
        .master
        .lock()
        .map_err(|_| anyhow!("Terminal master lock poisoned"))?;
    master.resize(PtySize {
        cols: clamped_cols,
        rows: clamped_rows,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    Ok(true)
}

pub fn terminal_kill(state: Arc<RunnerState>, session_id: String) -> Result<bool> {
    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    session.killed.store(true, Ordering::Release);

    let Some(pid) = session.process_id else {
        return Err(anyhow!("Terminal session process id is unavailable"));
    };

    let result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    if result == 0 {
        let _ = state.terminal_sessions.remove(&session_id);
        return Ok(true);
    }

    let error_code = std::io::Error::last_os_error().raw_os_error();
    if error_code == Some(libc::ESRCH) {
        let _ = state.terminal_sessions.remove(&session_id);
        return Ok(true);
    }

    Err(anyhow!("Failed to terminate terminal session process"))
}

pub fn terminal_send_signal(
    state: Arc<RunnerState>,
    session_id: String,
    signal: String,
) -> Result<bool> {
    let normalized = signal.trim().to_uppercase();
    if normalized != "SIGINT" && normalized != "INT" {
        return Err(anyhow!("Only SIGINT is currently supported"));
    }

    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };

    if let Some(pid) = session.process_id {
        let result = unsafe { libc::kill(pid as i32, libc::SIGINT) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(true);
        }
    }

    let mut writer = session
        .writer
        .lock()
        .map_err(|_| anyhow!("Terminal writer lock poisoned"))?;
    writer.write_all("\u{3}".as_bytes())?;
    writer.flush()?;
    Ok(true)
}

pub fn copy_terminal_env_diagnostics(workspace_path: String) -> Result<String> {
    let settings = storage::load_settings()?;
    let cli_path = detect_claude_cli_path(&settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))?;
    let shell_path = resolve_login_shell();
    let shell_command = format!(
        "env; echo '---'; which claude; echo '---'; {} --version",
        shell_escape_arg(&cli_path)
    );

    let mut command = StdCommand::new(&shell_path);
    command
        .arg("-lic")
        .arg(shell_command)
        .current_dir(&workspace_path)
        .envs(env::vars());
    let output = run_std_command_with_timeout(
        command,
        TERMINAL_ENV_DIAGNOSTICS_TIMEOUT,
        "Terminal diagnostics command",
    )?;
    let sanitized_stdout =
        sanitize_env_diagnostics_stdout(&String::from_utf8_lossy(&output.stdout));

    let mut diagnostics = String::new();
    diagnostics.push_str(&format!("shell={shell_path}\n"));
    diagnostics.push_str(&format!("workspace={workspace_path}\n"));
    diagnostics.push_str("=== stdout ===\n");
    diagnostics.push_str(&sanitized_stdout);
    diagnostics.push_str("\n=== stderr ===\n");
    diagnostics.push_str(&String::from_utf8_lossy(&output.stderr));

    let artifacts_root = storage::ensure_base_dirs()?.join("artifacts");
    fs::create_dir_all(&artifacts_root)?;
    fs::write(
        artifacts_root.join("env-diagnostics.txt"),
        diagnostics.as_bytes(),
    )?;

    Ok(diagnostics)
}

pub fn validate_importable_claude_session(
    workspace_path: String,
    claude_session_id: String,
) -> Result<()> {
    resolve_importable_claude_session_project_dir(&workspace_path, &claude_session_id).map(|_| ())
}

pub fn get_importable_claude_session(
    workspace_path: String,
    claude_session_id: String,
) -> Result<Option<ImportableClaudeSession>> {
    let normalized_workspace_path = normalize_importable_project_path(&workspace_path);
    let normalized_session_id = claude_session_id.trim();
    if normalized_session_id.is_empty() {
        return Ok(None);
    }

    let project_dir = resolve_importable_claude_session_project_dir(
        &normalized_workspace_path,
        normalized_session_id,
    )?;
    find_importable_session_in_project_dir(&project_dir, normalized_session_id)
}

fn extract_mounted_volume_path(hdiutil_output: &str) -> Option<String> {
    hdiutil_output.lines().find_map(|line| {
        line.find("/Volumes/")
            .map(|index| line[index..].trim().to_string())
    })
}

pub fn install_latest_update() -> Result<()> {
    let home_dir = dirs::home_dir().ok_or_else(|| anyhow!("Unable to resolve home directory"))?;
    let downloads_dir = home_dir.join("Downloads");
    fs::create_dir_all(&downloads_dir)?;
    let dmg_path = downloads_dir.join("ATController.dmg");
    let dmg_path_string = dmg_path.to_string_lossy().to_string();

    let mut download_command = StdCommand::new("curl");
    download_command.args([
        "-L",
        "-o",
        &dmg_path_string,
        "https://github.com/FuRyanf/ATController/releases/latest/download/ATController.dmg",
    ]);
    let download_output = run_std_command_with_timeout(
        download_command,
        Duration::from_secs(300),
        "ATController DMG download",
    )?;
    if !download_output.status.success() {
        let stderr = String::from_utf8_lossy(&download_output.stderr);
        return Err(anyhow!("Failed to download latest DMG: {stderr}"));
    }

    let mut attach_command = StdCommand::new("hdiutil");
    attach_command.args(["attach", &dmg_path_string, "-nobrowse"]);
    let attach_output =
        run_std_command_with_timeout(attach_command, Duration::from_secs(60), "DMG mount")?;
    if !attach_output.status.success() {
        let stderr = String::from_utf8_lossy(&attach_output.stderr);
        return Err(anyhow!("Failed to mount DMG: {stderr}"));
    }

    let attach_stdout = String::from_utf8_lossy(&attach_output.stdout);
    let attach_stderr = String::from_utf8_lossy(&attach_output.stderr);
    let mount_path = extract_mounted_volume_path(&attach_stdout)
        .or_else(|| extract_mounted_volume_path(&attach_stderr))
        .ok_or_else(|| anyhow!("Unable to locate mounted DMG volume path"))?;

    let source_app = Path::new(&mount_path).join("ATController.app");
    if !source_app.exists() {
        let _ = StdCommand::new("hdiutil")
            .args(["detach", &mount_path, "-quiet"])
            .status();
        return Err(anyhow!("Mounted DMG does not contain ATController.app"));
    }

    let target_app = PathBuf::from("/Applications/ATController.app");

    let install_result = (|| -> Result<()> {
        let copy_status = StdCommand::new("ditto")
            .arg(&source_app)
            .arg(&target_app)
            .status()?;
        if !copy_status.success() {
            return Err(anyhow!(
                "Failed to copy ATController.app into /Applications"
            ));
        }

        let _ = StdCommand::new("xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&target_app)
            .status();

        Ok(())
    })();

    let _ = StdCommand::new("hdiutil")
        .args(["detach", &mount_path, "-quiet"])
        .status();

    install_result
}

pub async fn run_claude(
    app: AppHandle,
    state: Arc<RunnerState>,
    request: RunClaudeRequest,
) -> Result<RunClaudeResponse> {
    let workspace_id = storage::resolve_workspace_id_by_path(&request.workspace_path)?
        .ok_or_else(|| anyhow!("Workspace not registered. Add workspace before running Claude."))?;

    let mut thread = storage::read_thread_metadata(&workspace_id, &request.thread_id)?;
    if thread.full_access != request.full_access {
        thread.full_access = request.full_access;
        storage::write_thread_metadata(&thread)?;
    }

    let settings = storage::load_settings()?;
    let cli_path = detect_claude_cli_path(&settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))?;

    let context_preview = build_context_preview(&request.workspace_path, &request.context_pack)?;
    let enabled_skill_docs =
        skills::resolve_enabled_skills_context(&request.workspace_path, &request.enabled_skills)?;
    let prompt = build_prompt(
        &request.message,
        &context_preview.context_text,
        &enabled_skill_docs,
    );

    let run_id = Uuid::new_v4().to_string();
    let run_dir = storage::runs_dir(&workspace_id, &request.thread_id)?.join(&run_id);
    fs::create_dir_all(&run_dir)?;

    let mut args = vec!["-p".to_string(), prompt.clone()];
    if request.full_access {
        args.push("--dangerously-skip-permissions".to_string());
    }

    let mut command = Command::new(&cli_path);
    command
        .args(&args)
        .current_dir(&request.workspace_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let command_manifest = [vec![cli_path.clone()], args.clone()].concat();
    let started_at = Utc::now();
    storage::write_json_file(
        &run_dir.join("input_manifest.json"),
        &serde_json::json!({
            "runId": run_id,
            "threadId": request.thread_id,
            "workspacePath": request.workspace_path,
            "workspaceId": workspace_id,
            "message": request.message,
            "enabledSkills": request.enabled_skills,
            "fullAccess": request.full_access,
            "contextPack": request.context_pack,
            "command": command_manifest,
            "startedAt": started_at,
        }),
    )?;

    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Failed to capture Claude stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Failed to capture Claude stderr"))?;

    let child_handle = Arc::new(AsyncMutex::new(child));
    {
        let mut processes = state.processes.lock().await;
        processes.insert(run_id.clone(), child_handle.clone());
    }

    let output_log = Arc::new(Mutex::new(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(run_dir.join("output.log"))?,
    ));

    let stdout_task = spawn_stream_reader(
        app.clone(),
        run_id.clone(),
        request.thread_id.clone(),
        "stdout".to_string(),
        stdout,
        output_log.clone(),
    );

    let stderr_task = spawn_stream_reader(
        app.clone(),
        run_id.clone(),
        request.thread_id.clone(),
        "stderr".to_string(),
        stderr,
        output_log,
    );

    let wait_state = state.clone();
    let wait_workspace_id = workspace_id.clone();
    let wait_thread_id = request.thread_id.clone();
    let wait_workspace_path = request.workspace_path.clone();
    let wait_run_id = run_id.clone();
    let wait_args = args.clone();

    tokio::spawn(async move {
        let status_result = {
            let mut child = child_handle.lock().await;
            child.wait().await
        };

        let _ = stdout_task.await;
        let _ = stderr_task.await;

        {
            let mut processes = wait_state.processes.lock().await;
            processes.remove(&wait_run_id);
        }

        let ended_at = Utc::now();
        let duration_ms = (ended_at - started_at).num_milliseconds();

        let exit_code = status_result.ok().and_then(|status| status.code());

        let command_vec = [vec![cli_path], wait_args].concat();
        let metadata = RunMetadata {
            run_id: wait_run_id.clone(),
            thread_id: wait_thread_id.clone(),
            workspace_id: wait_workspace_id.clone(),
            started_at,
            ended_at,
            duration_ms,
            exit_code,
            command: command_vec.clone(),
        };

        let run_folder: PathBuf = storage::runs_dir(&wait_workspace_id, &wait_thread_id)
            .unwrap_or_else(|_| PathBuf::from(""))
            .join(&wait_run_id);

        let _ = storage::write_json_file(
            &run_folder.join("metadata.json"),
            &serde_json::json!({
                "runId": wait_run_id,
                "threadId": wait_thread_id,
                "workspaceId": wait_workspace_id,
                "command": command_vec,
                "durationMs": duration_ms,
                "exitCode": exit_code,
                "startedAt": started_at,
                "endedAt": ended_at,
            }),
        );

        if let Ok(diff) = git_tools::capture_patch_diff(&wait_workspace_path) {
            let _ = fs::write(run_folder.join("patch.diff"), diff);
        }

        let _ =
            storage::set_latest_thread_run_id(&wait_workspace_id, &wait_thread_id, &wait_run_id);

        let output = fs::read(run_folder.join("output.log"))
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .unwrap_or_default();
        if !output.trim().is_empty() {
            let entry = TranscriptEntry {
                id: Uuid::new_v4().to_string(),
                role: "assistant".to_string(),
                content: output,
                created_at: Utc::now(),
                run_id: Some(metadata.run_id.clone()),
            };
            let _ = storage::append_transcript_entry(
                &metadata.workspace_id,
                &metadata.thread_id,
                &entry,
            );
        }

        let _ = app.emit(
            EXIT_EVENT,
            RunExitEvent {
                run_id: metadata.run_id,
                thread_id: metadata.thread_id,
                exit_code: metadata.exit_code,
                duration_ms,
            },
        );
    });

    Ok(RunClaudeResponse { run_id })
}

fn build_prompt(message: &str, context_text: &str, enabled_skills: &[(String, String)]) -> String {
    let mut sections = Vec::new();

    if !enabled_skills.is_empty() {
        let mut skills_section = String::from("## Enabled Skills\n");
        for (skill_name, content) in enabled_skills {
            skills_section.push_str(&format!("\n### Skill: {skill_name}\n{content}\n"));
        }
        sections.push(skills_section);
    }

    if !context_text.trim().is_empty() {
        sections.push(format!("## Context Pack\n{context_text}"));
    }

    sections.push(format!("## User Request\n{message}"));
    sections.join("\n\n")
}

fn spawn_stream_reader<R>(
    app: AppHandle,
    run_id: String,
    thread_id: String,
    stream: String,
    reader: R,
    output_file: Arc<Mutex<std::fs::File>>,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let chunk = format!("{line}\n");

            if let Ok(mut file) = output_file.lock() {
                let _ = file.write_all(chunk.as_bytes());
            }

            let event = StreamEvent {
                run_id: run_id.clone(),
                thread_id: thread_id.clone(),
                stream: stream.clone(),
                chunk,
            };
            let _ = app.emit(STREAM_EVENT, event);
        }
    })
}

pub async fn generate_commit_message(workspace_path: String, full_access: bool) -> Result<String> {
    let settings = storage::load_settings()?;
    let cli_path = detect_claude_cli_path(&settings)
        .ok_or_else(|| anyhow!("Claude CLI not found. Configure the CLI path in Settings."))?;

    let diff_summary = git_tools::get_git_diff_summary(&workspace_path)?;

    let prompt = format!(
        "You are generating a single concise git commit message. Use imperative mood.\n\nGit diff stat:\n{}\n\nGit diff:\n{}\n\nReturn only the commit message.",
        if diff_summary.stat.is_empty() {
            "(No changes detected)"
        } else {
            &diff_summary.stat
        },
        if diff_summary.diff_excerpt.is_empty() {
            "(No diff)"
        } else {
            &diff_summary.diff_excerpt
        }
    );

    let mut args = vec!["-p", &prompt];
    if full_access {
        args.push("--dangerously-skip-permissions");
    }

    let output = tokio::time::timeout(
        COMMIT_MESSAGE_TIMEOUT,
        Command::new(cli_path)
            .args(args)
            .current_dir(workspace_path)
            .output(),
    )
    .await
    .map_err(|_| {
        anyhow!(
            "Claude commit message generation timed out after {}s",
            COMMIT_MESSAGE_TIMEOUT.as_secs()
        )
    })??;

    if !output.status.success() {
        return Err(anyhow!(
            "Claude failed to generate commit message: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn ignores_launch_command_echo_when_detecting_ready_output() {
        let launch_command =
            "exec env TERM=xterm-256color NO_COLOR= claude --session-id '123e4567-e89b-12d3-a456-426614174000'";
        let mut probe = String::new();
        assert!(!chunk_has_non_echo_launch_output(
            &mut probe,
            "[dev@remote-host workspace]$ exec env TERM=xterm-256color NO_COLOR= claude --session-id '123e4567-e89b-12d3-a456-426614174000'\r",
            launch_command,
        ));
    }

    #[test]
    fn detects_non_echo_output_after_launch_command_echo() {
        let launch_command =
            "exec env TERM=xterm-256color NO_COLOR= claude --session-id '123e4567-e89b-12d3-a456-426614174000'";
        let mut probe = String::new();
        assert!(chunk_has_non_echo_launch_output(
            &mut probe,
            "[dev@remote-host workspace]$ exec env TERM=xterm-256color NO_COLOR= claude --session-id '123e4567-e89b-12d3-a456-426614174000'\r\nClaude Code v2.1.72\r\n",
            launch_command,
        ));
    }

    #[test]
    fn waits_for_remote_launch_echo_before_treating_output_as_ready() {
        let launch_command =
            "exec env TERM=xterm-256color NO_COLOR= claude --session-id '123e4567-e89b-12d3-a456-426614174000'";
        let mut dispatch_probe = String::new();
        let ssh_noise =
            "Starting ssh connection to remote-workspace/remote-host\r\nCould not request local forwarding.\r\n";

        assert!(
            !chunk_mentions_launch_command(&mut dispatch_probe, ssh_noise, launch_command),
            "ssh tunnel noise should not count as the remote launch echo"
        );

        assert!(chunk_mentions_launch_command(
            &mut dispatch_probe,
            "[dev@remote-host remote-workspace]$ exec env TERM=xterm-256color NO_COLOR= claude --session-id '123e4567-e89b-12d3-a456-426614174000'\r\n",
            launch_command,
        ));

        let mut output_probe = String::new();
        assert!(chunk_has_non_echo_launch_output(
            &mut output_probe,
            "Claude Code v2.1.72\r\n",
            launch_command,
        ));
    }

    #[test]
    fn input_chunk_submits_prompt_detects_regular_enter() {
        assert!(input_chunk_submits_prompt("ship it\r"));
    }

    #[test]
    fn input_chunk_submits_prompt_ignores_multiline_enter_escape() {
        assert!(!input_chunk_submits_prompt("\u{1b}\r"));
        assert!(!input_chunk_submits_prompt("draft\u{1b}\r"));
    }

    #[test]
    fn update_prompt_submit_buffer_ignores_whitespace_only_enter() {
        let mut buffer = String::new();
        assert!(!update_prompt_submit_buffer(&mut buffer, "   "));
        assert!(!update_prompt_submit_buffer(&mut buffer, "\r"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn update_prompt_submit_buffer_tracks_non_empty_submit_across_chunks() {
        let mut buffer = String::new();
        assert!(!update_prompt_submit_buffer(&mut buffer, "ship"));
        assert!(update_prompt_submit_buffer(&mut buffer, " it\r"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn detects_claude_turn_completion_from_end_turn_text_message() {
        let entry: ClaudeJsonlEntry = serde_json::from_str(
            r#"{
                "type":"assistant",
                "message":{
                    "role":"assistant",
                    "stop_reason":"end_turn",
                    "content":[{"type":"text","text":"Done."}]
                },
                "timestamp":"1970-01-01T00:00:00Z"
            }"#,
        )
        .expect("fixture should parse");

        assert_eq!(
            classify_claude_turn_completion_entry(&entry),
            Some(ClaudeTurnCompletion {
                status: "Succeeded",
                has_meaningful_output: true,
                completed_at_ms: 0,
            })
        );
    }

    #[test]
    fn ignores_intermediate_assistant_tool_use_messages_for_turn_completion() {
        let entry: ClaudeJsonlEntry = serde_json::from_str(
            r#"{
                "type":"assistant",
                "message":{
                    "role":"assistant",
                    "stop_reason":"tool_use",
                    "content":[{"type":"tool_use","name":"bash"}]
                }
            }"#,
        )
        .expect("fixture should parse");

        assert_eq!(classify_claude_turn_completion_entry(&entry), None);
    }

    #[test]
    fn ignores_assistant_text_without_terminal_stop_reason() {
        let entry: ClaudeJsonlEntry = serde_json::from_str(
            r#"{
                "type":"assistant",
                "message":{
                    "role":"assistant",
                    "content":[{"type":"text","text":"Checking..."},{"type":"tool_use","name":"bash"}]
                }
            }"#,
        )
        .expect("fixture should parse");

        assert_eq!(classify_claude_turn_completion_entry(&entry), None);
    }

    #[test]
    fn treats_no_response_requested_stop_sequence_as_non_meaningful_success() {
        let entry: ClaudeJsonlEntry = serde_json::from_str(
            r#"{
                "type":"assistant",
                "message":{
                    "role":"assistant",
                    "stop_reason":"stop_sequence",
                    "content":[{"type":"text","text":"No response requested."}]
                },
                "timestamp":"1970-01-01T00:00:00Z"
            }"#,
        )
        .expect("fixture should parse");

        assert_eq!(
            classify_claude_turn_completion_entry(&entry),
            Some(ClaudeTurnCompletion {
                status: "Succeeded",
                has_meaningful_output: false,
                completed_at_ms: 0,
            })
        );
    }

    #[test]
    fn treats_api_error_stop_sequence_as_failed_meaningful_output() {
        let entry: ClaudeJsonlEntry = serde_json::from_str(
            r#"{
                "type":"assistant",
                "message":{
                    "role":"assistant",
                    "stop_reason":"stop_sequence",
                    "content":[{"type":"text","text":"API Error: request failed"}]
                },
                "timestamp":"1970-01-01T00:00:00Z"
            }"#,
        )
        .expect("fixture should parse");

        assert_eq!(
            classify_claude_turn_completion_entry(&entry),
            Some(ClaudeTurnCompletion {
                status: "Failed",
                has_meaningful_output: true,
                completed_at_ms: 0,
            })
        );
    }

    #[test]
    fn treats_prompt_too_long_stop_sequence_as_failed_meaningful_output() {
        let entry: ClaudeJsonlEntry = serde_json::from_str(
            r#"{
                "type":"assistant",
                "message":{
                    "role":"assistant",
                    "stop_reason":"stop_sequence",
                    "content":[{"type":"text","text":"Prompt is too long for this model"}]
                },
                "timestamp":"1970-01-01T00:00:00Z"
            }"#,
        )
        .expect("fixture should parse");

        assert_eq!(
            classify_claude_turn_completion_entry(&entry),
            Some(ClaudeTurnCompletion {
                status: "Failed",
                has_meaningful_output: true,
                completed_at_ms: 0,
            })
        );
    }

    #[test]
    fn latest_claude_turn_completion_after_returns_newer_completion_only() {
        let dir = std::env::temp_dir().join(format!(
            "atcontroller-turn-completion-after-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Older\"}]},\"timestamp\":\"1970-01-01T00:00:01Z\"}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Newer\"}]},\"timestamp\":\"1970-01-01T00:00:02Z\"}\n"
            ),
        )
        .expect("should write jsonl");

        assert_eq!(
            latest_claude_turn_completion_after(&path, 1_500),
            Some(ClaudeTurnCompletion {
                status: "Succeeded",
                has_meaningful_output: true,
                completed_at_ms: 2_000,
            })
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_claude_turn_completion_after_returns_none_when_no_newer_completion_exists() {
        let dir = std::env::temp_dir().join(format!(
            "atcontroller-turn-completion-none-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Older\"}]},\"timestamp\":\"1970-01-01T00:00:01Z\"}\n",
        )
        .expect("should write jsonl");

        assert_eq!(latest_claude_turn_completion_after(&path, 1_000), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_qualifying_claude_turn_completion_returns_latest_qualifying_summary() {
        let dir = std::env::temp_dir().join(format!(
            "atcontroller-turn-completion-summary-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Useful\"}]},\"timestamp\":\"1970-01-01T00:00:01Z\"}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"stop_sequence\",\"content\":[{\"type\":\"text\",\"text\":\"No response requested.\"}]},\"timestamp\":\"1970-01-01T00:00:02Z\"}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"stop_sequence\",\"content\":[{\"type\":\"text\",\"text\":\"API Error: network\"}]},\"timestamp\":\"1970-01-01T00:00:03Z\"}\n"
            ),
        )
        .expect("should write jsonl");

        assert_eq!(
            latest_qualifying_claude_turn_completion(&path, "session-123"),
            Some(ClaudeTurnCompletionSummary {
                claude_session_id: "session-123".to_string(),
                completion_index: 2,
                completed_at_ms: 3_000,
                status: "Failed".to_string(),
                has_meaningful_output: true,
            })
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_qualifying_claude_turn_completion_ignores_no_response_requested() {
        let dir = std::env::temp_dir().join(format!(
            "atcontroller-turn-completion-no-response-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"stop_sequence\",\"content\":[{\"type\":\"text\",\"text\":\"No response requested.\"}]},\"timestamp\":\"1970-01-01T00:00:01Z\"}\n",
        )
        .expect("should write jsonl");

        assert_eq!(
            latest_qualifying_claude_turn_completion(&path, "session-456"),
            None
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_qualifying_claude_turn_completion_keeps_failed_turns_without_meaningful_output() {
        let dir = std::env::temp_dir().join(format!(
            "atcontroller-turn-completion-failed-summary-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("session.jsonl");
        fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"stop_sequence\",\"content\":[{\"type\":\"text\",\"text\":\"Prompt is too long\"}]},\"timestamp\":\"1970-01-01T00:00:01Z\"}\n",
        )
        .expect("should write jsonl");

        assert_eq!(
            latest_qualifying_claude_turn_completion(&path, "session-789"),
            Some(ClaudeTurnCompletionSummary {
                claude_session_id: "session-789".to_string(),
                completion_index: 1,
                completed_at_ms: 1_000,
                status: "Failed".to_string(),
                has_meaningful_output: true,
            })
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_log_snapshot_returns_full_small_logs() {
        let dir =
            std::env::temp_dir().join(format!("atcontroller-runner-log-small-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("output.log");

        fs::write(&path, "line 1\nline 2\n").expect("should write fixture log");
        let snapshot = read_log_snapshot(&path).expect("should read snapshot");
        assert_eq!(snapshot, ("line 1\nline 2\n".to_string(), false));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_log_snapshot_truncates_large_logs() {
        let dir =
            std::env::temp_dir().join(format!("atcontroller-runner-log-large-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("should create temp dir");
        let path = dir.join("output.log");

        let mut file = File::create(&path).expect("should create fixture log");
        for index in 0..120_000 {
            let _ = writeln!(file, "line-{index:05}");
        }

        let snapshot = read_log_snapshot(&path).expect("should read snapshot");
        assert!(snapshot.1, "snapshot should mark truncation");
        assert!(
            snapshot.0.contains("line-"),
            "snapshot should include log content"
        );
        assert!(
            !snapshot.0.contains("line-00000"),
            "snapshot should contain only the tail and exclude earliest lines"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn terminal_get_last_log_prefers_latest_run_pointer_when_available() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-runner-latest-run-pointer-{}",
            Uuid::new_v4()
        ));
        let app_support_root = temp_root.join("app-support");
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("should create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &app_support_root);

        let workspace = storage::add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be stored");
        let thread =
            storage::create_thread(&workspace.id, None, false).expect("thread should be created");
        let runs_dir =
            storage::runs_dir(&workspace.id, &thread.id).expect("runs dir should resolve");
        fs::create_dir_all(&runs_dir).expect("runs dir should exist");

        let preferred_run_id = Uuid::new_v4().to_string();
        let newer_modified_run_id = Uuid::new_v4().to_string();
        let preferred_run_dir = runs_dir.join(&preferred_run_id);
        let newer_modified_run_dir = runs_dir.join(&newer_modified_run_id);
        fs::create_dir_all(&preferred_run_dir).expect("preferred run dir should exist");
        fs::create_dir_all(&newer_modified_run_dir).expect("newer run dir should exist");
        fs::write(preferred_run_dir.join("output.log"), "preferred output\n")
            .expect("preferred log should write");

        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(
            newer_modified_run_dir.join("output.log"),
            "newer modified output\n",
        )
        .expect("newer log should write");

        storage::set_latest_thread_run_id(&workspace.id, &thread.id, &preferred_run_id)
            .expect("latest run pointer should write");

        let snapshot =
            terminal_get_last_log(&workspace.id, &thread.id).expect("snapshot should load");
        assert_eq!(snapshot.text, "preferred output\n");

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn terminal_get_last_log_falls_back_when_latest_run_pointer_is_stale() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-runner-latest-run-fallback-{}",
            Uuid::new_v4()
        ));
        let app_support_root = temp_root.join("app-support");
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("should create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &app_support_root);

        let workspace = storage::add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be stored");
        let thread =
            storage::create_thread(&workspace.id, None, false).expect("thread should be created");
        let runs_dir =
            storage::runs_dir(&workspace.id, &thread.id).expect("runs dir should resolve");
        fs::create_dir_all(&runs_dir).expect("runs dir should exist");

        let older_run_id = Uuid::new_v4().to_string();
        let newer_run_id = Uuid::new_v4().to_string();
        let older_run_dir = runs_dir.join(&older_run_id);
        let newer_run_dir = runs_dir.join(&newer_run_id);
        fs::create_dir_all(&older_run_dir).expect("older run dir should exist");
        fs::create_dir_all(&newer_run_dir).expect("newer run dir should exist");
        fs::write(older_run_dir.join("output.log"), "older output\n")
            .expect("older log should write");

        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(newer_run_dir.join("output.log"), "newer output\n")
            .expect("newer log should write");

        storage::set_latest_thread_run_id(&workspace.id, &thread.id, &Uuid::new_v4().to_string())
            .expect("stale latest run pointer should still write");

        let snapshot =
            terminal_get_last_log(&workspace.id, &thread.id).expect("snapshot should load");
        assert_eq!(snapshot.text, "newer output\n");

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn sanitize_env_diagnostics_stdout_redacts_sensitive_env_keys() {
        let raw = "PATH=/usr/bin\nAPI_TOKEN=super-secret\nSESSION_ID=abc123\n---\nwhich claude\nAPI_TOKEN=after-separator\n";
        let sanitized = sanitize_env_diagnostics_stdout(raw);

        assert!(sanitized.contains("PATH=/usr/bin"));
        assert!(sanitized.contains("API_TOKEN=<redacted>"));
        assert!(sanitized.contains("SESSION_ID=<redacted>"));
        assert!(sanitized.contains("---\nwhich claude\nAPI_TOKEN=after-separator"));
    }

    #[test]
    fn sanitize_claude_project_dir_name_matches_cli_storage_shape() {
        assert_eq!(
            sanitize_claude_project_dir_name("/private/tmp/atcontroller-smoke-secondary"),
            "-private-tmp-atcontroller-smoke-secondary"
        );
        assert_eq!(
            sanitize_claude_project_dir_name("/Users/you/project-root"),
            "-Users-you-project-root"
        );
    }

    #[test]
    fn discover_importable_claude_sessions_reads_sessions_index() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-import-discovery-{}", Uuid::new_v4()));
        let app_support_root = temp_root.join("app-support");
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-one");
        fs::create_dir_all(&workspace_path).expect("should create workspace fixture");
        fs::create_dir_all(&projects_root).expect("should create projects root");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &app_support_root);
        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let workspace = storage::add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be stored");
        let project_dir = projects_root.join(claude_project_dir_for_workspace(
            workspace_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&project_dir).expect("should create claude project dir");
        fs::write(
            project_dir.join("sessions-index.json"),
            format!(
                r#"{{
  "version": 1,
  "originalPath": "{}",
  "entries": [
    {{
      "sessionId": "session-older",
      "summary": "Older summary",
      "firstPrompt": "older prompt",
      "messageCount": 4,
      "created": "2026-03-10T10:00:00Z",
      "modified": "2026-03-10T11:00:00Z",
      "gitBranch": "feature/older",
      "projectPath": "{}"
    }},
    {{
      "sessionId": "session-newer",
      "summary": "Newer summary",
      "firstPrompt": "newer prompt",
      "messageCount": 7,
      "created": "2026-03-11T10:00:00Z",
      "modified": "2026-03-11T12:00:00Z",
      "gitBranch": "feature/newer",
      "projectPath": "{}"
    }}
  ]
}}"#,
                workspace_path.to_string_lossy(),
                workspace_path.to_string_lossy(),
                workspace_path.to_string_lossy()
            ),
        )
        .expect("should write sessions index");

        let discovered = discover_importable_claude_sessions().expect("discovery should succeed");
        assert_eq!(discovered.len(), 1);
        let project = &discovered[0];
        assert_eq!(project.path, workspace.path);
        assert_eq!(project.workspace_id.as_deref(), Some(workspace.id.as_str()));
        assert_eq!(
            project.workspace_name.as_deref(),
            Some(workspace.name.as_str())
        );
        assert_eq!(
            project
                .sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-newer", "session-older"]
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn discover_importable_claude_sessions_falls_back_to_jsonl() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-import-discovery-jsonl-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-two");
        fs::create_dir_all(&workspace_path).expect("should create workspace fixture");
        fs::create_dir_all(&projects_root).expect("should create projects root");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let project_dir = projects_root.join("fallback-project");
        fs::create_dir_all(&project_dir).expect("should create claude project dir");
        fs::write(
            project_dir.join("11111111-1111-1111-1111-111111111111.jsonl"),
            format!(
                concat!(
                    "{{\"cwd\":\"{}\",\"sessionId\":\"11111111-1111-1111-1111-111111111111\",\"gitBranch\":\"feature/jsonl\",\"type\":\"progress\",\"timestamp\":\"2026-03-11T12:00:00Z\"}}\n",
                    "{{\"cwd\":\"{}\",\"sessionId\":\"11111111-1111-1111-1111-111111111111\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"review this diff\"}},\"timestamp\":\"2026-03-11T12:05:00Z\"}}\n"
                ),
                workspace_path.to_string_lossy(),
                workspace_path.to_string_lossy()
            ),
        )
        .expect("should write jsonl session");

        let discovered = discover_importable_claude_sessions().expect("discovery should succeed");
        assert_eq!(discovered.len(), 1);
        let project = &discovered[0];
        assert_eq!(
            project.path,
            canonicalize_path_or_original(workspace_path.to_string_lossy().as_ref())
        );
        assert!(project.workspace_id.is_none());
        assert_eq!(project.sessions.len(), 1);
        assert_eq!(
            project.sessions[0].session_id,
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(
            project.sessions[0].first_prompt.as_deref(),
            Some("review this diff")
        );
        assert_eq!(
            project.sessions[0].git_branch.as_deref(),
            Some("feature/jsonl")
        );

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn discover_importable_claude_sessions_maps_worktree_project_back_to_repo_workspace() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-import-discovery-worktree-overlay-{}",
            Uuid::new_v4()
        ));
        let app_support_root = temp_root.join("app-support");
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let worktree_path = workspace_path.join(".claude/worktrees/feature-auth");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");
        fs::create_dir_all(&projects_root).expect("should create projects root");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &app_support_root);
        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        StdCommand::new("git")
            .arg("init")
            .current_dir(&workspace_path)
            .output()
            .expect("should initialize git repo");
        StdCommand::new("git")
            .args(["config", "user.name", "ATController"])
            .current_dir(&workspace_path)
            .output()
            .expect("should configure git user name");
        StdCommand::new("git")
            .args(["config", "user.email", "atcontroller@example.com"])
            .current_dir(&workspace_path)
            .output()
            .expect("should configure git user email");
        fs::write(workspace_path.join("README.md"), "root\n").expect("should write repo file");
        StdCommand::new("git")
            .args(["add", "README.md"])
            .current_dir(&workspace_path)
            .output()
            .expect("should stage repo file");
        StdCommand::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(&workspace_path)
            .output()
            .expect("should commit repo file");
        StdCommand::new("git")
            .args([
                "worktree",
                "add",
                worktree_path.to_string_lossy().as_ref(),
                "-b",
                "feature-auth",
            ])
            .current_dir(&workspace_path)
            .output()
            .expect("should create linked worktree");

        let workspace = storage::add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be stored");
        let project_dir = projects_root.join(claude_project_dir_for_workspace(
            worktree_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&project_dir).expect("should create worktree project dir");
        fs::write(
            project_dir.join("44444444-4444-4444-4444-444444444444.jsonl"),
            format!(
                concat!(
                    "{{\"cwd\":\"{}\",\"sessionId\":\"44444444-4444-4444-4444-444444444444\",\"gitBranch\":\"feature-auth\",\"type\":\"progress\",\"timestamp\":\"2026-03-24T12:00:00Z\"}}\n",
                    "{{\"cwd\":\"{}\",\"sessionId\":\"44444444-4444-4444-4444-444444444444\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"review worktree\"}},\"timestamp\":\"2026-03-24T12:05:00Z\"}}\n"
                ),
                worktree_path.to_string_lossy(),
                worktree_path.to_string_lossy()
            ),
        )
        .expect("should write worktree jsonl");

        let discovered = discover_importable_claude_sessions().expect("discovery should succeed");
        assert_eq!(discovered.len(), 1);
        let project = &discovered[0];
        assert_eq!(project.path, workspace.path);
        assert_eq!(project.workspace_id.as_deref(), Some(workspace.id.as_str()));

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn normalize_importable_project_path_preserves_main_worktree_subdirectory() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-import-normalize-subdir-{}",
            Uuid::new_v4()
        ));
        let workspace_root = temp_root.join("workspace-root");
        let subdir_path = workspace_root.join("packages/api");
        fs::create_dir_all(&subdir_path).expect("should create workspace subdirectory");

        StdCommand::new("git")
            .arg("init")
            .current_dir(&workspace_root)
            .output()
            .expect("should initialize git repo");
        StdCommand::new("git")
            .args(["config", "user.name", "ATController"])
            .current_dir(&workspace_root)
            .output()
            .expect("should configure git user name");
        StdCommand::new("git")
            .args(["config", "user.email", "atcontroller@example.com"])
            .current_dir(&workspace_root)
            .output()
            .expect("should configure git user email");
        fs::write(workspace_root.join("README.md"), "root\n").expect("should write repo file");
        StdCommand::new("git")
            .args(["add", "README.md"])
            .current_dir(&workspace_root)
            .output()
            .expect("should stage repo file");
        StdCommand::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(&workspace_root)
            .output()
            .expect("should commit repo file");

        let normalized = normalize_importable_project_path(subdir_path.to_string_lossy().as_ref());
        let expected = canonicalize_path_or_original(subdir_path.to_string_lossy().as_ref());
        assert_eq!(normalized, expected);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn normalize_importable_project_path_collapses_removed_worktree_path_to_repo_workspace() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-import-normalize-dead-worktree-{}",
            Uuid::new_v4()
        ));
        let workspace_root = temp_root.join("workspace-root");
        fs::create_dir_all(&workspace_root).expect("should create workspace root");

        StdCommand::new("git")
            .arg("init")
            .current_dir(&workspace_root)
            .output()
            .expect("should initialize git repo");

        let removed_worktree_path = workspace_root.join(".claude/worktrees/feature-auth");
        let normalized =
            normalize_importable_project_path(removed_worktree_path.to_string_lossy().as_ref());
        let expected = canonicalize_path_or_original(workspace_root.to_string_lossy().as_ref());
        assert_eq!(normalized, expected);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resolve_terminal_workspace_context_path_collapses_removed_worktree_path_to_repo_workspace() {
        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-terminal-context-dead-worktree-{}",
            Uuid::new_v4()
        ));
        let workspace_root = temp_root.join("workspace-root");
        fs::create_dir_all(&workspace_root).expect("should create workspace root");

        let removed_worktree_path = workspace_root.join(".claude/worktrees/feature-auth");
        let resolved = resolve_terminal_workspace_context_path(
            removed_worktree_path.to_string_lossy().as_ref(),
        );
        let expected = canonicalize_path_or_original(workspace_root.to_string_lossy().as_ref());
        assert_eq!(resolved, expected);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn latest_claude_session_cwd_reads_latest_jsonl_cwd() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-session-cwd-{}", Uuid::new_v4()));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let worktree_path = workspace_path.join(".claude/worktrees/feature1");
        fs::create_dir_all(&projects_root).expect("should create projects root");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");
        fs::create_dir_all(&worktree_path).expect("should create worktree path");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let claude_session_id = "11111111-1111-1111-1111-111111111111";
        let project_dir = projects_root.join(claude_project_dir_for_workspace(
            workspace_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&project_dir).expect("should create project dir");
        fs::write(
            project_dir.join(format!("{claude_session_id}.jsonl")),
            format!(
                concat!(
                    "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"progress\",\"timestamp\":\"2026-03-21T12:00:00Z\"}}\n",
                    "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"done\"}},\"timestamp\":\"2026-03-21T12:05:00Z\"}}\n"
                ),
                workspace_path.to_string_lossy(),
                claude_session_id,
                worktree_path.to_string_lossy(),
                claude_session_id
            ),
        )
        .expect("should write jsonl");

        let latest_cwd = latest_claude_session_cwd(
            workspace_path.to_string_lossy().to_string(),
            claude_session_id.to_string(),
        )
        .expect("lookup should succeed");

        let expected_cwd = canonicalize_path_or_original(worktree_path.to_string_lossy().as_ref());
        assert_eq!(latest_cwd.as_deref(), Some(expected_cwd.as_str()));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn latest_claude_session_cwd_falls_back_to_session_project_dir() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-session-cwd-fallback-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let worktree_path = workspace_path.join(".claude/worktrees/feature1");
        fs::create_dir_all(&projects_root).expect("should create projects root");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");
        fs::create_dir_all(&worktree_path).expect("should create worktree path");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let claude_session_id = "22222222-2222-2222-2222-222222222222";
        let project_dir = projects_root.join(claude_project_dir_for_workspace(
            worktree_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&project_dir).expect("should create worktree project dir");
        fs::write(
            project_dir.join(format!("{claude_session_id}.jsonl")),
            format!(
                concat!(
                    "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"progress\",\"timestamp\":\"2026-03-24T12:00:00Z\"}}\n",
                    "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"done\"}},\"timestamp\":\"2026-03-24T12:05:00Z\"}}\n"
                ),
                workspace_path.to_string_lossy(),
                claude_session_id,
                worktree_path.to_string_lossy(),
                claude_session_id
            ),
        )
        .expect("should write fallback jsonl");

        let latest_cwd = latest_claude_session_cwd(
            workspace_path.to_string_lossy().to_string(),
            claude_session_id.to_string(),
        )
        .expect("lookup should succeed");

        let expected_cwd = canonicalize_path_or_original(worktree_path.to_string_lossy().as_ref());
        assert_eq!(latest_cwd.as_deref(), Some(expected_cwd.as_str()));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn latest_claude_session_cwd_falls_back_to_workspace_when_worktree_path_is_gone() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-session-cwd-removed-worktree-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let removed_worktree_path = workspace_path.join(".claude/worktrees/feature1");
        fs::create_dir_all(&projects_root).expect("should create projects root");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");

        StdCommand::new("git")
            .arg("init")
            .current_dir(&workspace_path)
            .output()
            .expect("should initialize git repo");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let claude_session_id = "deadbeef-dead-beef-dead-beefdeadbeef";
        let project_dir = projects_root.join(claude_project_dir_for_workspace(
            removed_worktree_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&project_dir).expect("should create worktree project dir");
        fs::write(
            project_dir.join(format!("{claude_session_id}.jsonl")),
            format!(
                "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"done\"}},\"timestamp\":\"2026-03-24T12:05:00Z\"}}\n",
                removed_worktree_path.to_string_lossy(),
                claude_session_id
            ),
        )
        .expect("should write worktree jsonl");

        let latest_cwd = latest_claude_session_cwd(
            workspace_path.to_string_lossy().to_string(),
            claude_session_id.to_string(),
        )
        .expect("lookup should succeed");

        let expected_cwd = canonicalize_path_or_original(workspace_path.to_string_lossy().as_ref());
        assert_eq!(latest_cwd.as_deref(), Some(expected_cwd.as_str()));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn latest_claude_session_cwd_prefers_real_jsonl_over_index_only_match() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-session-cwd-index-fallback-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let worktree_path = workspace_path.join(".claude/worktrees/feature1");
        fs::create_dir_all(&projects_root).expect("should create projects root");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");
        fs::create_dir_all(&worktree_path).expect("should create worktree path");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let claude_session_id = "33333333-3333-3333-3333-333333333333";

        let stale_project_dir = projects_root.join("stale-index-project");
        fs::create_dir_all(&stale_project_dir).expect("should create stale project dir");
        fs::write(
            stale_project_dir.join("sessions-index.json"),
            format!(
                r#"{{
  "version": 1,
  "entries": [
    {{
      "sessionId": "{claude_session_id}",
      "summary": "stale reference"
    }}
  ]
}}"#
            ),
        )
        .expect("should write stale index");

        let real_project_dir = projects_root.join(claude_project_dir_for_workspace(
            worktree_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&real_project_dir).expect("should create real project dir");
        fs::write(
            real_project_dir.join(format!("{claude_session_id}.jsonl")),
            format!(
                "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"done\"}},\"timestamp\":\"2026-03-24T12:05:00Z\"}}\n",
                worktree_path.to_string_lossy(),
                claude_session_id
            ),
        )
        .expect("should write real jsonl");

        let latest_cwd = latest_claude_session_cwd(
            workspace_path.to_string_lossy().to_string(),
            claude_session_id.to_string(),
        )
        .expect("lookup should succeed");

        let expected_cwd = canonicalize_path_or_original(worktree_path.to_string_lossy().as_ref());
        assert_eq!(latest_cwd.as_deref(), Some(expected_cwd.as_str()));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resumed_session_requires_session_id_launch_for_cross_project_cwd() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-session-launch-mode-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let worktree_path = workspace_path.join(".claude/worktrees/feature1");
        fs::create_dir_all(&projects_root).expect("should create projects root");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");
        fs::create_dir_all(&worktree_path).expect("should create worktree path");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let claude_session_id = "44444444-4444-4444-4444-444444444444";
        let workspace_project_dir = projects_root.join(claude_project_dir_for_workspace(
            workspace_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&workspace_project_dir).expect("should create workspace project dir");
        fs::write(
            workspace_project_dir.join(format!("{claude_session_id}.jsonl")),
            format!(
                "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"done\"}},\"timestamp\":\"2026-03-24T12:05:00Z\"}}\n",
                workspace_path.to_string_lossy(),
                claude_session_id
            ),
        )
        .expect("should write jsonl");

        let requires_session_id = resumed_session_requires_session_id_launch(
            workspace_path.to_string_lossy().as_ref(),
            worktree_path.to_string_lossy().as_ref(),
            claude_session_id,
        )
        .expect("lookup should succeed");

        assert!(requires_session_id);

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resumed_session_requires_session_id_launch_keeps_resume_for_missing_sessions() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-session-launch-mode-missing-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let worktree_path = workspace_path.join(".claude/worktrees/feature1");
        fs::create_dir_all(&projects_root).expect("should create projects root");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");
        fs::create_dir_all(&worktree_path).expect("should create worktree path");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let requires_session_id = resumed_session_requires_session_id_launch(
            workspace_path.to_string_lossy().as_ref(),
            worktree_path.to_string_lossy().as_ref(),
            "55555555-5555-5555-5555-555555555555",
        )
        .expect("lookup should succeed");

        assert!(!requires_session_id);

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resolve_thread_fork_candidate_ignores_known_children_and_prefers_oldest_remaining_match() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-fork-resolver-{}", Uuid::new_v4()));
        let projects_root = temp_root.join("projects");
        let project_dir = projects_root.join("fork-project");
        fs::create_dir_all(&project_dir).expect("should create project dir");
        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let parent_session_id = "11111111-1111-1111-1111-111111111111";
        let old_child_session_id = "22222222-2222-2222-2222-222222222222";
        let new_child_session_id = "33333333-3333-3333-3333-333333333333";
        fs::write(
            project_dir.join("sessions-index.json"),
            format!(
                r#"{{
  "version": 1,
  "entries": [
    {{ "sessionId": "{old_child_session_id}" }},
    {{ "sessionId": "{new_child_session_id}" }}
  ]
}}"#
            ),
        )
        .expect("should write sessions index");
        fs::write(
            project_dir.join(format!("{old_child_session_id}.jsonl")),
            format!(
                "{{\"sessionId\":\"{old_child_session_id}\",\"type\":\"progress\",\"forkedFrom\":{{\"sessionId\":\"{parent_session_id}\"}},\"timestamp\":\"2026-03-24T08:27:59Z\"}}\n"
            ),
        )
        .expect("should write old child jsonl");
        std::thread::sleep(Duration::from_millis(15));
        fs::write(
            project_dir.join(format!("{new_child_session_id}.jsonl")),
            format!(
                "{{\"sessionId\":\"{new_child_session_id}\",\"type\":\"progress\",\"forkedFrom\":{{\"sessionId\":\"{parent_session_id}\"}},\"timestamp\":\"2026-03-24T08:28:59Z\"}}\n"
            ),
        )
        .expect("should write new child jsonl");

        let resolved = resolve_thread_fork_candidate(
            parent_session_id.to_string(),
            vec![old_child_session_id.to_string()],
            None,
        )
        .expect("resolver should succeed");
        assert_eq!(resolved.as_deref(), Some(new_child_session_id));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resolve_thread_fork_candidate_filters_out_children_before_requested_at() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-fork-requested-at-{}", Uuid::new_v4()));
        let projects_root = temp_root.join("projects");
        let project_dir = projects_root.join("fork-project");
        fs::create_dir_all(&project_dir).expect("should create project dir");
        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let parent_session_id = "11111111-1111-1111-1111-111111111111";
        let first_child_session_id = "22222222-2222-2222-2222-222222222222";
        let second_child_session_id = "33333333-3333-3333-3333-333333333333";
        fs::write(
            project_dir.join("sessions-index.json"),
            format!(
                r#"{{
  "version": 1,
  "entries": [
    {{ "sessionId": "{first_child_session_id}" }},
    {{ "sessionId": "{second_child_session_id}" }}
  ]
}}"#
            ),
        )
        .expect("should write sessions index");
        fs::write(
            project_dir.join(format!("{first_child_session_id}.jsonl")),
            format!(
                "{{\"sessionId\":\"{first_child_session_id}\",\"type\":\"progress\",\"forkedFrom\":{{\"sessionId\":\"{parent_session_id}\"}},\"timestamp\":\"2026-03-24T08:27:59Z\"}}\n"
            ),
        )
        .expect("should write first child jsonl");
        let requested_after = "2026-03-24T08:28:00Z".to_string();
        fs::write(
            project_dir.join(format!("{second_child_session_id}.jsonl")),
            format!(
                "{{\"sessionId\":\"{second_child_session_id}\",\"type\":\"progress\",\"forkedFrom\":{{\"sessionId\":\"{parent_session_id}\"}},\"timestamp\":\"2026-03-24T08:28:59Z\"}}\n"
            ),
        )
        .expect("should write second child jsonl");

        let resolved = resolve_thread_fork_candidate(
            parent_session_id.to_string(),
            Vec::new(),
            Some(requested_after),
        )
        .expect("resolver should succeed");
        assert_eq!(resolved.as_deref(), Some(second_child_session_id));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resolve_thread_fork_candidate_considers_jsonl_not_yet_listed_in_sessions_index() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-fork-index-gap-{}", Uuid::new_v4()));
        let projects_root = temp_root.join("projects");
        let project_dir = projects_root.join("fork-project");
        fs::create_dir_all(&project_dir).expect("should create project dir");
        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let parent_session_id = "11111111-1111-1111-1111-111111111111";
        let indexed_child_session_id = "22222222-2222-2222-2222-222222222222";
        let new_child_session_id = "33333333-3333-3333-3333-333333333333";
        fs::write(
            project_dir.join("sessions-index.json"),
            format!(
                r#"{{
  "version": 1,
  "entries": [
    {{ "sessionId": "{indexed_child_session_id}" }}
  ]
}}"#
            ),
        )
        .expect("should write sessions index");
        fs::write(
            project_dir.join(format!("{indexed_child_session_id}.jsonl")),
            format!(
                "{{\"sessionId\":\"{indexed_child_session_id}\",\"type\":\"progress\",\"forkedFrom\":{{\"sessionId\":\"{parent_session_id}\"}},\"timestamp\":\"2026-03-24T08:27:59Z\"}}\n"
            ),
        )
        .expect("should write indexed child jsonl");
        fs::write(
            project_dir.join(format!("{new_child_session_id}.jsonl")),
            format!(
                "{{\"sessionId\":\"{new_child_session_id}\",\"type\":\"progress\",\"forkedFrom\":{{\"sessionId\":\"{parent_session_id}\"}},\"timestamp\":\"2026-03-24T08:28:59Z\"}}\n"
            ),
        )
        .expect("should write new child jsonl");

        let resolved = resolve_thread_fork_candidate(
            parent_session_id.to_string(),
            vec![indexed_child_session_id.to_string()],
            Some("2026-03-24T08:28:00Z".to_string()),
        )
        .expect("resolver should succeed");
        assert_eq!(resolved.as_deref(), Some(new_child_session_id));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resolve_thread_fork_candidate_detects_fork_session_clone_without_forked_from() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-fork-clone-{}", Uuid::new_v4()));
        let projects_root = temp_root.join("projects");
        let project_dir = projects_root.join("fork-project-clone");
        fs::create_dir_all(&project_dir).expect("should create project dir");
        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let parent_session_id = "11111111-1111-1111-1111-111111111111";
        let child_session_id = "22222222-2222-2222-2222-222222222222";
        fs::write(
            project_dir.join(format!("{parent_session_id}.jsonl")),
            concat!(
                "{\"sessionId\":\"11111111-1111-1111-1111-111111111111\",\"uuid\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",\"type\":\"progress\",\"timestamp\":\"2026-03-24T08:27:00Z\"}\n",
                "{\"sessionId\":\"11111111-1111-1111-1111-111111111111\",\"uuid\":\"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\",\"type\":\"user\",\"timestamp\":\"2026-03-24T08:27:05Z\"}\n",
                "{\"sessionId\":\"11111111-1111-1111-1111-111111111111\",\"uuid\":\"cccccccc-cccc-cccc-cccc-cccccccccccc\",\"type\":\"assistant\",\"timestamp\":\"2026-03-24T08:27:10Z\"}\n"
            ),
        )
        .expect("should write parent session jsonl");

        let requested_after = Utc::now().to_rfc3339();
        std::thread::sleep(Duration::from_millis(20));

        fs::write(
            project_dir.join(format!("{child_session_id}.jsonl")),
            concat!(
                "{\"type\":\"file-history-snapshot\",\"messageId\":\"m1\",\"snapshot\":{\"timestamp\":\"2026-03-24T08:27:11Z\"},\"isSnapshotUpdate\":false}\n",
                "{\"type\":\"file-history-snapshot\",\"messageId\":\"m2\",\"snapshot\":{\"timestamp\":\"2026-03-24T08:27:12Z\"},\"isSnapshotUpdate\":false}\n",
                "{\"type\":\"file-history-snapshot\",\"messageId\":\"m3\",\"snapshot\":{\"timestamp\":\"2026-03-24T08:27:13Z\"},\"isSnapshotUpdate\":false}\n",
                "{\"type\":\"file-history-snapshot\",\"messageId\":\"m4\",\"snapshot\":{\"timestamp\":\"2026-03-24T08:27:14Z\"},\"isSnapshotUpdate\":false}\n",
                "{\"type\":\"file-history-snapshot\",\"messageId\":\"m5\",\"snapshot\":{\"timestamp\":\"2026-03-24T08:27:15Z\"},\"isSnapshotUpdate\":false}\n",
                "{\"type\":\"file-history-snapshot\",\"messageId\":\"m6\",\"snapshot\":{\"timestamp\":\"2026-03-24T08:27:16Z\"},\"isSnapshotUpdate\":false}\n",
                "{\"sessionId\":\"22222222-2222-2222-2222-222222222222\",\"uuid\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",\"type\":\"progress\",\"timestamp\":\"2026-03-24T08:27:00Z\"}\n",
                "{\"sessionId\":\"22222222-2222-2222-2222-222222222222\",\"uuid\":\"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\",\"type\":\"user\",\"timestamp\":\"2026-03-24T08:27:05Z\"}\n",
                "{\"sessionId\":\"22222222-2222-2222-2222-222222222222\",\"uuid\":\"cccccccc-cccc-cccc-cccc-cccccccccccc\",\"type\":\"assistant\",\"timestamp\":\"2026-03-24T08:27:10Z\"}\n"
            ),
        )
        .expect("should write child fork-session clone jsonl");

        let resolved = resolve_thread_fork_candidate(
            parent_session_id.to_string(),
            Vec::new(),
            Some(requested_after),
        )
        .expect("resolver should succeed");
        assert_eq!(resolved.as_deref(), Some(child_session_id));

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn known_fork_child_session_ids_falls_back_to_jsonl_without_index() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-fork-resolver-jsonl-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let project_dir = projects_root.join("fork-project-jsonl");
        fs::create_dir_all(&project_dir).expect("should create project dir");
        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let parent_session_id = "44444444-4444-4444-4444-444444444444";
        let child_session_id = "55555555-5555-5555-5555-555555555555";
        fs::write(
            project_dir.join(format!("{child_session_id}.jsonl")),
            format!(
                concat!(
                    "{{\"sessionId\":\"{}\",\"type\":\"progress\",\"timestamp\":\"2026-03-24T08:30:00Z\"}}\n",
                    "{{\"sessionId\":\"{}\",\"type\":\"assistant\",\"forkedFrom\":{{\"sessionId\":\"{}\"}},\"timestamp\":\"2026-03-24T08:31:00Z\"}}\n"
                ),
                child_session_id,
                child_session_id,
                parent_session_id
            ),
        )
        .expect("should write child jsonl");

        let known_children =
            known_fork_child_session_ids(parent_session_id).expect("lookup should succeed");
        assert_eq!(known_children, vec![child_session_id.to_string()]);

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn validate_importable_claude_session_accepts_sessions_index_entries() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-validate-importable-session-index-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-index-only");
        fs::create_dir_all(&workspace_path).expect("should create workspace fixture");
        fs::create_dir_all(&projects_root).expect("should create projects root");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let project_dir = projects_root.join(claude_project_dir_for_workspace(
            workspace_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&project_dir).expect("should create claude project dir");
        fs::write(
            project_dir.join("sessions-index.json"),
            format!(
                r#"{{
  "version": 1,
  "originalPath": "{}",
  "entries": [
    {{
      "sessionId": "index-only-session",
      "summary": "Index only session",
      "projectPath": "{}"
    }}
  ]
}}"#,
                workspace_path.to_string_lossy(),
                workspace_path.to_string_lossy()
            ),
        )
        .expect("should write sessions index");

        validate_importable_claude_session(
            workspace_path.to_string_lossy().to_string(),
            "index-only-session".to_string(),
        )
        .expect("validation should accept indexed session");

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn validate_importable_claude_session_ignores_stale_index_only_matches_in_other_projects() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-validate-importable-session-stale-index-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        fs::create_dir_all(&workspace_path).expect("should create workspace fixture");
        fs::create_dir_all(&projects_root).expect("should create projects root");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        let stale_project_dir = projects_root.join("stale-index-project");
        fs::create_dir_all(&stale_project_dir).expect("should create stale project dir");
        fs::write(
            stale_project_dir.join("sessions-index.json"),
            r#"{
  "version": 1,
  "entries": [
    {
      "sessionId": "stale-index-only-session",
      "summary": "Stale index only"
    }
  ]
}"#,
        )
        .expect("should write stale sessions index");

        let error = validate_importable_claude_session(
            workspace_path.to_string_lossy().to_string(),
            "stale-index-only-session".to_string(),
        )
        .expect_err("stale index-only match should not validate as another workspace");

        assert!(
            error
                .to_string()
                .contains("No local Claude conversation was found"),
            "unexpected error: {error}"
        );

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn validate_importable_claude_session_accepts_same_repo_worktree_session() {
        let _guard = crate::storage::test_env_lock()
            .lock()
            .expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-validate-importable-session-worktree-overlay-{}",
            Uuid::new_v4()
        ));
        let projects_root = temp_root.join("projects");
        let workspace_path = temp_root.join("workspace-root");
        let worktree_path = workspace_path.join(".claude/worktrees/feature-auth");
        fs::create_dir_all(&workspace_path).expect("should create workspace root");
        fs::create_dir_all(&projects_root).expect("should create projects root");

        std::env::set_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT", &projects_root);

        StdCommand::new("git")
            .arg("init")
            .current_dir(&workspace_path)
            .output()
            .expect("should initialize git repo");
        StdCommand::new("git")
            .args(["config", "user.name", "ATController"])
            .current_dir(&workspace_path)
            .output()
            .expect("should configure git user name");
        StdCommand::new("git")
            .args(["config", "user.email", "atcontroller@example.com"])
            .current_dir(&workspace_path)
            .output()
            .expect("should configure git user email");
        fs::write(workspace_path.join("README.md"), "root\n").expect("should write repo file");
        StdCommand::new("git")
            .args(["add", "README.md"])
            .current_dir(&workspace_path)
            .output()
            .expect("should stage repo file");
        StdCommand::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(&workspace_path)
            .output()
            .expect("should commit repo file");
        StdCommand::new("git")
            .args([
                "worktree",
                "add",
                worktree_path.to_string_lossy().as_ref(),
                "-b",
                "feature-auth",
            ])
            .current_dir(&workspace_path)
            .output()
            .expect("should create linked worktree");

        let claude_session_id = "55555555-5555-5555-5555-555555555555";
        let project_dir = projects_root.join(claude_project_dir_for_workspace(
            worktree_path.to_string_lossy().as_ref(),
        ));
        fs::create_dir_all(&project_dir).expect("should create worktree project dir");
        fs::write(
            project_dir.join(format!("{claude_session_id}.jsonl")),
            format!(
                "{{\"cwd\":\"{}\",\"sessionId\":\"{}\",\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"done\"}},\"timestamp\":\"2026-03-24T12:05:00Z\"}}\n",
                worktree_path.to_string_lossy(),
                claude_session_id
            ),
        )
        .expect("should write worktree session jsonl");

        validate_importable_claude_session(
            workspace_path.to_string_lossy().to_string(),
            claude_session_id.to_string(),
        )
        .expect("validation should accept same-repo worktree session");

        std::env::remove_var("ATCONTROLLER_CLAUDE_PROJECTS_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn resolve_claude_command_for_rdev_uses_remote_binary() {
        let settings = Settings::default();
        let command = resolve_claude_command_for_workspace(WorkspaceKind::Rdev, &settings)
            .expect("rdev command should resolve");
        assert_eq!(command, "claude");
    }

    #[test]
    fn resolve_claude_command_for_ssh_uses_remote_binary() {
        let settings = Settings::default();
        let command = resolve_claude_command_for_workspace(WorkspaceKind::Ssh, &settings)
            .expect("ssh command should resolve");
        assert_eq!(command, "claude");
    }

    #[test]
    fn resolve_claude_command_for_local_uses_detected_path() {
        let tmp_dir =
            std::env::temp_dir().join(format!("atcontroller-cli-detect-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&tmp_dir).expect("should create temp directory");
        let cli_path = tmp_dir.join("claude");
        fs::write(&cli_path, "#!/bin/sh\nexit 0\n").expect("should create fake cli");

        let settings = Settings {
            claude_cli_path: Some(cli_path.to_string_lossy().to_string()),
            ..Settings::default()
        };
        let command = resolve_claude_command_for_workspace(WorkspaceKind::Local, &settings)
            .expect("local command should resolve");
        assert_eq!(command, cli_path.to_string_lossy());

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn build_claude_shell_command_supports_fork_session() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::Forked,
            false,
            false,
        );

        assert_eq!(
            claude_command,
            "env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --resume '123e4567-e89b-12d3-a456-426614174000' --fork-session"
        );
    }

    #[test]
    fn build_claude_shell_command_can_force_session_id_for_resumed_sessions() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::Resumed,
            true,
            true,
        );

        assert_eq!(
            claude_command,
            "env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000' --dangerously-skip-permissions"
        );
    }

    #[test]
    fn build_terminal_shell_command_defaults_rdev_to_non_tmux_post_connect_handoff() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::New,
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Rdev,
            Some("rdev ssh team/example-env"),
            None,
            Some("~/projects/ignored-for-rdev"),
            &claude_command,
        )
        .expect("rdev command should build");

        assert_eq!(shell_command, "rdev ssh team/example-env --non-tmux");
        assert_eq!(
            post_connect_command,
            Some(
                "exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
                    .to_string()
            )
        );
    }

    #[test]
    fn build_terminal_shell_command_preserves_explicit_tmux_mode() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::Resumed,
            true,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Rdev,
            Some("rdev ssh team/example-env --tmux"),
            None,
            Some("~/projects/ignored-for-rdev"),
            &claude_command,
        )
        .expect("rdev command should build");

        assert_eq!(shell_command, "rdev ssh team/example-env --tmux");
        assert_eq!(
            post_connect_command,
            Some(
                "exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --resume '123e4567-e89b-12d3-a456-426614174000' --dangerously-skip-permissions".to_string()
            )
        );
    }

    #[test]
    fn build_terminal_shell_command_for_ssh_dispatches_post_connect_handoff() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::New,
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh dev@remote-host"),
            Some("~/projects/example"),
            &claude_command,
        )
        .expect("ssh command should build");

        assert_eq!(shell_command, "ssh dev@remote-host");
        assert_eq!(
            post_connect_command,
            Some(
                "cd '~/projects/example' && exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
                    .to_string()
            )
        );
    }

    #[test]
    fn build_terminal_shell_command_for_ssh_skips_cd_when_remote_path_missing_or_empty() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::New,
            false,
            false,
        );

        let (_, without_path) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh dev@remote-host"),
            None,
            &claude_command,
        )
        .expect("ssh command without path should build");
        assert_eq!(
            without_path,
            Some(
                "exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
                    .to_string()
            )
        );

        let (_, with_empty_path) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh dev@remote-host"),
            Some("   "),
            &claude_command,
        )
        .expect("ssh command with empty path should build");
        assert_eq!(with_empty_path, without_path);
    }

    #[test]
    fn build_terminal_shell_command_for_ssh_placeholder_skips_remote_path_prefix() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::New,
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh dev@remote-host {CLAUDE_CMD}"),
            Some("~/projects/should-not-be-applied"),
            &claude_command,
        )
        .expect("ssh placeholder command should build");

        assert_eq!(
            shell_command,
            "ssh dev@remote-host exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
        );
        assert_eq!(post_connect_command, None);
    }

    #[test]
    fn build_terminal_shell_command_for_rdev_placeholder_skips_remote_path_prefix() {
        let claude_command = build_claude_shell_command(
            "/usr/local/bin/claude",
            "123e4567-e89b-12d3-a456-426614174000",
            TerminalSessionMode::New,
            false,
            false,
        );
        let (shell_command, post_connect_command) = build_terminal_shell_command(
            WorkspaceKind::Rdev,
            Some("rdev ssh team/example-env {CLAUDE_CMD}"),
            None,
            Some("~/projects/ignored-for-rdev"),
            &claude_command,
        )
        .expect("placeholder command should build");

        assert_eq!(
            shell_command,
            "rdev ssh team/example-env --non-tmux exec env TERM=xterm-256color COLORTERM=truecolor CLICOLOR=1 CLICOLOR_FORCE=1 FORCE_COLOR=1 '/usr/local/bin/claude' --session-id '123e4567-e89b-12d3-a456-426614174000'"
        );
        assert_eq!(post_connect_command, None);
    }

    #[test]
    fn strip_ansi_sequences_removes_osc_payloads() {
        let stripped =
            strip_ansi_sequences("\u{1b}]10;rgb:d8d8/e0e0/efef\u{7}\n[dev@host workspace]$ ");
        assert_eq!(stripped, "\n[dev@host workspace]$ ");
    }

    #[test]
    fn looks_like_shell_prompt_detects_remote_prompt() {
        assert!(looks_like_shell_prompt("[dev@remote-host workspace]$ "));
    }

    #[test]
    fn looks_like_shell_prompt_detects_unicode_arrow_prompt() {
        assert!(looks_like_shell_prompt("dev in workspace on main ❯ "));
    }

    #[test]
    fn looks_like_shell_prompt_ignores_rdev_bootstrap_lines() {
        assert!(!looks_like_shell_prompt(
            "Uploading auth token to rdev\nStarting ssh connection to team/example-env\n"
        ));
    }

    #[test]
    fn should_dispatch_post_connect_command_on_prompt_even_without_timeout() {
        assert!(should_dispatch_post_connect_command(
            "[dev@remote-host remote-workspace]$ ",
            false,
            Duration::from_secs(1),
        ));
    }

    #[test]
    fn should_dispatch_post_connect_command_on_unicode_prompt_even_without_timeout() {
        assert!(should_dispatch_post_connect_command(
            "dev in workspace on main ❯ ",
            false,
            Duration::from_secs(1),
        ));
    }

    #[test]
    fn should_not_dispatch_post_connect_command_before_timeout_without_prompt() {
        assert!(!should_dispatch_post_connect_command(
            "Starting ssh connection to remote-workspace/remote-host\n",
            true,
            Duration::from_secs(1),
        ));
    }

    #[test]
    fn should_dispatch_post_connect_command_after_timeout_when_ssh_started() {
        assert!(should_dispatch_post_connect_command(
            "Starting ssh connection to remote-workspace/remote-host\n",
            true,
            POST_CONNECT_COMMAND_AFTER_SSH_START_TIMEOUT + Duration::from_secs(1),
        ));
    }

    #[test]
    fn ssh_startup_auth_probe_stays_enabled_for_inline_ssh_launches() {
        assert!(should_probe_ssh_startup_auth(
            WorkspaceKind::Ssh,
            true,
            None,
            false,
            "dev@remote-host's password: "
        ));
    }

    #[test]
    fn ssh_startup_auth_probe_stops_after_ready() {
        assert!(!should_probe_ssh_startup_auth(
            WorkspaceKind::Ssh,
            true,
            None,
            true,
            "dev@remote-host's password: "
        ));
    }

    #[test]
    fn detects_password_auth_prompts_during_ssh_startup() {
        assert_eq!(
            detect_ssh_startup_block_reason("dev@remote-host's password: "),
            Some(SshStartupBlockReason::PasswordAuthUnsupported)
        );
    }

    #[test]
    fn detects_host_verification_prompts_during_ssh_startup() {
        assert_eq!(
            detect_ssh_startup_block_reason(
                "Are you sure you want to continue connecting (yes/no/[fingerprint])?"
            ),
            Some(SshStartupBlockReason::HostVerificationRequired)
        );
    }

    #[test]
    fn detects_interactive_auth_prompts_during_ssh_startup() {
        assert_eq!(
            detect_ssh_startup_block_reason(
                "Enter passphrase for key '/Users/you/.ssh/id_ed25519': "
            ),
            Some(SshStartupBlockReason::InteractiveAuthUnsupported)
        );
    }

    #[test]
    fn does_not_treat_mfa_policy_banner_text_as_interactive_auth_prompt() {
        assert_eq!(
            detect_ssh_startup_block_reason(
                "NOTICE: Multi-factor authentication is required for production hosts.\nContact support if you need a verification code for account recovery."
            ),
            None
        );
    }

    #[test]
    fn detects_mfa_passcode_prompts_during_ssh_startup() {
        assert_eq!(
            detect_ssh_startup_block_reason(
                "Enter a passcode or select one of the following options:"
            ),
            Some(SshStartupBlockReason::InteractiveAuthUnsupported)
        );
    }

    #[test]
    fn trim_hysteresis_no_trim_under_threshold() {
        let mut buf = TerminalOutputBuffer::new();
        // Fill to exactly 320_000 chars (the trigger threshold).
        // Trim fires only when text_len is STRICTLY greater than the threshold,
        // so 320_000 should not trigger a trim.
        let chunk = "a".repeat(320_000);
        buf.append(&chunk);
        assert_eq!(buf.text_len, 320_000);
        assert_eq!(buf.start_position, 0, "no trim should have occurred");
    }

    #[test]
    fn trim_hysteresis_trims_above_threshold() {
        let mut buf = TerminalOutputBuffer::new();
        // Push 320_001 chars — one above the threshold.
        let chunk = "a".repeat(320_001);
        buf.append(&chunk);
        // After trim, text_len should be approximately 240_000 (MAX - HYSTERESIS).
        assert!(buf.start_position > 0, "trim should have fired");
        let expected_target = TERMINAL_STREAM_TAIL_MAX_CHARS - TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS;
        assert!(
            buf.text_len <= expected_target,
            "text_len {} should be at most {}",
            buf.text_len,
            expected_target
        );
    }

    #[test]
    fn trim_hysteresis_stays_stable_until_threshold_exceeded_again() {
        let mut buf = TerminalOutputBuffer::new();
        // First, trigger a trim.
        let initial = "a".repeat(320_001);
        buf.append(&initial);
        let after_first_trim = buf.text_len;
        let start_after_first_trim = buf.start_position;
        assert!(start_after_first_trim > 0, "should have trimmed");

        // Append more data but not enough to exceed the threshold again.
        // We need to add enough to reach 320_000 but not exceed it.
        let headroom = (TERMINAL_STREAM_TAIL_MAX_CHARS + TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS)
            - after_first_trim;
        let safe_addition = "b".repeat(headroom as usize);
        buf.append(&safe_addition);
        assert_eq!(
            buf.start_position, start_after_first_trim,
            "no additional trim should fire at exactly the threshold"
        );

        // One more char tips it over — another trim fires.
        buf.append("c");
        assert!(
            buf.start_position > start_after_first_trim,
            "a second trim should fire after exceeding threshold again"
        );
    }
}
