use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{CodexThreadUiMetadata, Settings, Workspace};

const APP_SUPPORT_SUBDIR: &str = "Library/Application Support/ATController";
const WORKSPACES_FILE: &str = "workspaces.json";
const SETTINGS_FILE: &str = "settings.json";
const CODEX_THREAD_UI_FILE: &str = "codex-thread-ui.json";
const CODEX_THREAD_UI_VERSION: u32 = 1;
const APP_SERVER_MIGRATION_VERSION: u32 = 3;
const APP_SERVER_MIGRATION_MARKER: &str = "migrations/app-server-v3.json";
const APP_SERVER_MIGRATION_BACKUP_DIR: &str = "migration-backups/app-server-v3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexThreadUiStore {
    version: u32,
    threads: BTreeMap<String, CodexThreadUiMetadata>,
}

impl Default for CodexThreadUiStore {
    fn default() -> Self {
        Self {
            version: CODEX_THREAD_UI_VERSION,
            threads: BTreeMap::new(),
        }
    }
}

fn base_dirs_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn workspace_registry_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn codex_thread_ui_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
pub(crate) fn test_env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn app_support_root() -> Result<PathBuf> {
    #[cfg(any(test, debug_assertions))]
    {
        if let Ok(override_root) = std::env::var("ATCONTROLLER_APP_SUPPORT_ROOT") {
            if !override_root.trim().is_empty() {
                return Ok(PathBuf::from(override_root));
            }
        }
    }

    let home = dirs::home_dir().ok_or_else(|| anyhow!("Unable to resolve home directory"))?;
    Ok(home.join(APP_SUPPORT_SUBDIR))
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
        || trimmed.chars().any(char::is_control)
    {
        return Err(anyhow!("Invalid {label}"));
    }
    Ok(trimmed)
}

