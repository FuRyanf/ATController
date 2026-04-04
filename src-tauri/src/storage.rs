use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::models::{
    FinalizedNativeFork, ForkThreadResult, PreparedNativeFork, Settings, ThreadMetadata,
    ThreadRunStatus, TranscriptEntry, Workspace, WorkspaceKind,
};

const APP_SUPPORT_SUBDIR: &str = "Library/Application Support/Claudex";

fn thread_metadata_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn validate_storage_segment<'a>(value: &'a str, label: &str) -> Result<&'a str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{label} cannot be empty"));
    }
    if trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return Err(anyhow!("Invalid {label}"));
    }
    Ok(trimmed)
}

fn normalize_thread_title_input(value: &str, label: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{label} cannot be empty"));
    }
    Ok(trimmed.to_string())
}

fn write_file_atomic(path: &Path, raw: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            anyhow!(
                "Cannot write file without a name: {}",
                path.to_string_lossy()
            )
        })?;
    let temp_path = path.with_file_name(format!(".{file_name}.tmp-{}", Uuid::new_v4()));
    fs::write(&temp_path, raw)?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.into());
    }
    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let entry_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry_path, &destination_path)?;
        } else {
            fs::copy(&entry_path, &destination_path)?;
        }
    }
    Ok(())
}

pub fn app_support_root() -> Result<PathBuf> {
    if let Ok(override_root) = std::env::var("CLAUDEX_APP_SUPPORT_ROOT") {
        if !override_root.trim().is_empty() {
            return Ok(PathBuf::from(override_root));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Unable to resolve home directory"))?;
    Ok(home.join(APP_SUPPORT_SUBDIR))
}

pub fn ensure_base_dirs() -> Result<PathBuf> {
    let root = app_support_root()?;
    fs::create_dir_all(root.join("agents"))?;
    fs::create_dir_all(root.join("threads"))?;
    if !root.join("workspaces.json").exists() {
        write_file_atomic(&root.join("workspaces.json"), b"[]")?;
    }
    if !root.join("settings.json").exists() {
        let settings = serde_json::to_string_pretty(&Settings::default())?;
        write_file_atomic(&root.join("settings.json"), settings.as_bytes())?;
    }
    Ok(root)
}

fn workspaces_file() -> Result<PathBuf> {
    Ok(ensure_base_dirs()?.join("workspaces.json"))
}

fn settings_file() -> Result<PathBuf> {
    Ok(ensure_base_dirs()?.join("settings.json"))
}

pub fn load_settings() -> Result<Settings> {
    let file = settings_file()?;
    let raw = fs::read_to_string(file)?;
    let settings: Settings = serde_json::from_str(&raw).unwrap_or_default();
    Ok(settings)
}

pub fn save_settings(settings: &Settings) -> Result<()> {
    let file = settings_file()?;
    let raw = serde_json::to_string_pretty(settings)?;
    write_file_atomic(&file, raw.as_bytes())?;
    Ok(())
}

pub fn load_workspaces() -> Result<Vec<Workspace>> {
    let file = workspaces_file()?;
    let raw = fs::read_to_string(file)?;
    let list: Vec<Workspace> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(list)
}

pub fn save_workspaces(workspaces: &[Workspace]) -> Result<()> {
    let file = workspaces_file()?;
    let raw = serde_json::to_string_pretty(workspaces)?;
    write_file_atomic(&file, raw.as_bytes())?;
    Ok(())
}

pub fn add_workspace(path: &str) -> Result<Workspace> {
    let canonical_path = fs::canonicalize(path)
        .with_context(|| format!("Unable to resolve workspace path: {path}"))?;
    let canonical = canonical_path.to_string_lossy().to_string();

    let mut workspaces = load_workspaces()?;
    if let Some(existing) = workspaces
        .iter()
        .find(|workspace| workspace.path == canonical)
    {
        return Ok(existing.clone());
    }

    let now = Utc::now();
    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name: canonical_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Workspace".to_string()),
        path: canonical,
        kind: WorkspaceKind::Local,
        ssh_command: None,
        remote_path: None,
        git_pull_on_master_for_new_threads: false,
        created_at: now,
        updated_at: now,
    };

    workspaces.push(workspace.clone());
    save_workspaces(&workspaces)?;
    fs::create_dir_all(thread_workspace_dir(&workspace.id)?)?;

    Ok(workspace)
}

pub fn add_ssh_workspace(
    ssh_command: &str,
    display_name: Option<&str>,
    remote_path: Option<&str>,
) -> Result<Workspace> {
    let normalized_command = ssh_command.trim();
    if normalized_command.is_empty() {
        return Err(anyhow!("Please enter an ssh command."));
    }

    let first_token = normalized_command
        .split_whitespace()
        .next()
        .unwrap_or_default();
    if first_token != "ssh" {
        return Err(anyhow!(
            "SSH command must start with `ssh` (example: ssh user@host)"
        ));
    }

    let mut workspaces = load_workspaces()?;
    if let Some(existing) = workspaces.iter().find(|workspace| {
        workspace.kind == WorkspaceKind::Ssh
            && workspace.ssh_command.as_deref() == Some(normalized_command)
    }) {
        return Ok(existing.clone());
    }

    let now = Utc::now();
    let trimmed_display_name = display_name.unwrap_or_default().trim().to_string();
    let fallback_name = normalized_command
        .split_whitespace()
        .skip(1)
        .find(|segment| !segment.starts_with('-'))
        .unwrap_or("ssh")
        .split('@')
        .next_back()
        .unwrap_or("ssh")
        .to_string();
    let workspace_name = if trimmed_display_name.is_empty() {
        fallback_name
    } else {
        trimmed_display_name
    };
    let trimmed_remote_path = remote_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());

    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name: workspace_name,
        path: format!("ssh-workspace-{}", Uuid::new_v4()),
        kind: WorkspaceKind::Ssh,
        ssh_command: Some(normalized_command.to_string()),
        remote_path: trimmed_remote_path,
        git_pull_on_master_for_new_threads: false,
        created_at: now,
        updated_at: now,
    };

    workspaces.push(workspace.clone());
    save_workspaces(&workspaces)?;
    fs::create_dir_all(thread_workspace_dir(&workspace.id)?)?;

    Ok(workspace)
}

