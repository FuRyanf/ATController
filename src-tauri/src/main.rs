#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod codex_app_server;
mod git_tools;
mod macos_notifications;
mod models;
mod runner;
mod skills;
mod storage;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, State};

use crate::models::{
    AppUpdateInfo, CodexRuntimeOverview, CodexRuntimePreferences, GitBranchEntry, GitInfo,
    GitPullForNewThreadResult, GitWorkspaceStatus, ImportableCodexProject, ImportableCodexSession,
    PreparedNativeFork, RecentCodexThread, Settings, SkillInfo, TerminalStartResponse,
    ThreadMetadata, Workspace, WorkspaceShellStartResponse,
};

struct AppState {
    runner: Arc<runner::RunnerState>,
}

fn codex_session_import_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

const GITHUB_LATEST_RELEASE_API_URL: &str =
    "https://api.github.com/repos/FuRyanf/ATController/releases/latest";
const GITHUB_RELEASE_PAGE_PREFIX: &str = "https://github.com/FuRyanf/ATController/releases/";
const MAX_RELEASE_METADATA_BYTES: usize = 1024 * 1024;
const ATTACHMENT_PREVIEW_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif",
];

#[derive(Debug, Deserialize)]
struct GitHubLatestRelease {
    tag_name: String,
    html_url: Option<String>,
}

fn parse_semver_like(version: &str) -> Option<Vec<u64>> {
    let trimmed = version.trim();
    let trimmed = trimmed.strip_prefix('v').unwrap_or(trimmed);
    if trimmed.is_empty() {
        return None;
    }

    let segments = trimmed.split('.').collect::<Vec<_>>();
    if segments.len() != 3 {
        return None;
    }
    segments
        .into_iter()
        .map(|segment| {
            if segment.is_empty() || !segment.chars().all(|ch| ch.is_ascii_digit()) {
                None
            } else {
                segment.parse().ok()
            }
        })
        .collect()
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
    env!("CARGO_PKG_VERSION").to_string()
}