fn write_file_atomic(path: &Path, raw: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| anyhow!("Cannot write file without a name: {}", path.display()))?;
    let temporary = path.with_file_name(format!(".{file_name}.tmp-{}", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(raw)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn backup_file_once(source: &Path, destination: &Path) -> Result<()> {
    if !source.is_file() || destination.exists() {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, destination).with_context(|| {
        format!(
            "Unable to back up {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    if let Some(parent) = destination.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn migration_marker_is_complete(path: &Path) -> Result<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let raw = fs::read(path).with_context(|| format!("Unable to read {}", path.display()))?;
    let marker: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    Ok(marker.get("version").and_then(serde_json::Value::as_u64)
        == Some(u64::from(APP_SERVER_MIGRATION_VERSION))
        && marker
            .get("completedAt")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .is_some()
        && marker
            .get("backupDirectory")
            .and_then(serde_json::Value::as_str)
            == Some(APP_SERVER_MIGRATION_BACKUP_DIR))
}

fn read_codex_thread_ui_store_at(root: &Path) -> Result<CodexThreadUiStore> {
    let path = root.join(CODEX_THREAD_UI_FILE);
    if !path.is_file() {
        return Ok(CodexThreadUiStore::default());
    }
    let raw = fs::read(&path).with_context(|| format!("Unable to read {}", path.display()))?;
    let store: CodexThreadUiStore = serde_json::from_slice(&raw)
        .with_context(|| format!("Invalid Codex thread UI metadata in {}", path.display()))?;
    if store.version != CODEX_THREAD_UI_VERSION {
        return Err(anyhow!(
            "Unsupported Codex thread UI metadata version {}",
            store.version
        ));
    }
    Ok(store)
}

fn write_codex_thread_ui_store_at(root: &Path, store: &CodexThreadUiStore) -> Result<()> {
    write_file_atomic(
        &root.join(CODEX_THREAD_UI_FILE),
        serde_json::to_string_pretty(store)?.as_bytes(),
    )
}

fn string_field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn bool_field(value: &serde_json::Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn timestamp_field(value: &serde_json::Value, key: &str, fallback: DateTime<Utc>) -> DateTime<Utc> {
    string_field(value, key)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .unwrap_or(fallback)
}

fn record_is_incompatible_runtime(value: &serde_json::Value) -> bool {
    ["provider", "runtime", "assistant"]
        .iter()
        .filter_map(|key| string_field(value, key))
        .any(|runtime| !runtime.eq_ignore_ascii_case("codex"))
}

fn relative_report_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn load_ui_store_for_migration(root: &Path, backup_root: &Path) -> Result<CodexThreadUiStore> {
    match read_codex_thread_ui_store_at(root) {
        Ok(store) => Ok(store),
        Err(error) => {
            let source = root.join(CODEX_THREAD_UI_FILE);
            backup_file_once(&source, &backup_root.join("invalid-codex-thread-ui.json"))?;
            Ok({
                eprintln!(
                    "[migration] existing Codex thread UI metadata was invalid and preserved: {error:#}"
                );
                CodexThreadUiStore::default()
            })
        }
    }
}

fn migrate_legacy_thread_metadata(
    root: &Path,
    backup_root: &Path,
    store: &mut CodexThreadUiStore,
) -> Result<(u64, Vec<serde_json::Value>)> {
    let threads_root = root.join("threads");
    if !threads_root.is_dir() {
        return Ok((0, Vec::new()));
    }

    let mut mapped = 0u64;
    let mut incompatible = Vec::new();
    for workspace_entry in fs::read_dir(&threads_root)
        .with_context(|| format!("Unable to read {}", threads_root.display()))?
    {
        let workspace_entry = workspace_entry?;
        if !workspace_entry.file_type()?.is_dir() {
            continue;
        }
        let workspace_id = workspace_entry.file_name().to_string_lossy().to_string();
        for thread_entry in fs::read_dir(workspace_entry.path())? {
            let thread_entry = thread_entry?;
            if !thread_entry.file_type()?.is_dir() {
                continue;
            }
            let local_thread_id = thread_entry.file_name().to_string_lossy().to_string();
            let source = thread_entry.path().join("thread.json");
            if !source.is_file() {
                continue;
            }
            let backup = backup_root
                .join("thread-metadata")
                .join(&workspace_id)
                .join(format!("{local_thread_id}.json"));
            backup_file_once(&source, &backup)?;

            let value = match fs::read(&source)
                .ok()
                .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
            {
                Some(value) => value,
                None => {
                    incompatible.push(serde_json::json!({
                        "workspaceId": workspace_id,
                        "localThreadId": local_thread_id,
                        "reason": "unreadable or invalid legacy metadata",
                        "backup": relative_report_path(root, &backup)
                    }));
                    continue;
                }
            };

            if record_is_incompatible_runtime(&value) {
                incompatible.push(serde_json::json!({
                    "workspaceId": workspace_id,
                    "localThreadId": local_thread_id,
                    "reason": "thread belongs to an incompatible legacy runtime",
                    "backup": relative_report_path(root, &backup)
                }));
                continue;
            }

            let Some(canonical_thread_id) = string_field(&value, "codexSessionId") else {
                incompatible.push(serde_json::json!({
                    "workspaceId": workspace_id,
                    "localThreadId": local_thread_id,
                    "reason": "no canonical Codex thread identifier",
                    "backup": relative_report_path(root, &backup)
                }));
                continue;
            };
            if validate_storage_segment(canonical_thread_id, "Codex thread id").is_err() {
                incompatible.push(serde_json::json!({
                    "workspaceId": workspace_id,
                    "localThreadId": local_thread_id,
                    "reason": "invalid canonical Codex thread identifier",
                    "backup": relative_report_path(root, &backup)
                }));
                continue;
            }

            let now = Utc::now();
            let mut ui = store
                .threads
                .remove(canonical_thread_id)
                .unwrap_or_else(|| {
                    CodexThreadUiMetadata::new(
                        canonical_thread_id.to_string(),
                        workspace_id.clone(),
                    )
                });
            ui.thread_id = canonical_thread_id.to_string();
            ui.workspace_id = workspace_id.clone();
            ui.fallback_title = string_field(&value, "title")
                .unwrap_or_default()
                .to_string();
            ui.pinned = bool_field(&value, "pinned");
            ui.unread = bool_field(&value, "unread");
            ui.permission_mode = if bool_field(&value, "fullAccess") {
                "fullAccess".to_string()
            } else {
                "workspaceAccess".to_string()
            };
            ui.created_at = timestamp_field(&value, "createdAt", now);
            ui.updated_at = timestamp_field(&value, "updatedAt", ui.created_at);
            store
                .threads
                .insert(canonical_thread_id.to_string(), ui.normalized());
            mapped += 1;
        }
    }
    Ok((mapped, incompatible))
}

fn preserve_and_filter_legacy_workspaces(
    root: &Path,
    backup_root: &Path,
) -> Result<Vec<serde_json::Value>> {
    let path = root.join(WORKSPACES_FILE);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    backup_file_once(&path, &backup_root.join(WORKSPACES_FILE))?;
    let raw = fs::read(&path)?;
    let values = match serde_json::from_slice::<Vec<serde_json::Value>>(&raw) {
        Ok(values) => values,
        Err(_) => return Ok(Vec::new()),
    };
    let mut incompatible = Vec::new();
    for value in values {
        let kind = string_field(&value, "kind").unwrap_or("local");
        if !kind.eq_ignore_ascii_case("local") {
            incompatible.push(serde_json::json!({
                "workspaceId": string_field(&value, "id"),
                "name": string_field(&value, "name"),
                "reason": "remote legacy workspace is not supported by the local Codex runtime",
                "backup": format!("{APP_SERVER_MIGRATION_BACKUP_DIR}/{WORKSPACES_FILE}")
            }));
        }
    }
    Ok(incompatible)
}

fn run_app_server_migration(root: &Path) -> Result<()> {
    let marker_path = root.join(APP_SERVER_MIGRATION_MARKER);
    if migration_marker_is_complete(&marker_path)? {
        return Ok(());
    }

    let backup_root = root.join(APP_SERVER_MIGRATION_BACKUP_DIR);
    fs::create_dir_all(&backup_root)?;
    backup_file_once(&root.join(SETTINGS_FILE), &backup_root.join(SETTINGS_FILE))?;
    let incompatible_workspaces = preserve_and_filter_legacy_workspaces(root, &backup_root)?;
    let mut store = load_ui_store_for_migration(root, &backup_root)?;
    let (mapped_thread_count, incompatible_threads) =
        migrate_legacy_thread_metadata(root, &backup_root, &mut store)?;
    write_codex_thread_ui_store_at(root, &store)?;

    let report = serde_json::json!({
        "version": APP_SERVER_MIGRATION_VERSION,
        "note": "These records were not passed to Codex. Original metadata remains in place and is backed up.",
        "threads": incompatible_threads,
        "workspaces": incompatible_workspaces
    });
    write_file_atomic(
        &backup_root.join("incompatible-legacy-metadata.json"),
        serde_json::to_string_pretty(&report)?.as_bytes(),
    )?;

    let settings_path = root.join(SETTINGS_FILE);
    if settings_path.is_file() {
        if let Ok(mut settings) =
            serde_json::from_slice::<serde_json::Value>(&fs::read(&settings_path)?)
        {
            settings["defaultPermissionMode"] = serde_json::Value::String("fullAccess".to_string());
            settings["defaultNewThreadFullAccess"] = serde_json::Value::Bool(true);
            write_file_atomic(
                &settings_path,
                serde_json::to_string_pretty(&settings)?.as_bytes(),
            )?;
        }
    }

    let marker = serde_json::json!({
        "version": APP_SERVER_MIGRATION_VERSION,
        "completedAt": Utc::now(),
        "mappedThreadCount": mapped_thread_count,
        "incompatibleThreadCount": report["threads"].as_array().map(Vec::len).unwrap_or(0),
        "incompatibleWorkspaceCount": report["workspaces"].as_array().map(Vec::len).unwrap_or(0),
        "backupDirectory": APP_SERVER_MIGRATION_BACKUP_DIR,
        "uiMetadataFile": CODEX_THREAD_UI_FILE
    });
    write_file_atomic(
        &marker_path,
        serde_json::to_string_pretty(&marker)?.as_bytes(),
    )
    .with_context(|| format!("Unable to record migration {}", marker_path.display()))
}

pub fn ensure_base_dirs() -> Result<PathBuf> {
    let _guard = base_dirs_lock()
        .lock()
        .map_err(|_| anyhow!("Application storage lock poisoned"))?;
    let root = app_support_root()?;
    fs::create_dir_all(&root)?;
    run_app_server_migration(&root)?;
    if !root.join(WORKSPACES_FILE).exists() {
        write_file_atomic(&root.join(WORKSPACES_FILE), b"[]")?;
    }
    if !root.join(SETTINGS_FILE).exists() {
        write_file_atomic(
            &root.join(SETTINGS_FILE),
            serde_json::to_string_pretty(&Settings::default())?.as_bytes(),
        )?;
    }
    Ok(root)
}

fn workspaces_file() -> Result<PathBuf> {
    Ok(ensure_base_dirs()?.join(WORKSPACES_FILE))
}

fn settings_file() -> Result<PathBuf> {
    Ok(ensure_base_dirs()?.join(SETTINGS_FILE))
}

pub fn load_settings() -> Result<Settings> {
    let file = settings_file()?;
    let raw =
        fs::read_to_string(&file).with_context(|| format!("Unable to read {}", file.display()))?;
    let settings: Settings = serde_json::from_str(&raw)
        .with_context(|| format!("Invalid settings JSON in {}", file.display()))?;
    Ok(settings.normalized())
}

pub fn save_settings(settings: &Settings) -> Result<()> {
    let file = settings_file()?;
    write_file_atomic(
        &file,
        serde_json::to_string_pretty(&settings.clone().normalized())?.as_bytes(),
    )
}

fn parse_local_workspaces(raw: &str) -> Result<Vec<Workspace>> {
    let values: Vec<serde_json::Value> = serde_json::from_str(raw)?;
    let mut result = Vec::new();
    for value in values {
        let kind = string_field(&value, "kind").unwrap_or("local");
        if !kind.eq_ignore_ascii_case("local") {
            continue;
        }
        result.push(serde_json::from_value(value)?);
    }
    Ok(result)
}

pub fn load_workspaces() -> Result<Vec<Workspace>> {
    let file = workspaces_file()?;
    let raw =
        fs::read_to_string(&file).with_context(|| format!("Unable to read {}", file.display()))?;
    parse_local_workspaces(&raw)
        .with_context(|| format!("Invalid workspace JSON in {}", file.display()))
}

fn save_workspaces(workspaces: &[Workspace]) -> Result<()> {
    write_file_atomic(
        &workspaces_file()?,
        serde_json::to_string_pretty(workspaces)?.as_bytes(),
    )
}

pub fn add_workspace(path: &str) -> Result<Workspace> {
    let canonical_path = fs::canonicalize(path)
        .with_context(|| format!("Unable to resolve workspace path: {path}"))?;
    if !canonical_path.is_dir() {
        return Err(anyhow!("Workspace path is not a directory"));
    }
    let canonical = canonical_path.to_string_lossy().to_string();
    let _guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
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
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Project".to_string()),
        path: canonical,
        git_pull_on_master_for_new_threads: false,
        created_at: now,
        updated_at: now,
    };
    workspaces.push(workspace.clone());
    save_workspaces(&workspaces)?;
    Ok(workspace)
}

pub fn remove_workspace(workspace_id: &str) -> Result<bool> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let _guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
    let mut workspaces = load_workspaces()?;
    let original_len = workspaces.len();
    workspaces.retain(|workspace| workspace.id != workspace_id);
    if workspaces.len() == original_len {
        return Ok(false);
    }
    save_workspaces(&workspaces)?;
    Ok(true)
}

pub fn set_workspace_git_pull_on_master_for_new_threads(
    workspace_id: &str,
    enabled: bool,
) -> Result<Workspace> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let _guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
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

pub fn set_workspace_order(workspace_ids: Vec<String>) -> Result<Vec<Workspace>> {
    let _guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
    let mut workspaces = load_workspaces()?;
    let mut seen = HashSet::new();
    let requested = workspace_ids
        .into_iter()
        .map(|id| validate_storage_segment(&id, "workspace id").map(str::to_string))
        .collect::<Result<Vec<_>>>()?;
    let mut ordered = Vec::with_capacity(workspaces.len());
    for id in requested {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(index) = workspaces.iter().position(|workspace| workspace.id == id) {
            ordered.push(workspaces.remove(index));
        }
    }
    ordered.extend(workspaces);
    save_workspaces(&ordered)?;
    Ok(ordered)
}

pub fn resolve_workspace_by_path(workspace_path: &str) -> Result<Option<Workspace>> {
    let requested = fs::canonicalize(workspace_path)
        .unwrap_or_else(|_| PathBuf::from(workspace_path))
        .to_string_lossy()
        .to_string();
    Ok(load_workspaces()?
        .into_iter()
        .find(|workspace| workspace.path == requested))
}

pub fn list_codex_thread_ui_metadata(workspace_id: &str) -> Result<Vec<CodexThreadUiMetadata>> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let root = ensure_base_dirs()?;
    let _guard = codex_thread_ui_lock()
        .lock()
        .map_err(|_| anyhow!("Codex thread UI metadata lock poisoned"))?;
    let mut metadata = read_codex_thread_ui_store_at(&root)?
        .threads
        .into_values()
        .filter(|thread| thread.workspace_id == workspace_id)
        .collect::<Vec<_>>();
    metadata.sort_by_key(|thread| std::cmp::Reverse(thread.updated_at));
    Ok(metadata)
}

pub fn get_codex_thread_ui_metadata(
    workspace_id: &str,
    thread_id: &str,
) -> Result<CodexThreadUiMetadata> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let thread_id = validate_storage_segment(thread_id, "thread id")?;
    let root = ensure_base_dirs()?;
    let _guard = codex_thread_ui_lock()
        .lock()
        .map_err(|_| anyhow!("Codex thread UI metadata lock poisoned"))?;
    let mut store = read_codex_thread_ui_store_at(&root)?;
    if let Some(metadata) = store.threads.get(thread_id) {
        if metadata.workspace_id != workspace_id {
            return Err(anyhow!("Codex thread belongs to a different workspace"));
        }
        return Ok(metadata.clone());
    }
    let metadata =
        CodexThreadUiMetadata::new(thread_id.to_string(), workspace_id.to_string()).normalized();
    store
        .threads
        .insert(thread_id.to_string(), metadata.clone());
    write_codex_thread_ui_store_at(&root, &store)?;
    Ok(metadata)
}

pub fn save_codex_thread_ui_metadata(
    metadata: CodexThreadUiMetadata,
) -> Result<CodexThreadUiMetadata> {
    let thread_id = validate_storage_segment(&metadata.thread_id, "thread id")?.to_string();
    let workspace_id =
        validate_storage_segment(&metadata.workspace_id, "workspace id")?.to_string();
    if !load_workspaces()?
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Err(anyhow!("Workspace not found"));
    }
    let root = ensure_base_dirs()?;
    let _guard = codex_thread_ui_lock()
        .lock()
        .map_err(|_| anyhow!("Codex thread UI metadata lock poisoned"))?;
    let mut store = read_codex_thread_ui_store_at(&root)?;
    if let Some(existing) = store.threads.get(&thread_id) {
        if existing.workspace_id != workspace_id {
            return Err(anyhow!("Codex thread belongs to a different workspace"));
        }
    }
    let mut metadata = metadata.normalized();
    metadata.thread_id = thread_id.clone();
    metadata.workspace_id = workspace_id;
    metadata.updated_at = Utc::now();
    store.threads.insert(thread_id, metadata.clone());
    write_codex_thread_ui_store_at(&root, &store)?;
    Ok(metadata)
}

pub fn ensure_codex_thread_ui_metadata(
    workspace_path: &str,
    thread_id: &str,
    fallback_title: &str,
    permission_mode: &str,
    requested_model: Option<String>,
    requested_reasoning_effort: Option<String>,
    requested_service_tier: Option<String>,
) -> Result<CodexThreadUiMetadata> {
    let workspace =
        resolve_workspace_by_path(workspace_path)?.ok_or_else(|| anyhow!("Workspace not found"))?;
    let mut metadata = get_codex_thread_ui_metadata(&workspace.id, thread_id)?;
    if !fallback_title.trim().is_empty() {
        metadata.fallback_title = fallback_title.to_string();
    }
    metadata.permission_mode = permission_mode.to_string();
    metadata.requested_model = requested_model;
    metadata.requested_reasoning_effort = requested_reasoning_effort;
    metadata.requested_service_tier = requested_service_tier;
    save_codex_thread_ui_metadata(metadata)
}

pub fn remove_codex_thread_ui_metadata(thread_id: &str) -> Result<()> {
    let thread_id = validate_storage_segment(thread_id, "thread id")?;
    let root = ensure_base_dirs()?;
    let _guard = codex_thread_ui_lock()
        .lock()
        .map_err(|_| anyhow!("Codex thread UI metadata lock poisoned"))?;
    let mut store = read_codex_thread_ui_store_at(&root)?;
    if store.threads.remove(thread_id).is_some() {
        write_codex_thread_ui_store_at(&root, &store)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStorage {
        _guard: std::sync::MutexGuard<'static, ()>,
        root: PathBuf,
    }

    impl TestStorage {
        fn new() -> Self {
            let guard = test_env_lock().lock().expect("test environment lock");
            let root =
                std::env::temp_dir().join(format!("atcontroller-storage-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).expect("temporary storage");
            std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &root);
            Self {
                _guard: guard,
                root,
            }
        }
    }

    impl Drop for TestStorage {
        fn drop(&mut self) {
            std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn initializes_atcontroller_storage_files() {
        let storage = TestStorage::new();
        let root = ensure_base_dirs().expect("base directories");
        assert_eq!(root, storage.root);
        assert!(root.join(WORKSPACES_FILE).is_file());
        assert!(root.join(SETTINGS_FILE).is_file());
        assert!(root.join(APP_SERVER_MIGRATION_MARKER).is_file());
    }

    #[test]
    fn adds_and_reorders_local_projects_with_spaces() {
        let storage = TestStorage::new();
        let first_path = storage.root.join("Project With Spaces");
        let second_path = storage.root.join("Second Project");
        fs::create_dir_all(&first_path).expect("first project");
        fs::create_dir_all(&second_path).expect("second project");
        let first = add_workspace(first_path.to_str().unwrap()).expect("add first");
        let second = add_workspace(second_path.to_str().unwrap()).expect("add second");
        let duplicate = add_workspace(first_path.to_str().unwrap()).expect("dedupe");
        assert_eq!(duplicate.id, first.id);
        let ordered = set_workspace_order(vec![second.id.clone(), first.id.clone()])
            .expect("reorder projects");
        assert_eq!(ordered[0].id, second.id);
        assert_eq!(ordered[1].id, first.id);
    }

    #[test]
    fn settings_round_trip_preserves_full_access_default() {
        let _storage = TestStorage::new();
        let settings = Settings {
            default_model: Some(" runtime-model ".to_string()),
            ..Settings::default()
        };
        save_settings(&settings).expect("save settings");
        let loaded = load_settings().expect("load settings");
        assert_eq!(loaded.default_permission_mode, "fullAccess");
        assert_eq!(loaded.default_model.as_deref(), Some("runtime-model"));
    }

    #[test]
    fn thread_ui_metadata_is_keyed_by_canonical_thread_id() {
        let storage = TestStorage::new();
        let project = storage.root.join("Project");
        fs::create_dir_all(&project).expect("project");
        let workspace = add_workspace(project.to_str().unwrap()).expect("workspace");
        let mut metadata =
            get_codex_thread_ui_metadata(&workspace.id, "thread-1").expect("metadata");
        metadata.pinned = true;
        metadata.draft = "continue here".to_string();
        save_codex_thread_ui_metadata(metadata).expect("save metadata");
        let listed = list_codex_thread_ui_metadata(&workspace.id).expect("list metadata");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].thread_id, "thread-1");
        assert!(listed[0].pinned);
    }

    #[test]
    fn migration_backs_up_and_never_maps_incompatible_records() {
        let storage = TestStorage::new();
        let legacy_root = storage.root.join("threads").join("workspace-1");
        let valid_dir = legacy_root.join("local-valid");
        let incompatible_dir = legacy_root.join("local-incompatible");
        fs::create_dir_all(&valid_dir).expect("valid legacy directory");
        fs::create_dir_all(&incompatible_dir).expect("incompatible legacy directory");
        fs::write(
            valid_dir.join("thread.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "local-valid",
                "workspaceId": "workspace-1",
                "title": "Real Codex thread",
                "codexSessionId": "canonical-thread-1",
                "fullAccess": true,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-02T00:00:00Z"
            }))
            .unwrap(),
        )
        .expect("valid legacy metadata");
        fs::write(
            incompatible_dir.join("thread.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "local-incompatible",
                "workspaceId": "workspace-1",
                "provider": "legacy-runtime",
                "codexSessionId": "must-not-be-used"
            }))
            .unwrap(),
        )
        .expect("incompatible legacy metadata");

        ensure_base_dirs().expect("migration");
        let store = read_codex_thread_ui_store_at(&storage.root).expect("UI store");
        assert!(store.threads.contains_key("canonical-thread-1"));
        assert!(!store.threads.contains_key("must-not-be-used"));
        assert!(valid_dir.join("thread.json").is_file());
        assert!(incompatible_dir.join("thread.json").is_file());
        assert!(storage
            .root
            .join(APP_SERVER_MIGRATION_BACKUP_DIR)
            .join("thread-metadata/workspace-1/local-valid.json")
            .is_file());
        let report = fs::read_to_string(
            storage
                .root
                .join(APP_SERVER_MIGRATION_BACKUP_DIR)
                .join("incompatible-legacy-metadata.json"),
        )
        .expect("migration report");
        assert!(report.contains("local-incompatible"));
    }
}
