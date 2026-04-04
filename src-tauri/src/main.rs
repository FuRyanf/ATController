#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git_tools;
mod macos_notifications;
mod models;
mod runner;
mod skills;
mod storage;

use std::sync::Arc;

use serde::Deserialize;
use tauri::{Manager, State};

use crate::models::{
    AppUpdateInfo, ContextPreview, FinalizedNativeFork, ForkThreadResult, GitBranchEntry,
    GitDiffSummary, GitInfo, GitPullForNewThreadResult, GitWorkspaceStatus,
    ImportableClaudeProject, ImportableClaudeSession, PreparedNativeFork, RunClaudeRequest,
    RunClaudeResponse, Settings, SkillInfo, TerminalStartResponse, ThreadMetadata, TranscriptEntry,
    Workspace, WorkspaceShellStartResponse,
};

struct AppState {
    runner: Arc<runner::RunnerState>,
}

const GITHUB_LATEST_RELEASE_API_URL: &str =
    "https://api.github.com/repos/FuRyanf/Claudex/releases/latest";

#[derive(Debug, Deserialize)]
struct GitHubLatestRelease {
    tag_name: String,
    html_url: Option<String>,
}

fn parse_semver_like(version: &str) -> Option<Vec<u64>> {
    let trimmed = version.trim().trim_start_matches('v');
    if trimmed.is_empty() {
        return None;
    }

    let mut parts = Vec::new();
    for segment in trimmed.split('.') {
        let digits: String = segment
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            return None;
        }
        parts.push(digits.parse().ok()?);
    }

    Some(parts)
}

fn is_version_newer(latest: &str, current: &str) -> bool {
    let Some(mut latest_parts) = parse_semver_like(latest) else {
        return false;
    };
    let Some(mut current_parts) = parse_semver_like(current) else {
        return false;
    };

    let length = latest_parts.len().max(current_parts.len());
    latest_parts.resize(length, 0);
    current_parts.resize(length, 0);

    latest_parts > current_parts
}