fn resolve_attachment_preview_path(path: &str) -> Result<std::path::PathBuf, String> {
    let requested = std::path::Path::new(path);
    if !requested.is_absolute() {
        return Err("Attachment preview path must be absolute".to_string());
    }
    let extension_is_supported = requested
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|value| ATTACHMENT_PREVIEW_EXTENSIONS.contains(&value.as_str()));
    if !extension_is_supported {
        return Err("Attachment preview is limited to supported image files".to_string());
    }

    let canonical = std::fs::canonicalize(requested)
        .map_err(|error| format!("Unable to resolve attachment preview: {error}"))?;
    if !canonical.is_file() {
        return Err("Attachment preview path is not a regular file".to_string());
    }
    Ok(canonical)
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
fn add_rdev_workspace(
    rdev_ssh_command: String,
    display_name: Option<String>,
) -> Result<Workspace, String> {
    storage::add_rdev_workspace(&rdev_ssh_command, display_name.as_deref())
        .map_err(|error| error.to_string())
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
            .shutdown_and_block_workspace_id(&item.id)
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
async fn git_pull_master_for_new_thread(
    workspace_path: String,
) -> Result<GitPullForNewThreadResult, String> {
    tokio::task::spawn_blocking(move || git_tools::git_pull_master_for_new_thread(&workspace_path))
        .await
        .map_err(|error| format!("Git pull task failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_threads(workspace_id: String) -> Result<Vec<ThreadMetadata>, String> {
    storage::list_threads(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_thread(
    workspace_id: String,
    full_access: Option<bool>,
) -> Result<ThreadMetadata, String> {
    storage::create_thread(&workspace_id, full_access.unwrap_or(false))
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
fn clear_thread_codex_session(
    workspace_id: String,
    thread_id: String,
) -> Result<ThreadMetadata, String> {
    storage::clear_thread_codex_session(&workspace_id, &thread_id)
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
fn commit_prepared_thread_pending_fork(
    workspace_id: String,
    thread_id: String,
    prepared: PreparedNativeFork,
) -> Result<ThreadMetadata, String> {
    storage::commit_prepared_thread_pending_fork(&workspace_id, &thread_id, &prepared)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_thread_codex_session_id(
    workspace_id: String,
    thread_id: String,
    codex_session_id: String,
) -> Result<ThreadMetadata, String> {
    storage::set_thread_codex_session_id(&workspace_id, &thread_id, &codex_session_id)
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
fn delete_thread(
    state: State<'_, AppState>,
    workspace_id: String,
    thread_id: String,
) -> Result<bool, String> {
    state
        .runner
        .terminal_sessions
        .shutdown_and_block_thread_id(&workspace_id, &thread_id)
        .map_err(|error| error.to_string())?;
    storage::delete_thread_from_sidebar(&workspace_id, &thread_id)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_skills(workspace_path: String) -> Result<Vec<SkillInfo>, String> {
    skills::list_skills(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    storage::load_settings().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<Settings, String> {
    let settings = settings.normalized();
    storage::save_settings(&settings)
        .map(|_| settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn detect_codex_cli_path() -> Result<Option<String>, String> {
    let settings = storage::load_settings().map_err(|error| error.to_string())?;
    Ok(runner::detect_codex_cli_path(&settings))
}

#[tauri::command]
async fn get_codex_runtime_overview() -> Result<CodexRuntimeOverview, String> {
    tokio::task::spawn_blocking(codex_app_server::runtime_overview)
        .await
        .map_err(|error| format!("Codex runtime request failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn update_codex_runtime_preferences(
    preferences: CodexRuntimePreferences,
) -> Result<CodexRuntimeOverview, String> {
    tokio::task::spawn_blocking(move || codex_app_server::update_runtime_preferences(preferences))
        .await
        .map_err(|error| format!("Codex runtime update failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_recent_codex_threads() -> Result<Vec<RecentCodexThread>, String> {
    tokio::task::spawn_blocking(runner::list_recent_codex_threads)
        .await
        .map_err(|error| format!("Codex thread history request failed: {error}"))?
        .map_err(|error| error.to_string())
}

fn fetch_latest_release() -> Result<GitHubLatestRelease, String> {
    let output = std::process::Command::new("/usr/bin/curl")
        .args([
            "--fail",
            "--show-error",
            "--silent",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--tlsv1.2",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "--max-filesize",
            "1048576",
            "--retry",
            "2",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: ATController",
            GITHUB_LATEST_RELEASE_API_URL,
        ])
        .output()
        .map_err(|error| format!("Unable to start the update check: {error}"))?;

    if !output.status.success() {
        return Err("Failed to fetch latest ATController release information".to_string());
    }
    if output.stdout.len() > MAX_RELEASE_METADATA_BYTES {
        return Err("Latest ATController release information was unexpectedly large".to_string());
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Latest ATController release information was invalid: {error}"))
}

#[tauri::command]
async fn check_for_update() -> Result<AppUpdateInfo, String> {
    let current_version = current_build_version();
    let release = tokio::task::spawn_blocking(fetch_latest_release)
        .await
        .map_err(|error| format!("Update check task failed: {error}"))??;
    let latest_version = release.tag_name.trim().trim_start_matches('v').to_string();
    let update_available = is_version_newer(&latest_version, &current_version);
    let release_url = release
        .html_url
        .filter(|url| url.starts_with(GITHUB_RELEASE_PAGE_PREFIX));

    Ok(AppUpdateInfo {
        current_version,
        latest_version: Some(latest_version),
        update_available,
        release_url,
    })
}

#[tauri::command]
async fn install_latest_update(app: tauri::AppHandle) -> Result<bool, String> {
    let installed_update = tokio::task::spawn_blocking(runner::install_latest_update)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    // Always relaunch the installed /Applications bundle so updates work even
    // when the current process was launched from an older app copy/location.
    let installed_app_path = runner::installed_app_path();
    let launch_result = std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&installed_app_path)
        .status();
    let launch_failure = match launch_result {
        Ok(status) if status.success() => None,
        Ok(_) => Some(format!(
            "Installed update, but macOS failed to relaunch ATController from {}.",
            installed_app_path.display()
        )),
        Err(error) => Some(format!(
            "Installed update, but failed to start the relaunch command: {error}"
        )),
    };
    if let Some(launch_failure) = launch_failure {
        let rollback_update = installed_update.clone();
        let rollback_result = tokio::task::spawn_blocking(move || {
            runner::rollback_installed_update(&rollback_update)
        })
        .await;
        return Err(match rollback_result {
            Ok(Ok(())) => {
                format!("{launch_failure} The previous ATController.app was restored.")
            }
            Ok(Err(error)) => format!(
                "{launch_failure} Automatic rollback failed; the signed recovery bundle was \
                 retained: {error:#}"
            ),
            Err(error) => format!(
                "{launch_failure} The rollback task failed; the signed recovery bundle was \
                 retained: {error}"
            ),
        });
    }

    let health_update = installed_update.clone();
    let health_result = tokio::task::spawn_blocking(move || {
        runner::wait_for_installed_update_health(&health_update, Duration::from_secs(20))
    })
    .await;
    let health_failure = match health_result {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(format!("{error:#}")),
        Err(error) => Some(format!("Relaunch health task failed: {error}")),
    };
    if let Some(health_failure) = health_failure {
        let rollback_update = installed_update;
        let rollback_result = tokio::task::spawn_blocking(move || {
            runner::rollback_installed_update(&rollback_update)
        })
        .await;
        return Err(match rollback_result {
            Ok(Ok(())) => format!(
                "{health_failure}. The previous ATController.app was restored and remains active."
            ),
            Ok(Err(error)) => format!(
                "{health_failure}. Automatic rollback failed; the signed recovery bundle was \
                 retained: {error:#}"
            ),
            Err(error) => format!(
                "{health_failure}. The rollback task failed; the signed recovery bundle was \
                 retained: {error}"
            ),
        });
    }

    app.exit(0);
    Ok(true)
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
fn terminal_rebind_codex_session(
    state: State<'_, AppState>,
    session_id: String,
    codex_session_id: String,
) -> Result<bool, String> {
    runner::terminal_rebind_codex_session(state.runner.clone(), session_id, codex_session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resolve_thread_fork_candidate(
    source_codex_session_id: String,
    known_child_session_ids: Vec<String>,
    requested_after: Option<String>,
) -> Result<Option<String>, String> {
    runner::resolve_thread_fork_candidate(
        source_codex_session_id,
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
fn latest_codex_session_cwd(
    workspace_path: String,
    codex_session_id: String,
) -> Result<Option<String>, String> {
    runner::latest_codex_session_cwd(workspace_path, codex_session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn latest_codex_turn_completion(
    workspace_path: String,
    codex_session_id: String,
) -> Result<Option<crate::models::CodexTurnCompletionSummary>, String> {
    runner::latest_codex_turn_completion(workspace_path, codex_session_id)
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
fn open_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
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
    std::process::Command::new("/usr/bin/open")
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

    std::process::Command::new("/usr/bin/open")
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
        .replace(['\n', '\r'], " ");
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        escaped
    );
    std::process::Command::new("/usr/bin/osascript")
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
async fn discover_importable_codex_sessions() -> Result<Vec<ImportableCodexProject>, String> {
    tokio::task::spawn_blocking(runner::discover_importable_codex_sessions)
        .await
        .map_err(|error| format!("Codex session discovery task failed: {error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_importable_codex_session(
    workspace_path: String,
    codex_session_id: String,
) -> Result<Option<ImportableCodexSession>, String> {
    tokio::task::spawn_blocking(move || {
        runner::get_importable_codex_session(workspace_path, codex_session_id)
    })
    .await
    .map_err(|error| format!("Codex session lookup task failed: {error}"))?
    .map_err(|error| error.to_string())
}

fn import_codex_session_blocking(
    workspace_id: String,
    codex_session_id: String,
    title: Option<String>,
    full_access: bool,
) -> Result<ThreadMetadata, String> {
    let _guard = codex_session_import_lock()
        .lock()
        .map_err(|_| "Codex session import lock is unavailable".to_string())?;
    let workspace = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| "Workspace not found".to_string())?;
    if workspace.kind != crate::models::WorkspaceKind::Local {
        return Err("Codex session import is only available for local workspaces".to_string());
    }
    runner::validate_importable_codex_session(workspace.path.clone(), codex_session_id.clone())
        .map_err(|error| error.to_string())?;

    if let Some(existing) = storage::list_threads(&workspace.id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|thread| {
            thread
                .codex_session_id
                .as_deref()
                .is_some_and(|session_id| session_id == codex_session_id.trim())
        })
    {
        storage::restore_codex_session_to_sidebar(&codex_session_id)
            .map_err(|error| error.to_string())?;
        return Ok(existing);
    }

    let thread = storage::create_imported_codex_thread(
        &workspace.id,
        &codex_session_id,
        title.as_deref(),
        full_access,
    )
    .map_err(|error| error.to_string())?;
    storage::restore_codex_session_to_sidebar(&codex_session_id)
        .map_err(|error| error.to_string())?;
    Ok(thread)
}

#[tauri::command]
async fn import_codex_session(
    workspace_id: String,
    codex_session_id: String,
    title: Option<String>,
    full_access: bool,
) -> Result<ThreadMetadata, String> {
    tokio::task::spawn_blocking(move || {
        import_codex_session_blocking(workspace_id, codex_session_id, title, full_access)
    })
    .await
    .map_err(|error| format!("Codex session import task failed: {error}"))?
}

#[tauri::command]
fn write_text_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(text).map_err(|error| error.to_string())
}

#[tauri::command]
fn authorize_attachment_preview(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let canonical = resolve_attachment_preview_path(&path)?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|error| format!("Unable to authorize attachment preview: {error}"))?;
    Ok(canonical.to_string_lossy().to_string())
}

fn main() {
    if let Err(error) = storage::ensure_base_dirs() {
        eprintln!("ATController could not initialize its application data directory: {error:#}");
        std::process::exit(1);
    }

    tauri::Builder::default()
        .enable_macos_default_menu(true)
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
            if let Err(error) = runner::schedule_pending_update_health_confirmation() {
                eprintln!(
                    "[updater] unable to schedule pending update health confirmation: {error:#}"
                );
            }
            #[cfg(debug_assertions)]
            {
                if std::env::var_os("ATCONTROLLER_SEND_STARTUP_TEST_ALERT").is_some() {
                    let result_path = std::env::var("ATCONTROLLER_STARTUP_TEST_ALERT_RESULT_FILE")
                        .unwrap_or_else(|_| {
                            "/tmp/atcontroller-startup-alert-result.txt".to_string()
                        });
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        let result = macos_notifications::send_notification(
                            "ATController startup test alert",
                            "If you can see and hear this, the native alert bridge is working.",
                        )
                        .await;
                        let _ = std::fs::write(&result_path, format!("{result:?}\n"));
                        eprintln!("[notifications] startup test alert result: {result:?}");
                    });
                }
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
            add_rdev_workspace,
            add_ssh_workspace,
            set_workspace_order,
            remove_workspace,
            set_workspace_git_pull_on_master_for_new_threads,
            get_git_info,
            git_list_branches,
            git_workspace_status,
            git_checkout_branch,
            git_pull_master_for_new_thread,
            list_threads,
            create_thread,
            set_thread_full_access,
            clear_thread_codex_session,
            clear_thread_pending_fork,
            commit_prepared_thread_pending_fork,
            set_thread_codex_session_id,
            set_thread_skills,
            rename_thread,
            archive_thread,
            delete_thread,
            list_skills,
            get_settings,
            save_settings,
            detect_codex_cli_path,
            get_codex_runtime_overview,
            update_codex_runtime_preferences,
            list_recent_codex_threads,
            check_for_update,
            install_latest_update,
            terminal_start_session,
            prepare_thread_native_fork,
            workspace_shell_start_session,
            terminal_write,
            terminal_rebind_codex_session,
            resolve_thread_fork_candidate,
            terminal_resize,
            terminal_kill,
            terminal_send_signal,
            terminal_get_last_log,
            latest_codex_session_cwd,
            latest_codex_turn_completion,
            terminal_read_output,
            open_in_finder,
            open_in_terminal,
            open_external_url,
            send_desktop_notification,
            set_app_badge_count,
            open_terminal_command,
            copy_terminal_env_diagnostics,
            discover_importable_codex_sessions,
            get_importable_codex_session,
            import_codex_session,
            write_text_to_clipboard,
            authorize_attachment_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running ATController");
}

#[cfg(test)]
mod tests {
    use super::{is_version_newer, parse_semver_like, resolve_attachment_preview_path};

    #[test]
    fn compares_strict_numeric_release_versions() {
        assert!(is_version_newer("v0.0.22", "0.0.21"));
        assert!(is_version_newer("1.0.0", "0.99.99"));
        assert!(!is_version_newer("0.0.21", "0.0.21"));
        assert!(!is_version_newer("0.0.20", "0.0.21"));
    }

    #[test]
    fn rejects_ambiguous_release_versions() {
        assert_eq!(parse_semver_like("1.2"), None);
        assert_eq!(parse_semver_like("1.2.3-beta"), None);
        assert_eq!(parse_semver_like("release-1.2.3"), None);
        assert_eq!(parse_semver_like("1.2.3.4"), None);
        assert_eq!(parse_semver_like("vv1.2.3"), None);
    }

    #[test]
    fn attachment_previews_require_an_existing_absolute_image_path() {
        let root = std::env::temp_dir().join(format!(
            "atcontroller-attachment-preview-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("preview fixture directory should exist");
        let image_path = root.join("preview.PNG");
        std::fs::write(&image_path, b"preview").expect("preview fixture should be writable");
        let text_path = root.join("notes.txt");
        std::fs::write(&text_path, b"notes").expect("text fixture should be writable");

        assert_eq!(
            resolve_attachment_preview_path(image_path.to_string_lossy().as_ref())
                .expect("image preview should resolve"),
            std::fs::canonicalize(&image_path).expect("image fixture should canonicalize")
        );
        assert!(resolve_attachment_preview_path(text_path.to_string_lossy().as_ref()).is_err());
        assert!(resolve_attachment_preview_path("relative.png").is_err());

        let _ = std::fs::remove_dir_all(root);
    }
}