pub fn remove_workspace(workspace_id: &str) -> Result<bool> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let mut workspaces = load_workspaces()?;
    let original_len = workspaces.len();
    workspaces.retain(|workspace| workspace.id != workspace_id);
    if workspaces.len() == original_len {
        return Ok(false);
    }

    save_workspaces(&workspaces)?;

    let workspace_threads_dir = thread_workspace_dir(workspace_id)?;
    if workspace_threads_dir.exists() {
        fs::remove_dir_all(workspace_threads_dir)?;
    }

    Ok(true)
}

pub fn set_workspace_git_pull_on_master_for_new_threads(
    workspace_id: &str,
    enabled: bool,
) -> Result<Workspace> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let mut workspaces = load_workspaces()?;
    let workspace = workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| anyhow!("Workspace not found"))?;
    workspace.git_pull_on_master_for_new_threads = enabled;
    workspace.updated_at = Utc::now();
    let updated = workspace.clone();
    save_workspaces(&workspaces)?;
    Ok(updated)
}

#[allow(dead_code)]
pub fn set_workspace_remote_path(
    workspace_id: &str,
    remote_path: Option<&str>,
) -> Result<Workspace> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let mut workspaces = load_workspaces()?;
    let workspace = workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| anyhow!("Workspace not found"))?;

    workspace.remote_path = remote_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    workspace.updated_at = Utc::now();
    let updated = workspace.clone();
    save_workspaces(&workspaces)?;
    Ok(updated)
}

pub fn set_workspace_order(workspace_ids: Vec<String>) -> Result<Vec<Workspace>> {
    let mut workspaces = load_workspaces()?;
    if workspaces.len() <= 1 {
        return Ok(workspaces);
    }

    let mut requested_ids = Vec::new();
    for workspace_id in workspace_ids {
        let normalized = validate_storage_segment(&workspace_id, "workspace id")?.to_string();
        if requested_ids
            .iter()
            .any(|existing: &String| existing == &normalized)
        {
            continue;
        }
        requested_ids.push(normalized);
    }

    if requested_ids.is_empty() {
        return Ok(workspaces);
    }

    let mut ordered = Vec::with_capacity(workspaces.len());
    for workspace_id in requested_ids {
        if let Some(index) = workspaces
            .iter()
            .position(|workspace| workspace.id == workspace_id)
        {
            ordered.push(workspaces.remove(index));
        }
    }
    ordered.extend(workspaces);
    save_workspaces(&ordered)?;
    Ok(ordered)
}

pub fn thread_workspace_dir(workspace_id: &str) -> Result<PathBuf> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    Ok(ensure_base_dirs()?.join("threads").join(workspace_id))
}

pub fn thread_dir(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    let thread_id = validate_storage_segment(thread_id, "thread id")?;
    Ok(thread_workspace_dir(workspace_id)?.join(thread_id))
}

pub fn runs_dir(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    Ok(thread_dir(workspace_id, thread_id)?.join("runs"))
}

pub fn workspace_shell_sessions_dir(workspace_id: &str) -> Result<PathBuf> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    Ok(ensure_base_dirs()?
        .join("workspace-shells")
        .join(workspace_id))
}

pub fn create_thread(
    workspace_id: &str,
    agent_id: Option<String>,
    full_access: bool,
) -> Result<ThreadMetadata> {
    let now = Utc::now();
    let thread = ThreadMetadata {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        agent_id: agent_id.unwrap_or_else(|| "claude-code".to_string()),
        full_access,
        enabled_skills: Vec::new(),
        created_at: now,
        updated_at: now,
        title: "New thread".to_string(),
        is_archived: false,
        last_run_status: ThreadRunStatus::Idle,
        last_run_started_at: None,
        last_run_ended_at: None,
        claude_session_id: None,
        forked_from_claude_session_id: None,
        pending_fork_source_claude_session_id: None,
        pending_fork_known_child_session_ids: Vec::new(),
        pending_fork_requested_at: None,
        pending_fork_launch_consumed: false,
        last_resume_at: None,
        last_new_session_at: None,
    };

    initialize_thread_storage(&thread)?;
    Ok(thread)
}

fn initialize_thread_storage(thread: &ThreadMetadata) -> Result<()> {
    write_thread_metadata(thread)?;
    let dir = thread_dir(&thread.workspace_id, &thread.id)?;
    fs::create_dir_all(dir.join("runs"))?;
    let transcript_path = dir.join("transcript.jsonl");
    if !transcript_path.exists() {
        File::create(transcript_path)?;
    }

    Ok(())
}

fn normalize_optional_session_id(value: &str) -> Option<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_string())
    }
}

fn normalize_uuid_session_id(value: &str) -> Option<String> {
    let normalized = normalize_optional_session_id(value)?;
    if Uuid::parse_str(&normalized).is_ok() {
        Some(normalized)
    } else {
        None
    }
}

fn thread_metadata_path(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    Ok(thread_dir(workspace_id, thread_id)?.join("thread.json"))
}

fn write_thread_metadata_unlocked(thread: &ThreadMetadata) -> Result<()> {
    let dir = thread_dir(&thread.workspace_id, &thread.id)?;
    fs::create_dir_all(&dir)?;
    let raw = serde_json::to_string_pretty(thread)?;
    write_file_atomic(
        &thread_metadata_path(&thread.workspace_id, &thread.id)?,
        raw.as_bytes(),
    )?;
    Ok(())
}