fn current_build_version() -> String {
    option_env!("CLAUDEX_BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .trim()
        .trim_start_matches('v')
        .to_string()
}

#[tauri::command]
fn get_app_storage_root() -> Result<String, String> {
    storage::ensure_base_dirs()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_workspaces() -> Result<Vec<Workspace>, String> {
    storage::load_workspaces().map_err(|error| error.to_string())
}

#[tauri::command]
fn add_workspace(path: String) -> Result<Workspace, String> {
    storage::add_workspace(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn add_ssh_workspace(
    ssh_command: String,
    display_name: Option<String>,
    remote_path: Option<String>,
) -> Result<Workspace, String> {
    storage::add_ssh_workspace(
        &ssh_command,
        display_name.as_deref(),
        remote_path.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_workspace_order(workspace_ids: Vec<String>) -> Result<Vec<Workspace>, String> {
    storage::set_workspace_order(workspace_ids).map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_workspace(state: State<'_, AppState>, workspace_id: String) -> Result<bool, String> {
    let workspace = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == workspace_id);

    if let Some(item) = workspace.as_ref() {
        state
            .runner
            .terminal_sessions
            .shutdown_for_workspace_id(&item.id)
            .map_err(|error| error.to_string())?;
    }

    storage::remove_workspace(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_workspace_git_pull_on_master_for_new_threads(
    workspace_id: String,
    enabled: bool,
) -> Result<Workspace, String> {
    storage::set_workspace_git_pull_on_master_for_new_threads(&workspace_id, enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_git_info(workspace_path: String) -> Result<Option<GitInfo>, String> {
    git_tools::get_git_info(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_git_diff_summary(workspace_path: String) -> Result<GitDiffSummary, String> {
    git_tools::get_git_diff_summary(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_list_branches(workspace_path: String) -> Result<Vec<GitBranchEntry>, String> {
    git_tools::list_branches(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_workspace_status(workspace_path: String) -> Result<GitWorkspaceStatus, String> {
    git_tools::workspace_status(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_checkout_branch(
    state: State<'_, AppState>,
    workspace_path: String,
    branch_name: String,
) -> Result<bool, String> {
    state
        .runner
        .terminal_sessions
        .shutdown_for_workspace_context(&workspace_path)
        .map_err(|error| error.to_string())?;
    git_tools::checkout_branch(&workspace_path, &branch_name)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn git_create_and_checkout_branch(
    state: State<'_, AppState>,
    workspace_path: String,
    branch_name: String,
) -> Result<bool, String> {
    state
        .runner
        .terminal_sessions
        .shutdown_for_workspace_context(&workspace_path)
        .map_err(|error| error.to_string())?;
    git_tools::create_and_checkout_branch(&workspace_path, &branch_name)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn git_auto_pull_on_master(workspace_path: String) -> Result<bool, String> {
    git_tools::auto_pull_on_master(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_pull_master_for_new_thread(
    workspace_path: String,
) -> Result<GitPullForNewThreadResult, String> {
    git_tools::git_pull_master_for_new_thread(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_threads(workspace_id: String) -> Result<Vec<ThreadMetadata>, String> {
    storage::list_threads(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_thread(
    workspace_id: String,
    agent_id: Option<String>,
    full_access: Option<bool>,
) -> Result<ThreadMetadata, String> {
    storage::create_thread(&workspace_id, agent_id, full_access.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_forked_thread(
    workspace_id: String,
    source_thread_id: String,
) -> Result<ThreadMetadata, String> {
    let workspace = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| "Workspace not found".to_string())?;
    if workspace.kind != crate::models::WorkspaceKind::Local {
        return Err("Thread forking is only supported for local workspaces".to_string());
    }

    let source_thread = storage::read_thread_metadata(&workspace_id, &source_thread_id)
        .map_err(|error| error.to_string())?;
    let source_claude_session_id = source_thread
        .claude_session_id
        .clone()
        .ok_or_else(|| "Source thread does not have a Claude session id".to_string())?;
    let known_child_session_ids = runner::known_fork_child_session_ids(&source_claude_session_id)
        .map_err(|error| error.to_string())?;

    storage::create_forked_thread(&workspace_id, &source_thread_id, known_child_session_ids)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn fork_thread_from_ui(
    workspace_id: String,
    source_thread_id: String,
    source_title: String,
    forked_title: String,
) -> Result<ForkThreadResult, String> {
    let workspace = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| "Workspace not found".to_string())?;
    if workspace.kind != crate::models::WorkspaceKind::Local {
        return Err("Thread forking is only supported for local workspaces".to_string());
    }

    let source_thread = storage::read_thread_metadata(&workspace_id, &source_thread_id)
        .map_err(|error| error.to_string())?;
    let source_claude_session_id = source_thread
        .claude_session_id
        .clone()
        .ok_or_else(|| "Source thread does not have a Claude session id".to_string())?;
    let known_child_session_ids = runner::known_fork_child_session_ids(&source_claude_session_id)
        .map_err(|error| error.to_string())?;

    storage::fork_thread_from_ui(
        &workspace_id,
        &source_thread_id,
        &source_title,
        &forked_title,
        known_child_session_ids,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_full_access(
    workspace_id: String,
    thread_id: String,
    full_access: bool,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_full_access(&workspace_id, &thread_id, full_access)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_thread_claude_session(
    workspace_id: String,
    thread_id: String,
) -> Result<ThreadMetadata, String> {
    storage::clear_thread_claude_session(&workspace_id, &thread_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_thread_pending_fork(
    workspace_id: String,
    thread_id: String,
) -> Result<ThreadMetadata, String> {
    storage::clear_thread_pending_fork(&workspace_id, &thread_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn mark_thread_pending_fork_consumed(
    workspace_id: String,
    thread_id: String,
) -> Result<ThreadMetadata, String> {
    storage::mark_thread_pending_fork_consumed(&workspace_id, &thread_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn commit_prepared_thread_pending_fork(
    workspace_id: String,
    thread_id: String,
    prepared: PreparedNativeFork,
) -> Result<ThreadMetadata, String> {
    storage::commit_prepared_thread_pending_fork(&workspace_id, &thread_id, &prepared)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_claude_session_id(
    workspace_id: String,
    thread_id: String,
    claude_session_id: String,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_claude_session_id(&workspace_id, &thread_id, &claude_session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_skills(
    workspace_id: String,
    thread_id: String,
    enabled_skills: Vec<String>,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_skills(&workspace_id, &thread_id, enabled_skills)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_agent(
    workspace_id: String,
    thread_id: String,
    agent_id: String,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_agent(&workspace_id, &thread_id, agent_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_thread(
    workspace_id: String,
    thread_id: String,
    title: String,
) -> Result<ThreadMetadata, String> {
    storage::rename_thread(&workspace_id, &thread_id, title).map_err(|error| error.to_string())
}

#[tauri::command]
fn archive_thread(workspace_id: String, thread_id: String) -> Result<ThreadMetadata, String> {
    storage::archive_thread(&workspace_id, &thread_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_thread(workspace_id: String, thread_id: String) -> Result<bool, String> {
    storage::delete_thread(&workspace_id, &thread_id)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn finalize_thread_native_fork(
    workspace_id: String,
    thread_id: String,
    child_claude_session_id: String,
) -> Result<FinalizedNativeFork, String> {
    storage::finalize_thread_native_fork(&workspace_id, &thread_id, &child_claude_session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn append_user_message(
    workspace_id: String,
    thread_id: String,
    content: String,
) -> Result<TranscriptEntry, String> {
    storage::append_user_message(&workspace_id, &thread_id, &content)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn load_transcript(
    workspace_id: String,
    thread_id: String,
) -> Result<Vec<TranscriptEntry>, String> {
    storage::load_transcript(&workspace_id, &thread_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_skills(workspace_path: String) -> Result<Vec<SkillInfo>, String> {
    skills::list_skills(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn build_context_preview(
    workspace_path: String,
    context_pack: String,
) -> Result<ContextPreview, String> {
    runner::build_context_preview(&workspace_path, &context_pack).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    storage::load_settings().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<Settings, String> {
    storage::save_settings(&settings)
        .map(|_| settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn detect_claude_cli_path() -> Result<Option<String>, String> {
    let settings = storage::load_settings().map_err(|error| error.to_string())?;
    Ok(runner::detect_claude_cli_path(&settings))
}

#[tauri::command]
fn check_for_update() -> Result<AppUpdateInfo, String> {
    let current_version = current_build_version();
    let output = std::process::Command::new("curl")
        .args([
            "-fsSL",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: Claudex",
            GITHUB_LATEST_RELEASE_API_URL,
        ])
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err("Failed to fetch latest release info".to_string());
    }

    let release: GitHubLatestRelease =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let latest_version = release.tag_name.trim().trim_start_matches('v').to_string();
    let update_available = is_version_newer(&latest_version, &current_version);

    Ok(AppUpdateInfo {
        current_version,
        latest_version: Some(latest_version),
        update_available,
        release_url: release.html_url,
    })
}

#[tauri::command]
async fn install_latest_update(app: tauri::AppHandle) -> Result<bool, String> {
    tokio::task::spawn_blocking(runner::install_latest_update)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    // Always relaunch the installed /Applications bundle so updates work even
    // when the current process was launched from an older app copy/location.
    let launch_status = std::process::Command::new("open")
        .args(["-n", "/Applications/Claudex.app"])
        .status()
        .map_err(|error| format!("Installed update, but failed to relaunch app: {error}"))?;
    if !launch_status.success() {
        return Err("Installed update, but failed to relaunch app from /Applications.".to_string());
    }

    app.exit(0);
    Ok(true)
}

#[tauri::command]
async fn run_claude(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: RunClaudeRequest,
) -> Result<RunClaudeResponse, String> {
    runner::run_claude(app, state.runner.clone(), request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cancel_run(state: State<'_, AppState>, run_id: String) -> Result<bool, String> {
    runner::cancel_run(state.runner.clone(), run_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn terminal_start_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_path: String,
    initial_cwd: Option<String>,
    env_vars: Option<std::collections::HashMap<String, String>>,
    full_access_flag: bool,
    thread_id: String,
) -> Result<TerminalStartResponse, String> {
    runner::terminal_start_session(
        app,
        state.runner.clone(),
        workspace_path,
        initial_cwd,
        env_vars,
        full_access_flag,
        thread_id,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn prepare_thread_native_fork(
    state: State<'_, AppState>,
    workspace_id: String,
    thread_id: String,
    terminal_session_id: String,
) -> Result<PreparedNativeFork, String> {
    runner::prepare_thread_native_fork(
        state.runner.clone(),
        workspace_id,
        thread_id,
        terminal_session_id,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn workspace_shell_start_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_path: String,
    initial_cwd: Option<String>,
    env_vars: Option<std::collections::HashMap<String, String>>,
) -> Result<WorkspaceShellStartResponse, String> {
    runner::workspace_shell_start_session(
        app,
        state.runner.clone(),
        workspace_path,
        initial_cwd,
        env_vars,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_write(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<bool, String> {
    runner::terminal_write(app, state.runner.clone(), session_id, data)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_rebind_claude_session(
    state: State<'_, AppState>,
    session_id: String,
    claude_session_id: String,
) -> Result<bool, String> {
    runner::terminal_rebind_claude_session(state.runner.clone(), session_id, claude_session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resolve_thread_fork_candidate(
    source_claude_session_id: String,
    known_child_session_ids: Vec<String>,
    requested_after: Option<String>,
) -> Result<Option<String>, String> {
    runner::resolve_thread_fork_candidate(
        source_claude_session_id,
        known_child_session_ids,
        requested_after,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    runner::terminal_resize(state.runner.clone(), session_id, cols, rows)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_kill(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    runner::terminal_kill(state.runner.clone(), session_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_send_signal(
    state: State<'_, AppState>,
    session_id: String,
    signal: String,
) -> Result<bool, String> {
    runner::terminal_send_signal(state.runner.clone(), session_id, signal)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_get_last_log(
    workspace_id: String,
    thread_id: String,
) -> Result<crate::models::TerminalOutputSnapshot, String> {
    runner::terminal_get_last_log(&workspace_id, &thread_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn latest_claude_session_cwd(
    workspace_path: String,
    claude_session_id: String,
) -> Result<Option<String>, String> {
    runner::latest_claude_session_cwd(workspace_path, claude_session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_read_output(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::models::TerminalOutputSnapshot, String> {
    runner::terminal_read_output(state.runner.clone(), session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn generate_commit_message(
    workspace_path: String,
    full_access: bool,
) -> Result<String, String> {
    runner::generate_commit_message(workspace_path, full_access)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Failed to open path".to_string())
            }
        })
}

#[tauri::command]
fn open_in_terminal(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Failed to open terminal".to_string())
            }
        })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Only http(s) URLs are allowed".to_string());
    }

    std::process::Command::new("open")
        .arg(trimmed)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Failed to open URL".to_string())
            }
        })
}

#[tauri::command]
async fn send_desktop_notification(title: String, body: String) -> Result<bool, String> {
    macos_notifications::send_notification(&title, &body).await
}

#[tauri::command]
fn set_app_badge_count(count: Option<i64>) -> Result<bool, String> {
    macos_notifications::set_badge_count(count)
}

#[tauri::command]
fn open_terminal_command(command: String) -> Result<(), String> {
    let escaped = command
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        escaped
    );
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("Failed to open terminal command".to_string())
            }
        })
}

#[tauri::command]
fn copy_terminal_env_diagnostics(workspace_path: String) -> Result<String, String> {
    runner::copy_terminal_env_diagnostics(workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn validate_importable_claude_session(
    workspace_path: String,
    claude_session_id: String,
) -> Result<bool, String> {
    runner::validate_importable_claude_session(workspace_path, claude_session_id)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn discover_importable_claude_sessions() -> Result<Vec<ImportableClaudeProject>, String> {
    runner::discover_importable_claude_sessions().map_err(|error| error.to_string())
}

#[tauri::command]
fn get_importable_claude_session(
    workspace_path: String,
    claude_session_id: String,
) -> Result<Option<ImportableClaudeSession>, String> {
    runner::get_importable_claude_session(workspace_path, claude_session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_text_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(text).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_image_to_clipboard(path: String) -> Result<(), String> {
    let img = image::open(&path).map_err(|error| error.to_string())?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let pixels = rgba.into_raw();
    let img_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: std::borrow::Cow::Owned(pixels),
    };
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_image(img_data)
        .map_err(|error| error.to_string())
}

fn main() {
    let _ = storage::ensure_base_dirs();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_| {
            if let Err(error) = macos_notifications::initialize() {
                eprintln!("[notifications] initialization failed: {error}");
            }
            // Reset any threads stuck in Running state from a previous crash.
            if let Ok(workspaces) = storage::load_workspaces() {
                for ws in &workspaces {
                    let _ = storage::cleanup_stale_running_threads(&ws.id);
                }
            }
            if std::env::var_os("CLAUDEX_SEND_STARTUP_TEST_ALERT").is_some() {
                let result_path = std::env::var("CLAUDEX_STARTUP_TEST_ALERT_RESULT_FILE")
                    .unwrap_or_else(|_| "/tmp/claudex-startup-alert-result.txt".to_string());
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let result = macos_notifications::send_notification(
                        "Claudex startup test alert",
                        "If you can see and hear this, the native alert bridge is working.",
                    )
                    .await;
                    let _ = std::fs::write(&result_path, format!("{result:?}\n"));
                    eprintln!("[notifications] startup test alert result: {result:?}");
                });
            }
            Ok(())
        })
        .manage(AppState {
            runner: Arc::new(runner::RunnerState::default()),
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                state.runner.terminal_sessions.shutdown_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_storage_root,
            list_workspaces,
            add_workspace,
            add_ssh_workspace,
            set_workspace_order,
            remove_workspace,
            set_workspace_git_pull_on_master_for_new_threads,
            get_git_info,
            get_git_diff_summary,
            git_list_branches,
            git_workspace_status,
            git_checkout_branch,
            git_create_and_checkout_branch,
            git_auto_pull_on_master,
            git_pull_master_for_new_thread,
            list_threads,
            create_thread,
            create_forked_thread,
            fork_thread_from_ui,
            set_thread_full_access,
            clear_thread_claude_session,
            clear_thread_pending_fork,
            mark_thread_pending_fork_consumed,
            commit_prepared_thread_pending_fork,
            set_thread_claude_session_id,
            set_thread_skills,
            set_thread_agent,
            rename_thread,
            archive_thread,
            delete_thread,
            finalize_thread_native_fork,
            append_user_message,
            load_transcript,
            list_skills,
            build_context_preview,
            get_settings,
            save_settings,
            detect_claude_cli_path,
            check_for_update,
            install_latest_update,
            run_claude,
            cancel_run,
            terminal_start_session,
            prepare_thread_native_fork,
            workspace_shell_start_session,
            terminal_write,
            terminal_rebind_claude_session,
            resolve_thread_fork_candidate,
            terminal_resize,
            terminal_kill,
            terminal_send_signal,
            terminal_get_last_log,
            latest_claude_session_cwd,
            terminal_read_output,
            generate_commit_message,
            open_in_finder,
            open_in_terminal,
            open_external_url,
            send_desktop_notification,
            set_app_badge_count,
            open_terminal_command,
            copy_terminal_env_diagnostics,
            validate_importable_claude_session,
            discover_importable_claude_sessions,
            get_importable_claude_session,
            write_text_to_clipboard,
            write_image_to_clipboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claudex");
}
