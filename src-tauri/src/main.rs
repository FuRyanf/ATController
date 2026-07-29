#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod codex;
mod git_tools;
mod macos_notifications;
mod models;
mod storage;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, State};

use crate::codex::{
    CodexDiagnostics, CodexDiscoveredProject, CodexLoginSession, CodexResumeCommand, CodexRuntime,
    CodexRuntimeCatalog, CodexSkill, CodexThread, CodexThreadPage, CodexThreadSession, CodexTurn,
    ComposerInput, ResumeCommandRequest, ServerRequestResponse, ThreadPreferences,
};
use crate::models::{
    CodexThreadUiMetadata, GitBranchEntry, GitInfo, GitPullForNewThreadResult, GitWorkspaceStatus,
    Settings, Workspace, WorkspaceUpdate,
};

struct AppState {
    codex: Arc<CodexRuntime>,
}

#[tauri::command]
fn get_app_storage_root() -> Result<String, String> {
    storage::ensure_base_dirs()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_codex_thread_ui_metadata(
    workspace_id: String,
) -> Result<Vec<CodexThreadUiMetadata>, String> {
    storage::list_codex_thread_ui_metadata(&workspace_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_codex_thread_ui_metadata(
    workspace_id: String,
    thread_id: String,
) -> Result<CodexThreadUiMetadata, String> {
    storage::get_codex_thread_ui_metadata(&workspace_id, &thread_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_codex_thread_ui_metadata(
    metadata: CodexThreadUiMetadata,
) -> Result<CodexThreadUiMetadata, String> {
    storage::save_codex_thread_ui_metadata(metadata).map_err(|error| error.to_string())
}

#[tauri::command]
fn codex_get_diagnostics(state: State<'_, AppState>) -> CodexDiagnostics {
    state.codex.diagnostics()
}

#[tauri::command]
fn report_frontend_error(state: State<'_, AppState>, message: String) {
    let message = message.chars().take(4_000).collect::<String>();
    eprintln!("[frontend] {message}");
    state.codex.report_frontend_error(&message);
}

#[tauri::command]
async fn codex_restart_runtime(state: State<'_, AppState>) -> Result<CodexDiagnostics, String> {
    state
        .codex
        .clone()
        .restart()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_run_self_test(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state
        .codex
        .clone()
        .self_test()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_regenerate_protocol_snapshot(state: State<'_, AppState>) -> Result<String, String> {
    state
        .codex
        .clone()
        .regenerate_protocol_snapshot()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_get_runtime_catalog(
    state: State<'_, AppState>,
) -> Result<CodexRuntimeCatalog, String> {
    state
        .codex
        .clone()
        .runtime_catalog()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_start_chatgpt_login(
    state: State<'_, AppState>,
) -> Result<CodexLoginSession, String> {
    state
        .codex
        .clone()
        .start_chatgpt_login()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_list_threads(
    state: State<'_, AppState>,
    workspace_path: String,
    archived: bool,
    search_term: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<CodexThreadPage, String> {
    state
        .codex
        .clone()
        .list_threads(workspace_path, archived, search_term, cursor, limit)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_discover_projects(
    state: State<'_, AppState>,
) -> Result<Vec<CodexDiscoveredProject>, String> {
    state
        .codex
        .clone()
        .discover_projects()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_read_thread(
    state: State<'_, AppState>,
    thread_id: String,
    include_turns: bool,
) -> Result<CodexThread, String> {
    state
        .codex
        .clone()
        .read_thread(thread_id, include_turns)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_start_thread(
    state: State<'_, AppState>,
    workspace_path: String,
    preferences: ThreadPreferences,
    clear_replacement: bool,
) -> Result<CodexThreadSession, String> {
    state
        .codex
        .clone()
        .start_thread(workspace_path, preferences, clear_replacement)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_resume_thread(
    state: State<'_, AppState>,
    workspace_path: String,
    thread_id: String,
    preferences: ThreadPreferences,
) -> Result<CodexThreadSession, String> {
    state
        .codex
        .clone()
        .resume_thread(workspace_path, thread_id, preferences)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_fork_thread(
    state: State<'_, AppState>,
    workspace_path: String,
    thread_id: String,
    last_turn_id: Option<String>,
    preferences: ThreadPreferences,
) -> Result<CodexThreadSession, String> {
    state
        .codex
        .clone()
        .fork_thread(workspace_path, thread_id, last_turn_id, preferences)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_rename_thread(
    state: State<'_, AppState>,
    thread_id: String,
    name: String,
) -> Result<(), String> {
    state
        .codex
        .clone()
        .rename_thread(thread_id, name)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_archive_thread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    state
        .codex
        .clone()
        .archive_thread(thread_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_unarchive_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<CodexThread, String> {
    state
        .codex
        .clone()
        .unarchive_thread(thread_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_delete_thread(state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    state
        .codex
        .clone()
        .delete_thread(thread_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_start_turn(
    state: State<'_, AppState>,
    workspace_path: String,
    thread_id: String,
    inputs: Vec<ComposerInput>,
    preferences: ThreadPreferences,
) -> Result<CodexTurn, String> {
    state
        .codex
        .clone()
        .start_turn(workspace_path, thread_id, inputs, preferences)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_steer_turn(
    state: State<'_, AppState>,
    workspace_path: String,
    thread_id: String,
    turn_id: String,
    inputs: Vec<ComposerInput>,
) -> Result<(), String> {
    state
        .codex
        .clone()
        .steer_turn(workspace_path, thread_id, turn_id, inputs)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_interrupt_turn(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> Result<(), String> {
    state
        .codex
        .clone()
        .interrupt_turn(thread_id, turn_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_respond_to_server_request(
    state: State<'_, AppState>,
    response: ServerRequestResponse,
) -> Result<(), String> {
    state
        .codex
        .clone()
        .respond_to_server_request(response)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_list_runtime_skills(
    state: State<'_, AppState>,
    workspace_path: String,
    force_reload: bool,
) -> Result<Vec<CodexSkill>, String> {
    state
        .codex
        .clone()
        .list_skills(workspace_path, force_reload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_build_resume_command(
    state: State<'_, AppState>,
    request: ResumeCommandRequest,
) -> Result<CodexResumeCommand, String> {
    state
        .codex
        .clone()
        .build_resume_command(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn codex_open_resume_in_terminal(
    state: State<'_, AppState>,
    request: ResumeCommandRequest,
    execute: bool,
) -> Result<CodexResumeCommand, String> {
    state
        .codex
        .clone()
        .open_resume_in_terminal(request, execute)
        .await
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
fn set_workspace_order(workspace_ids: Vec<String>) -> Result<Vec<Workspace>, String> {
    storage::set_workspace_order(workspace_ids).map_err(|error| error.to_string())
}

#[tauri::command]
fn update_workspace(workspace_id: String, update: WorkspaceUpdate) -> Result<Workspace, String> {
    storage::update_workspace(&workspace_id, update).map_err(|error| error.to_string())
}

#[tauri::command]
fn relocate_workspace(workspace_id: String, path: String) -> Result<Workspace, String> {
    storage::relocate_workspace(&workspace_id, &path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn clone_repository(
    repository: String,
    destination_parent: String,
) -> Result<Workspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        storage::clone_repository(&repository, &destination_parent)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Git clone task failed: {error}"))?
}

#[tauri::command]
fn remove_workspace(workspace_id: String) -> Result<bool, String> {
    storage::remove_workspace(&workspace_id).map_err(|error| error.to_string())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[tauri::command]
fn build_project_shell_command(workspace_id: String) -> Result<String, String> {
    let workspace = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| "Project not found".to_string())?;
    Ok(format!("cd -- {}", shell_quote(&workspace.path)))
}

#[tauri::command]
fn set_workspace_git_pull_on_master_for_new_threads(
    workspace_id: String,
    enabled: bool,
) -> Result<Workspace, String> {
    storage::set_workspace_git_pull_on_master_for_new_threads(&workspace_id, enabled)
        .map_err(|error| error.to_string())
}

fn resolve_registered_workspace_path(path: &str) -> Result<String, String> {
    let requested = std::fs::canonicalize(path)
        .map_err(|error| format!("Unable to resolve workspace path: {error}"))?;
    if !requested.is_dir() {
        return Err("Workspace path is not a directory".to_string());
    }
    let registered = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|workspace| std::fs::canonicalize(workspace.path).ok())
        .any(|workspace| workspace == requested);
    if !registered {
        return Err("Workspace is not registered in ATController".to_string());
    }
    Ok(requested.to_string_lossy().to_string())
}

#[tauri::command]
fn get_git_info(workspace_path: String) -> Result<Option<GitInfo>, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    git_tools::get_git_info(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_list_branches(workspace_path: String) -> Result<Vec<GitBranchEntry>, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    git_tools::list_branches(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_workspace_status(workspace_path: String) -> Result<GitWorkspaceStatus, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    git_tools::workspace_status(&workspace_path).map_err(|error| error.to_string())
}

#[tauri::command]
fn git_workspace_diff(workspace_path: String, file_path: Option<String>) -> Result<String, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    git_tools::workspace_diff(&workspace_path, file_path.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn git_revert_file(workspace_path: String, file_path: String) -> Result<bool, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    git_tools::revert_file(&workspace_path, &file_path)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn git_checkout_branch(workspace_path: String, branch_name: String) -> Result<bool, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    git_tools::checkout_branch(&workspace_path, &branch_name)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn git_create_branch(workspace_path: String, branch_name: String) -> Result<bool, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    git_tools::create_branch(&workspace_path, &branch_name)
        .map(|_| true)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_project_file(workspace_path: String, file_path: String) -> Result<(), String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    let path = git_tools::resolve_project_file(&workspace_path, &file_path)
        .map_err(|error| error.to_string())?;
    std::process::Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            status
                .success()
                .then_some(())
                .ok_or_else(|| "Failed to open project file".to_string())
        })
}

#[tauri::command]
fn reveal_project_file(workspace_path: String, file_path: String) -> Result<(), String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    let path = git_tools::resolve_project_file(&workspace_path, &file_path)
        .map_err(|error| error.to_string())?;
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            status
                .success()
                .then_some(())
                .ok_or_else(|| "Failed to reveal project file".to_string())
        })
}

#[tauri::command]
async fn git_pull_master_for_new_thread(
    workspace_path: String,
) -> Result<GitPullForNewThreadResult, String> {
    let workspace_path = resolve_registered_workspace_path(&workspace_path)?;
    tokio::task::spawn_blocking(move || git_tools::git_pull_master_for_new_thread(&workspace_path))
        .await
        .map_err(|error| format!("Git pull task failed: {error}"))?
        .map_err(|error| error.to_string())
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

fn resolve_allowed_local_path(path: &str, require_directory: bool) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err("Path is empty or invalid".to_string());
    }
    let canonical = std::fs::canonicalize(trimmed)
        .map_err(|error| format!("Unable to resolve path: {error}"))?;
    if require_directory && !canonical.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let mut allowed_roots = storage::load_workspaces()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|workspace| std::fs::canonicalize(workspace.path).ok())
        .collect::<Vec<_>>();
    if let Ok(data_root) = storage::ensure_base_dirs() {
        if let Ok(data_root) = std::fs::canonicalize(data_root) {
            allowed_roots.push(data_root);
        }
    }
    if !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        return Err("Path is outside ATController projects and application data".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
fn open_in_finder(path: String) -> Result<(), String> {
    let path = resolve_allowed_local_path(&path, false)?;
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
    let path = resolve_allowed_local_path(&path, true)?;
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
fn open_codex_configuration() -> Result<(), String> {
    let codex_home = std::env::var("CODEX_HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .ok_or_else(|| "Unable to resolve the Codex home directory".to_string())?;
    let codex_home = std::fs::canonicalize(&codex_home)
        .map_err(|error| format!("Unable to open Codex configuration: {error}"))?;
    if !codex_home.is_dir() {
        return Err("Codex home is not a directory".to_string());
    }
    let config = codex_home.join("config.toml");
    let target = if config.is_file() { config } else { codex_home };
    let status = std::process::Command::new("/usr/bin/open")
        .arg(target)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to open Codex configuration".to_string())
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.len() > 4_096 || trimmed.chars().any(char::is_control) {
        return Err("URL is invalid or too long".to_string());
    }
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
    if title.len() > 160
        || body.len() > 2_000
        || title.chars().any(char::is_control)
        || body
            .chars()
            .any(|character| character.is_control() && character != '\n')
    {
        return Err("Notification content is invalid or too long".to_string());
    }
    macos_notifications::send_notification(&title, &body).await
}

#[tauri::command]
fn set_app_badge_count(count: Option<i64>) -> Result<bool, String> {
    macos_notifications::set_badge_count(count)
}

#[tauri::command]
fn write_text_to_clipboard(text: String) -> Result<(), String> {
    if text.len() > 16 * 1024 * 1024 {
        return Err("Clipboard content is too large".to_string());
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(text).map_err(|error| error.to_string())
}

fn main() {
    if let Err(error) = storage::ensure_base_dirs() {
        eprintln!("ATController could not initialize its application data directory: {error:#}");
        std::process::exit(1);
    }

    tauri::Builder::default()
        .enable_macos_default_menu(true)
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let runtime = app.state::<AppState>().codex.clone();
            runtime.attach(app.handle().clone());
            CodexRuntime::start_in_background(runtime.clone());
            #[cfg(unix)]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let Ok(mut terminate) =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    else {
                        return;
                    };
                    if terminate.recv().await.is_some() {
                        runtime.shutdown().await;
                        app_handle.exit(143);
                    }
                });
            }
            if let Err(error) = macos_notifications::initialize() {
                eprintln!("[notifications] initialization failed: {error}");
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
            codex: Arc::new(CodexRuntime::default()),
        })
        .invoke_handler(tauri::generate_handler![
            codex_get_diagnostics,
            report_frontend_error,
            codex_restart_runtime,
            codex_run_self_test,
            codex_regenerate_protocol_snapshot,
            codex_get_runtime_catalog,
            codex_start_chatgpt_login,
            codex_list_threads,
            codex_discover_projects,
            codex_read_thread,
            codex_start_thread,
            codex_resume_thread,
            codex_fork_thread,
            codex_rename_thread,
            codex_archive_thread,
            codex_unarchive_thread,
            codex_delete_thread,
            codex_start_turn,
            codex_steer_turn,
            codex_interrupt_turn,
            codex_respond_to_server_request,
            codex_list_runtime_skills,
            codex_build_resume_command,
            codex_open_resume_in_terminal,
            get_app_storage_root,
            list_codex_thread_ui_metadata,
            get_codex_thread_ui_metadata,
            save_codex_thread_ui_metadata,
            list_workspaces,
            add_workspace,
            set_workspace_order,
            update_workspace,
            relocate_workspace,
            clone_repository,
            remove_workspace,
            build_project_shell_command,
            set_workspace_git_pull_on_master_for_new_threads,
            get_git_info,
            git_list_branches,
            git_workspace_status,
            git_workspace_diff,
            git_revert_file,
            git_checkout_branch,
            git_create_branch,
            git_pull_master_for_new_thread,
            open_project_file,
            reveal_project_file,
            get_settings,
            save_settings,
            open_in_finder,
            open_in_terminal,
            open_codex_configuration,
            open_external_url,
            send_desktop_notification,
            set_app_badge_count,
            write_text_to_clipboard
        ])
        .build(tauri::generate_context!())
        .expect("error while building ATController")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<AppState>();
                tauri::async_runtime::block_on(state.codex.shutdown());
            }
        });
}

#[cfg(test)]
mod command_tests {
    use super::shell_quote;

    #[test]
    fn project_shell_commands_escape_spaces_and_single_quotes() {
        assert_eq!(
            shell_quote("/tmp/Project's workspace"),
            "'/tmp/Project'\\''s workspace'"
        );
    }
}