fn read_thread_metadata_unlocked(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    let raw = fs::read_to_string(thread_metadata_path(workspace_id, thread_id)?)?;
    Ok(serde_json::from_str(&raw)?)
}

fn claude_session_id_claimed_by_other_thread_unlocked(
    workspace_id: &str,
    thread_id: &str,
    claude_session_id: &str,
) -> Result<bool> {
    let normalized = claude_session_id.trim();
    if normalized.is_empty() {
        return Ok(false);
    }

    let threads_root = thread_workspace_dir(workspace_id)?;
    if !threads_root.exists() {
        return Ok(false);
    }

    for entry in fs::read_dir(threads_root)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let Some(candidate_thread_id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if candidate_thread_id == thread_id {
            continue;
        }

        let metadata_path = path.join("thread.json");
        if !metadata_path.is_file() {
            continue;
        }

        let raw = fs::read_to_string(metadata_path)?;
        let metadata: ThreadMetadata = serde_json::from_str(&raw)?;
        if metadata.is_archived {
            continue;
        }
        if metadata
            .claude_session_id
            .as_deref()
            .is_some_and(|existing| existing == normalized)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

fn mutate_thread_metadata<F>(
    workspace_id: &str,
    thread_id: &str,
    mutate: F,
) -> Result<ThreadMetadata>
where
    F: FnOnce(&mut ThreadMetadata) -> Result<()>,
{
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    let mut thread = read_thread_metadata_unlocked(workspace_id, thread_id)?;
    mutate(&mut thread)?;
    write_thread_metadata_unlocked(&thread)?;
    Ok(thread)
}

pub fn write_thread_metadata(thread: &ThreadMetadata) -> Result<()> {
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    write_thread_metadata_unlocked(thread)
}

pub fn read_thread_metadata(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    read_thread_metadata_unlocked(workspace_id, thread_id)
}

pub fn list_threads(workspace_id: &str) -> Result<Vec<ThreadMetadata>> {
    let base = thread_workspace_dir(workspace_id)?;
    if !base.exists() {
        return Ok(Vec::new());
    }

    let mut threads = Vec::new();
    for entry in fs::read_dir(base)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let metadata_path = path.join("thread.json");
        if !metadata_path.exists() {
            continue;
        }
        let raw = fs::read_to_string(metadata_path)?;
        let mut metadata: ThreadMetadata = serde_json::from_str(&raw)?;
        if metadata.is_archived {
            continue;
        }
        // Reset Running → Idle in returned data only (no disk write).
        // Persistent cleanup happens once at startup via cleanup_stale_running_threads.
        if matches!(metadata.last_run_status, ThreadRunStatus::Running) {
            metadata.last_run_status = ThreadRunStatus::Idle;
        }
        threads.push(metadata);
    }

    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(threads)
}

/// Persists Running → Idle for all stale threads. Call once on startup.
///
/// Uses `mutate_thread_metadata` for TOCTOU safety and continues past
/// corrupt/unreadable thread directories so a single bad file does not
/// block cleanup of the remaining threads.
pub fn cleanup_stale_running_threads(workspace_id: &str) -> Result<()> {
    let base = thread_workspace_dir(workspace_id)?;
    if !base.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(base)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let metadata_path = path.join("thread.json");
        if !metadata_path.exists() {
            continue;
        }
        // Read the raw file to check status before taking the lock.
        let raw = match fs::read_to_string(&metadata_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let metadata: ThreadMetadata = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if matches!(metadata.last_run_status, ThreadRunStatus::Running) {
            let thread_id = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();
            let _ = mutate_thread_metadata(workspace_id, &thread_id, |t| {
                if matches!(t.last_run_status, ThreadRunStatus::Running) {
                    t.last_run_status = ThreadRunStatus::Idle;
                    t.updated_at = Utc::now();
                }
                Ok(())
            });
        }
    }

    Ok(())
}

pub fn set_thread_full_access(
    workspace_id: &str,
    thread_id: &str,
    full_access: bool,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.full_access = full_access;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn clear_thread_claude_session(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.claude_session_id = None;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn set_thread_claude_session_id(
    workspace_id: &str,
    thread_id: &str,
    claude_session_id: &str,
) -> Result<ThreadMetadata> {
    let normalized = normalize_optional_session_id(claude_session_id);
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        if let Some(session_id) = normalized.as_deref() {
            if claude_session_id_claimed_by_other_thread_unlocked(
                workspace_id,
                thread_id,
                session_id,
            )? {
                return Err(anyhow!(
                    "Claude session id is already claimed by another thread"
                ));
            }
        }
        thread.claude_session_id = normalized.clone();
        if normalized.is_some() {
            if let Some(source_session_id) = thread.pending_fork_source_claude_session_id.clone() {
                thread.forked_from_claude_session_id = Some(source_session_id);
                thread.pending_fork_source_claude_session_id = None;
                thread.pending_fork_known_child_session_ids.clear();
                thread.pending_fork_requested_at = None;
                thread.pending_fork_launch_consumed = false;
            }
        }
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn set_thread_claude_session_id_if_missing(
    workspace_id: &str,
    thread_id: &str,
    claude_session_id: &str,
) -> Result<Option<ThreadMetadata>> {
    let Some(normalized) = normalize_optional_session_id(claude_session_id) else {
        return Ok(None);
    };

    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    let mut thread = read_thread_metadata_unlocked(workspace_id, thread_id)?;
    if thread.claude_session_id.is_some() {
        return Ok(None);
    }
    if claude_session_id_claimed_by_other_thread_unlocked(workspace_id, thread_id, &normalized)? {
        return Err(anyhow!(
            "Claude session id is already claimed by another thread"
        ));
    }

    thread.claude_session_id = Some(normalized.to_string());
    thread.updated_at = Utc::now();
    write_thread_metadata_unlocked(&thread)?;
    Ok(Some(thread))
}

pub fn create_forked_thread(
    workspace_id: &str,
    source_thread_id: &str,
    known_child_session_ids: Vec<String>,
) -> Result<ThreadMetadata> {
    let source_thread = read_thread_metadata(workspace_id, source_thread_id)?;
    let source_claude_session_id = source_thread
        .claude_session_id
        .as_deref()
        .and_then(normalize_uuid_session_id)
        .ok_or_else(|| anyhow!("Source thread does not have a valid Claude session id"))?;
    let now = Utc::now();
    let thread = ThreadMetadata {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        agent_id: source_thread.agent_id.clone(),
        full_access: source_thread.full_access,
        enabled_skills: source_thread.enabled_skills.clone(),
        created_at: now,
        updated_at: now,
        title: format!("{} (Fork)", source_thread.title),
        is_archived: false,
        last_run_status: ThreadRunStatus::Idle,
        last_run_started_at: None,
        last_run_ended_at: None,
        claude_session_id: None,
        forked_from_claude_session_id: Some(source_claude_session_id.clone()),
        pending_fork_source_claude_session_id: Some(source_claude_session_id),
        pending_fork_known_child_session_ids: known_child_session_ids,
        pending_fork_requested_at: Some(now),
        pending_fork_launch_consumed: false,
        last_resume_at: None,
        last_new_session_at: None,
    };

    initialize_thread_storage(&thread)?;
    Ok(thread)
}

pub fn fork_thread_from_ui(
    workspace_id: &str,
    source_thread_id: &str,
    source_title: &str,
    forked_title: &str,
    known_child_session_ids: Vec<String>,
) -> Result<ForkThreadResult> {
    let source_title = normalize_thread_title_input(source_title, "Source thread name")?;
    let forked_title = normalize_thread_title_input(forked_title, "Forked thread name")?;
    if source_title == forked_title {
        return Err(anyhow!("Source and forked thread names must be different"));
    }

    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    let mut source_thread = read_thread_metadata_unlocked(workspace_id, source_thread_id)?;
    let source_claude_session_id = source_thread
        .claude_session_id
        .as_deref()
        .and_then(normalize_uuid_session_id)
        .ok_or_else(|| anyhow!("Source thread does not have a valid Claude session id"))?;
    let now = Utc::now();

    source_thread.title = source_title;
    source_thread.updated_at = now;

    let forked_thread = ThreadMetadata {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        agent_id: source_thread.agent_id.clone(),
        full_access: source_thread.full_access,
        enabled_skills: source_thread.enabled_skills.clone(),
        created_at: now,
        updated_at: now,
        title: forked_title,
        is_archived: false,
        last_run_status: ThreadRunStatus::Idle,
        last_run_started_at: None,
        last_run_ended_at: None,
        claude_session_id: None,
        forked_from_claude_session_id: Some(source_claude_session_id.clone()),
        pending_fork_source_claude_session_id: Some(source_claude_session_id),
        pending_fork_known_child_session_ids: known_child_session_ids,
        pending_fork_requested_at: Some(now),
        pending_fork_launch_consumed: false,
        last_resume_at: None,
        last_new_session_at: None,
    };

    write_thread_metadata_unlocked(&source_thread)?;
    write_thread_metadata_unlocked(&forked_thread)?;
    let dir = thread_dir(&forked_thread.workspace_id, &forked_thread.id)?;
    fs::create_dir_all(dir.join("runs"))?;
    let transcript_path = dir.join("transcript.jsonl");
    if !transcript_path.exists() {
        File::create(transcript_path)?;
    }

    Ok(ForkThreadResult {
        source_thread,
        forked_thread,
    })
}

pub fn set_thread_pending_fork(
    workspace_id: &str,
    thread_id: &str,
    source_claude_session_id: &str,
    known_child_session_ids: Vec<String>,
    requested_at: DateTime<Utc>,
) -> Result<ThreadMetadata> {
    let source_claude_session_id = normalize_uuid_session_id(source_claude_session_id)
        .ok_or_else(|| anyhow!("Source Claude session id must be a UUID"))?;
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.pending_fork_source_claude_session_id = Some(source_claude_session_id.clone());
        thread.pending_fork_known_child_session_ids = known_child_session_ids;
        thread.pending_fork_requested_at = Some(requested_at);
        thread.pending_fork_launch_consumed = false;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn commit_prepared_thread_pending_fork(
    workspace_id: &str,
    thread_id: &str,
    prepared: &PreparedNativeFork,
) -> Result<ThreadMetadata> {
    let source_claude_session_id = normalize_uuid_session_id(&prepared.source_claude_session_id)
        .ok_or_else(|| anyhow!("Source Claude session id must be a UUID"))?;
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.pending_fork_source_claude_session_id = Some(source_claude_session_id.clone());
        thread.pending_fork_known_child_session_ids = prepared.known_child_session_ids.clone();
        thread.pending_fork_requested_at = Some(prepared.requested_at);
        thread.pending_fork_launch_consumed = true;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn clear_thread_pending_fork(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.pending_fork_source_claude_session_id = None;
        thread.pending_fork_known_child_session_ids.clear();
        thread.pending_fork_requested_at = None;
        thread.pending_fork_launch_consumed = false;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn mark_thread_pending_fork_consumed(
    workspace_id: &str,
    thread_id: &str,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        if thread.pending_fork_source_claude_session_id.is_some() {
            thread.pending_fork_launch_consumed = true;
            thread.updated_at = Utc::now();
        }
        Ok(())
    })
}

pub fn finalize_thread_native_fork(
    workspace_id: &str,
    thread_id: &str,
    child_claude_session_id: &str,
) -> Result<FinalizedNativeFork> {
    let child_claude_session_id = normalize_uuid_session_id(child_claude_session_id)
        .ok_or_else(|| anyhow!("Child Claude session id must be a UUID"))?;
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    let mut current_thread = read_thread_metadata_unlocked(workspace_id, thread_id)?;
    let source_claude_session_id = current_thread
        .pending_fork_source_claude_session_id
        .clone()
        .or_else(|| current_thread.claude_session_id.clone())
        .and_then(|value| normalize_uuid_session_id(&value))
        .ok_or_else(|| anyhow!("Thread is not awaiting fork resolution"))?;
    if claude_session_id_claimed_by_other_thread_unlocked(
        workspace_id,
        thread_id,
        &child_claude_session_id,
    )? {
        return Err(anyhow!(
            "Claude session id is already claimed by another thread"
        ));
    }

    let now = Utc::now();
    let preserved_thread = ThreadMetadata {
        id: Uuid::new_v4().to_string(),
        workspace_id: current_thread.workspace_id.clone(),
        agent_id: current_thread.agent_id.clone(),
        full_access: current_thread.full_access,
        enabled_skills: current_thread.enabled_skills.clone(),
        created_at: now,
        updated_at: now,
        title: format!("{} (Original)", current_thread.title),
        is_archived: false,
        last_run_status: current_thread.last_run_status.clone(),
        last_run_started_at: current_thread.last_run_started_at,
        last_run_ended_at: current_thread.last_run_ended_at,
        claude_session_id: Some(source_claude_session_id.clone()),
        forked_from_claude_session_id: current_thread.forked_from_claude_session_id.clone(),
        pending_fork_source_claude_session_id: None,
        pending_fork_known_child_session_ids: Vec::new(),
        pending_fork_requested_at: None,
        pending_fork_launch_consumed: false,
        last_resume_at: current_thread.last_resume_at,
        last_new_session_at: current_thread.last_new_session_at,
    };

    current_thread.claude_session_id = Some(child_claude_session_id);
    current_thread.forked_from_claude_session_id = Some(source_claude_session_id);
    current_thread.pending_fork_source_claude_session_id = None;
    current_thread.pending_fork_known_child_session_ids.clear();
    current_thread.pending_fork_requested_at = None;
    current_thread.pending_fork_launch_consumed = false;
    current_thread.updated_at = now;

    write_thread_metadata_unlocked(&current_thread)?;
    write_thread_metadata_unlocked(&preserved_thread)?;
    let current_dir = thread_dir(&current_thread.workspace_id, &current_thread.id)?;
    let preserved_dir = thread_dir(&preserved_thread.workspace_id, &preserved_thread.id)?;
    let current_runs_dir = current_dir.join("runs");
    let preserved_runs_dir = preserved_dir.join("runs");
    if current_runs_dir.is_dir() {
        copy_dir_recursive(&current_runs_dir, &preserved_runs_dir)?;
    } else {
        fs::create_dir_all(&preserved_runs_dir)?;
    }
    let current_transcript_path = current_dir.join("transcript.jsonl");
    let preserved_transcript_path = preserved_dir.join("transcript.jsonl");
    if current_transcript_path.is_file() {
        fs::copy(current_transcript_path, &preserved_transcript_path)?;
    } else if !preserved_transcript_path.exists() {
        File::create(preserved_transcript_path)?;
    }

    Ok(FinalizedNativeFork {
        current_thread,
        preserved_thread,
    })
}

pub fn set_thread_skills(
    workspace_id: &str,
    thread_id: &str,
    enabled_skills: Vec<String>,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.enabled_skills = enabled_skills;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn set_thread_agent(
    workspace_id: &str,
    thread_id: &str,
    agent_id: String,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.agent_id = agent_id;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn rename_thread(workspace_id: &str, thread_id: &str, title: String) -> Result<ThreadMetadata> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Thread title cannot be empty"));
    }
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.title = trimmed.chars().take(80).collect();
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn archive_thread(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.is_archived = true;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn delete_thread(workspace_id: &str, thread_id: &str) -> Result<()> {
    let path = thread_dir(workspace_id, thread_id)?;
    if !path.exists() {
        return Ok(());
    }
    let trash_dir = thread_workspace_dir(workspace_id)?.join(".trash");
    fs::create_dir_all(&trash_dir)?;
    let tombstone = trash_dir.join(format!("{thread_id}-{}", Uuid::new_v4()));

    if fs::rename(&path, &tombstone).is_ok() {
        std::thread::spawn(move || {
            let _ = fs::remove_dir_all(tombstone);
        });
        return Ok(());
    }

    fs::remove_dir_all(path)?;
    Ok(())
}

pub fn set_thread_run_state(
    workspace_id: &str,
    thread_id: &str,
    status: ThreadRunStatus,
    started_at: Option<chrono::DateTime<Utc>>,
    ended_at: Option<chrono::DateTime<Utc>>,
) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.last_run_status = status;
        if started_at.is_some() {
            thread.last_run_started_at = started_at;
        }
        if ended_at.is_some() {
            thread.last_run_ended_at = ended_at;
        }
        thread.updated_at = Utc::now();
        Ok(())
    })
}

fn transcript_path(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    Ok(thread_dir(workspace_id, thread_id)?.join("transcript.jsonl"))
}

pub fn append_transcript_entry(
    workspace_id: &str,
    thread_id: &str,
    entry: &TranscriptEntry,
) -> Result<()> {
    let path = transcript_path(workspace_id, thread_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if !path.exists() {
        File::create(&path)?;
    }
    let mut file = OpenOptions::new().append(true).open(path)?;
    let serialized = serde_json::to_string(entry)?;
    writeln!(file, "{serialized}")?;

    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.updated_at = Utc::now();
        if entry.role == "user" {
            let first_line = entry.content.lines().next().unwrap_or("New thread").trim();
            if thread.title == "New thread" && !first_line.is_empty() {
                thread.title = first_line.chars().take(50).collect();
            }
        }
        Ok(())
    })?;
    Ok(())
}

pub fn load_transcript(workspace_id: &str, thread_id: &str) -> Result<Vec<TranscriptEntry>> {
    let path = transcript_path(workspace_id, thread_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let entry: TranscriptEntry = serde_json::from_str(&line)?;
        entries.push(entry);
    }
    Ok(entries)
}

pub fn append_user_message(
    workspace_id: &str,
    thread_id: &str,
    content: &str,
) -> Result<TranscriptEntry> {
    let entry = TranscriptEntry {
        id: Uuid::new_v4().to_string(),
        role: "user".to_string(),
        content: content.to_string(),
        created_at: Utc::now(),
        run_id: None,
    };
    append_transcript_entry(workspace_id, thread_id, &entry)?;
    Ok(entry)
}

pub fn resolve_workspace_id_by_path(workspace_path: &str) -> Result<Option<String>> {
    let canonical = fs::canonicalize(workspace_path)
        .unwrap_or_else(|_| Path::new(workspace_path).to_path_buf())
        .to_string_lossy()
        .to_string();
    let workspaces = load_workspaces()?;
    Ok(workspaces
        .iter()
        .find(|workspace| workspace.path == canonical)
        .map(|workspace| workspace.id.clone()))
}

pub fn resolve_workspace_by_path(workspace_path: &str) -> Result<Option<Workspace>> {
    let canonical = fs::canonicalize(workspace_path)
        .unwrap_or_else(|_| Path::new(workspace_path).to_path_buf())
        .to_string_lossy()
        .to_string();
    let workspaces = load_workspaces()?;
    Ok(workspaces
        .iter()
        .find(|workspace| workspace.path == canonical)
        .cloned())
}

pub fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let raw = serde_json::to_string_pretty(value)?;
    write_file_atomic(path, raw.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_workspace_persists_across_loads() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!("claudex-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let added = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let first_load = load_workspaces().expect("workspaces should load");
        let second_load = load_workspaces().expect("workspaces should load after reload");

        assert_eq!(first_load.len(), 1);
        assert_eq!(second_load.len(), 1);
        assert_eq!(first_load[0].id, added.id);
        assert_eq!(first_load[0].path, second_load[0].path);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn add_ssh_workspace_persists_command_and_kind() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claudex-ssh-workspace-test-{}", Uuid::new_v4()));
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let added = add_ssh_workspace(
            "ssh dev@remote-host",
            Some("remote-host"),
            Some("  ~/projects/example  "),
        )
        .expect("ssh workspace should be added");
        assert_eq!(added.kind, WorkspaceKind::Ssh);
        assert_eq!(added.ssh_command.as_deref(), Some("ssh dev@remote-host"));
        assert_eq!(added.remote_path.as_deref(), Some("~/projects/example"));
        assert!(
            added.path.starts_with("ssh-workspace-"),
            "ssh workspace path should use deterministic non-filesystem marker"
        );

        let loaded = load_workspaces().expect("workspaces should load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, added.id);
        assert_eq!(loaded[0].kind, WorkspaceKind::Ssh);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_workspace_remote_path_trims_and_clears() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-ssh-remote-path-test-{}",
            Uuid::new_v4()
        ));
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let added = add_ssh_workspace("ssh dev@remote-host", Some("remote-host"), None)
            .expect("ssh workspace should be added");
        assert!(added.remote_path.is_none());

        let updated = set_workspace_remote_path(&added.id, Some("  ~/projects/foo  "))
            .expect("should set remote path");
        assert_eq!(updated.remote_path.as_deref(), Some("~/projects/foo"));

        let cleared =
            set_workspace_remote_path(&added.id, Some("   ")).expect("should clear remote path");
        assert!(cleared.remote_path.is_none());

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn remove_workspace_prunes_registry_and_thread_storage() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-remove-workspace-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");
        let thread_storage_dir =
            thread_dir(&workspace.id, &thread.id).expect("thread dir should resolve");
        assert!(
            thread_storage_dir.exists(),
            "thread storage should exist before workspace removal"
        );

        let removed = remove_workspace(&workspace.id).expect("workspace removal should succeed");
        assert!(removed, "workspace should report removed");
        assert!(
            !thread_workspace_dir(&workspace.id)
                .expect("workspace dir should resolve")
                .exists(),
            "workspace thread storage should be deleted"
        );

        let remaining = load_workspaces().expect("workspaces should still load");
        assert!(remaining.is_empty(), "workspace registry should be empty");

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn full_access_persists_per_thread() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claudex-thread-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");

        let updated = set_thread_full_access(&workspace.id, &thread.id, true)
            .expect("full access should update");
        assert!(updated.full_access);

        let reloaded =
            read_thread_metadata(&workspace.id, &thread.id).expect("thread should reload");
        assert!(reloaded.full_access);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn create_thread_can_start_with_full_access_enabled() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-create-thread-full-access-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), true)
            .expect("thread should be created");

        assert!(thread.full_access);

        let reloaded =
            read_thread_metadata(&workspace.id, &thread.id).expect("thread should reload");
        assert!(reloaded.full_access);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn claude_session_id_persists_per_thread() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claudex-session-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");

        let captured = set_thread_claude_session_id_if_missing(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .expect("session id should persist")
        .expect("thread should update");
        assert_eq!(
            captured.claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let duplicate = set_thread_claude_session_id_if_missing(
            &workspace.id,
            &thread.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("duplicate capture should not error");
        assert!(
            duplicate.is_none(),
            "capture should not overwrite existing session id"
        );

        let reloaded =
            read_thread_metadata(&workspace.id, &thread.id).expect("thread should reload");
        assert_eq!(
            reloaded.claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let cleared =
            clear_thread_claude_session(&workspace.id, &thread.id).expect("clear should succeed");
        assert!(cleared.claude_session_id.is_none());

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_claude_session_id_overwrites_and_trims() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claudex-force-session-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");

        let updated = set_thread_claude_session_id(
            &workspace.id,
            &thread.id,
            " 123e4567-e89b-12d3-a456-426614174000 ",
        )
        .expect("force set should succeed");
        assert_eq!(
            updated.claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let overwritten = set_thread_claude_session_id(
            &workspace.id,
            &thread.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("overwrite should succeed");
        assert_eq!(
            overwritten.claude_session_id.as_deref(),
            Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        );

        let cleared = set_thread_claude_session_id(&workspace.id, &thread.id, "   ")
            .expect("clear should succeed");
        assert!(cleared.claude_session_id.is_none());

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn rejects_invalid_thread_path_segments() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-invalid-thread-id-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);
        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");

        let error = read_thread_metadata(&workspace.id, "../escape")
            .expect_err("invalid thread id should fail");
        assert!(
            error.to_string().contains("Invalid thread id"),
            "unexpected error: {error}"
        );

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_claude_session_id_is_atomic_across_threads() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claudex-session-race-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");

        let mut handles = Vec::new();
        for _ in 0..8 {
            let workspace_id = workspace.id.clone();
            let thread_id = thread.id.clone();
            let session_candidate = Uuid::new_v4().to_string();
            handles.push(std::thread::spawn(move || {
                set_thread_claude_session_id_if_missing(
                    &workspace_id,
                    &thread_id,
                    &session_candidate,
                )
                .expect("capture should not fail")
                .and_then(|metadata| metadata.claude_session_id)
            }));
        }

        let mut captured = Vec::new();
        for handle in handles {
            if let Some(session_id) = handle.join().expect("capture worker panicked") {
                captured.push(session_id);
            }
        }

        assert_eq!(
            captured.len(),
            1,
            "exactly one concurrent capture should succeed"
        );
        let stored = read_thread_metadata(&workspace.id, &thread.id)
            .expect("thread should reload")
            .claude_session_id
            .expect("session id should be stored");
        assert_eq!(stored, captured[0]);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn create_forked_thread_clones_settings_and_sets_pending_fork_metadata() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claudex-fork-thread-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), true)
            .expect("thread should be created");
        let thread = set_thread_skills(
            &workspace.id,
            &thread.id,
            vec!["checks".to_string(), "review".to_string()],
        )
        .expect("skills should update");
        let thread = set_thread_claude_session_id(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .expect("session id should persist");

        let forked = create_forked_thread(
            &workspace.id,
            &thread.id,
            vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()],
        )
        .expect("forked thread should be created");

        assert_eq!(forked.title, "New thread (Fork)");
        assert!(forked.full_access);
        assert_eq!(forked.enabled_skills, vec!["checks", "review"]);
        assert_eq!(
            forked.pending_fork_source_claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert_eq!(
            forked.forked_from_claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert_eq!(
            forked.pending_fork_known_child_session_ids,
            vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()]
        );
        assert!(!forked.pending_fork_launch_consumed);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn fork_thread_from_ui_preserves_source_and_applies_custom_titles() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-ui-fork-thread-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), true)
            .expect("thread should be created");
        let thread = rename_thread(&workspace.id, &thread.id, "Main thread".to_string())
            .expect("rename should succeed");
        let thread = set_thread_skills(
            &workspace.id,
            &thread.id,
            vec!["checks".to_string(), "review".to_string()],
        )
        .expect("skills should update");
        let thread = set_thread_claude_session_id(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .expect("session id should persist");

        let forked = fork_thread_from_ui(
            &workspace.id,
            &thread.id,
            "Main thread (Original)",
            "Main thread",
            vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()],
        )
        .expect("ui fork should succeed");

        assert_eq!(forked.source_thread.id, thread.id);
        assert_eq!(forked.source_thread.title, "Main thread (Original)");
        assert_eq!(forked.forked_thread.title, "Main thread");
        assert_eq!(forked.forked_thread.full_access, thread.full_access);
        assert_eq!(
            forked.forked_thread.enabled_skills,
            vec!["checks", "review"]
        );
        assert_eq!(
            forked
                .forked_thread
                .pending_fork_source_claude_session_id
                .as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert_eq!(
            forked
                .forked_thread
                .forked_from_claude_session_id
                .as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let listed_threads = list_threads(&workspace.id).expect("threads should list");
        assert_eq!(listed_threads.len(), 2);
        assert!(listed_threads
            .iter()
            .any(|item| item.id == forked.source_thread.id));
        assert!(listed_threads
            .iter()
            .any(|item| item.id == forked.forked_thread.id));

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn finalize_thread_native_fork_creates_original_sibling_and_rebinds_current() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-finalize-native-fork-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");
        let thread = rename_thread(&workspace.id, &thread.id, "Main thread".to_string())
            .expect("rename should succeed");
        let thread = set_thread_claude_session_id(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .expect("session id should persist");
        let prepared = set_thread_pending_fork(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
            vec![],
            Utc::now(),
        )
        .expect("pending fork should persist");
        append_user_message(&workspace.id, &prepared.id, "Explain the fork flow.")
            .expect("user message should append");
        let run_dir = runs_dir(&workspace.id, &prepared.id)
            .expect("runs dir should resolve")
            .join("run-1");
        fs::create_dir_all(&run_dir).expect("run dir should exist");
        fs::write(run_dir.join("output.log"), "Claude output\n").expect("run log should write");

        let finalized = finalize_thread_native_fork(
            &workspace.id,
            &prepared.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("native fork should finalize");

        assert_eq!(
            finalized.current_thread.claude_session_id.as_deref(),
            Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        );
        assert_eq!(
            finalized
                .current_thread
                .forked_from_claude_session_id
                .as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert!(finalized
            .current_thread
            .pending_fork_source_claude_session_id
            .is_none());
        assert_eq!(
            finalized.preserved_thread.claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert_eq!(finalized.preserved_thread.title, "Main thread (Original)");

        let all_threads = list_threads(&workspace.id).expect("threads should list");
        assert_eq!(all_threads.len(), 2);
        assert!(all_threads
            .iter()
            .any(|item| item.id == finalized.current_thread.id));
        assert!(all_threads
            .iter()
            .any(|item| item.id == finalized.preserved_thread.id));
        let preserved_transcript = load_transcript(&workspace.id, &finalized.preserved_thread.id)
            .expect("preserved transcript should load");
        assert_eq!(preserved_transcript.len(), 1);
        assert_eq!(preserved_transcript[0].content, "Explain the fork flow.");
        assert!(runs_dir(&workspace.id, &finalized.preserved_thread.id)
            .expect("preserved runs dir should resolve")
            .join("run-1")
            .join("output.log")
            .is_file());

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn clear_thread_pending_fork_resets_pending_state_without_changing_session_id() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-clear-pending-fork-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");
        let thread = set_thread_claude_session_id(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .expect("session id should persist");
        let prepared = set_thread_pending_fork(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
            vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()],
            Utc::now(),
        )
        .expect("pending fork should persist");

        let cleared = clear_thread_pending_fork(&workspace.id, &prepared.id)
            .expect("pending fork should clear");

        assert_eq!(
            cleared.claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert!(cleared.pending_fork_source_claude_session_id.is_none());
        assert!(cleared.pending_fork_known_child_session_ids.is_empty());
        assert!(cleared.pending_fork_requested_at.is_none());
        assert!(!cleared.pending_fork_launch_consumed);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn mark_thread_pending_fork_consumed_sets_consumed_flag() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-consume-pending-fork-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");
        let prepared = set_thread_pending_fork(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
            vec![],
            Utc::now(),
        )
        .expect("pending fork should persist");

        let consumed = mark_thread_pending_fork_consumed(&workspace.id, &prepared.id)
            .expect("pending fork should mark consumed");

        assert!(consumed.pending_fork_launch_consumed);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn commit_prepared_thread_pending_fork_sets_pending_state_and_consumed_flag() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-commit-prepared-pending-fork-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread should be created");
        let prepared = PreparedNativeFork {
            source_claude_session_id: "123e4567-e89b-12d3-a456-426614174000".to_string(),
            known_child_session_ids: vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()],
            requested_at: Utc::now(),
        };

        let committed = commit_prepared_thread_pending_fork(&workspace.id, &thread.id, &prepared)
            .expect("prepared fork should commit");

        assert_eq!(
            committed.pending_fork_source_claude_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert_eq!(
            committed.pending_fork_known_child_session_ids,
            vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()]
        );
        assert_eq!(
            committed.pending_fork_requested_at,
            Some(prepared.requested_at)
        );
        assert!(committed.pending_fork_launch_consumed);

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_claude_session_id_rejects_duplicate_claims() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-duplicate-session-claim-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread_a = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread A should be created");
        let thread_b = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread B should be created");
        set_thread_claude_session_id(
            &workspace.id,
            &thread_a.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("thread A should claim the session");

        let error = set_thread_claude_session_id(
            &workspace.id,
            &thread_b.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect_err("duplicate claim should fail");

        assert!(error
            .to_string()
            .contains("already claimed by another thread"));

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_claude_session_id_allows_reuse_from_archived_thread() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "claudex-archived-session-claim-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread_a = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread A should be created");
        let thread_b = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("thread B should be created");

        set_thread_claude_session_id(
            &workspace.id,
            &thread_a.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("thread A should claim the session");
        archive_thread(&workspace.id, &thread_a.id).expect("thread A should be archived");

        let reused = set_thread_claude_session_id(
            &workspace.id,
            &thread_b.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("archived thread should not block reuse");

        assert_eq!(
            reused.claude_session_id.as_deref(),
            Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        );

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn source_session_is_unclaimed_after_native_fork_resolution_via_set_session_id() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("claudex-fork-unclaim-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("create workspace");
        std::env::set_var("CLAUDEX_APP_SUPPORT_ROOT", &temp_root);

        let workspace =
            add_workspace(workspace_path.to_string_lossy().as_ref()).expect("add workspace");
        let thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("create thread");

        let source_session = "99999999-9999-9999-9999-999999999999";
        let child_session = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

        // Bind source session to the thread.
        set_thread_claude_session_id(&workspace.id, &thread.id, source_session)
            .expect("set source session");

        // Commit a pending native fork.
        let prepared = PreparedNativeFork {
            source_claude_session_id: source_session.to_string(),
            known_child_session_ids: vec![],
            requested_at: Utc::now(),
        };
        commit_prepared_thread_pending_fork(&workspace.id, &thread.id, &prepared)
            .expect("commit pending fork");

        // Simulate resolution: rebind thread to the child session.
        let resolved = set_thread_claude_session_id(&workspace.id, &thread.id, child_session)
            .expect("resolve with child session");
        assert_eq!(resolved.claude_session_id.as_deref(), Some(child_session));
        assert!(resolved.pending_fork_source_claude_session_id.is_none());
        assert_eq!(
            resolved.forked_from_claude_session_id.as_deref(),
            Some(source_session)
        );

        // Import the source session into a brand-new thread — must succeed.
        let import_thread = create_thread(&workspace.id, Some("claude-code".to_string()), false)
            .expect("create import thread");
        let imported =
            set_thread_claude_session_id(&workspace.id, &import_thread.id, source_session)
                .expect("import source session should succeed");
        assert_eq!(imported.claude_session_id.as_deref(), Some(source_session));

        std::env::remove_var("CLAUDEX_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }
}
