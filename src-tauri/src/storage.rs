use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::models::{
    PreparedNativeFork, Settings, ThreadMetadata, ThreadRunStatus, Workspace, WorkspaceKind,
};

const APP_SUPPORT_SUBDIR: &str = "Library/Application Support/ATController";
const CODEX_ONLY_MIGRATION_VERSION: u32 = 1;
const CODEX_ONLY_MIGRATION_MARKER: &str = "migrations/codex-only-v1.json";
const CODEX_SIDEBAR_MIGRATION_VERSION: u32 = 2;
const CODEX_SIDEBAR_MIGRATION_MARKER: &str = "migrations/codex-sidebar-v2.json";
const CODEX_SIDEBAR_MIGRATION_BACKUP_DIR: &str = "migration-backups/codex-sidebar-v2/threads";
const HIDDEN_CODEX_SESSIONS_FILE: &str = "sidebar-hidden-codex-sessions.json";
const HIDDEN_CODEX_SESSIONS_VERSION: u32 = 1;
pub(crate) const CODEX_COMMAND_PLACEHOLDER: &str = "{CODEX_CMD}";
const REMOTE_COMMAND_MAX_BYTES: usize = 4 * 1024;
const REMOTE_COMMAND_MAX_ARGUMENTS: usize = 128;

#[derive(Debug)]
struct ParsedRemoteCommand {
    tokens: Vec<String>,
    destination: Option<String>,
}

fn parse_remote_command_words(command: &str, label: &str) -> Result<Vec<String>> {
    if command.chars().any(|character| character.is_control()) {
        return Err(anyhow!(
            "{label} command must be one line and cannot contain control characters."
        ));
    }
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Please enter a {label} command."));
    }
    if trimmed.len() > REMOTE_COMMAND_MAX_BYTES {
        return Err(anyhow!(
            "{label} command is too long (maximum {REMOTE_COMMAND_MAX_BYTES} bytes)."
        ));
    }
    let tokens = shell_words::split(trimmed)
        .map_err(|error| anyhow!("Unable to parse {label} command: {error}"))?;
    if tokens.is_empty() {
        return Err(anyhow!("Please enter a {label} command."));
    }
    if tokens.len() > REMOTE_COMMAND_MAX_ARGUMENTS {
        return Err(anyhow!(
            "{label} command has too many arguments (maximum {REMOTE_COMMAND_MAX_ARGUMENTS})."
        ));
    }

    let mut placeholder_count = 0;
    for token in &tokens {
        if token == CODEX_COMMAND_PLACEHOLDER {
            placeholder_count += 1;
            continue;
        }
        if token.contains(CODEX_COMMAND_PLACEHOLDER) {
            return Err(anyhow!(
                "{label} command must use {CODEX_COMMAND_PLACEHOLDER} as a separate final argument."
            ));
        }
        if token.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    ';' | '|' | '&' | '<' | '>' | '$' | '`' | '\\' | '(' | ')'
                )
        }) {
            return Err(anyhow!(
                "{label} command cannot contain shell operators, substitutions, or redirects."
            ));
        }
    }
    if placeholder_count > 1
        || (placeholder_count == 1
            && tokens.last().map(String::as_str) != Some(CODEX_COMMAND_PLACEHOLDER))
    {
        return Err(anyhow!(
            "{label} command must use {CODEX_COMMAND_PLACEHOLDER} at most once, as the final argument."
        ));
    }

    Ok(tokens)
}

fn join_remote_command_tokens(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| {
            if token == CODEX_COMMAND_PLACEHOLDER {
                token.clone()
            } else {
                format!("'{}'", token.replace('\'', "'\"'\"'"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn ssh_option_requires_argument(option: char) -> bool {
    matches!(
        option,
        'B' | 'b'
            | 'c'
            | 'D'
            | 'E'
            | 'e'
            | 'F'
            | 'I'
            | 'i'
            | 'J'
            | 'L'
            | 'l'
            | 'm'
            | 'O'
            | 'o'
            | 'P'
            | 'p'
            | 'Q'
            | 'R'
            | 'S'
            | 'W'
            | 'w'
    )
}

fn validate_ssh_config_option(value: &str) -> Result<()> {
    let option_name = value
        .trim()
        .split(|character: char| character == '=' || character.is_ascii_whitespace())
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if option_name.is_empty() {
        return Err(anyhow!("SSH `-o` requires a configuration option."));
    }
    if matches!(
        option_name.as_str(),
        "include"
            | "forkafterauthentication"
            | "knownhostscommand"
            | "localcommand"
            | "permitlocalcommand"
            | "pkcs11provider"
            | "proxycommand"
            | "remotecommand"
            | "securitykeyprovider"
            | "sessiontype"
            | "stdinnull"
    ) {
        return Err(anyhow!(
            "SSH option `{option_name}` is not supported because it can load or execute a local helper. Put trusted connection settings in ~/.ssh/config instead."
        ));
    }
    Ok(())
}

fn consume_ssh_option(tokens: &[String], index: &mut usize, command_end: usize) -> Result<()> {
    let token = &tokens[*index];
    let option_text = token
        .strip_prefix('-')
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("Invalid SSH option `{token}`."))?;
    for (offset, option) in option_text.char_indices() {
        if matches!(option, 'G' | 'N' | 'n' | 'O' | 'Q' | 's' | 'T' | 'V' | 'W') {
            return Err(anyhow!(
                "SSH option `-{option}` is not supported because it prevents ATController from starting an interactive Codex session."
            ));
        }
        if ssh_option_requires_argument(option) {
            if matches!(option, 'F' | 'I') {
                return Err(anyhow!(
                    "SSH option `-{option}` is not supported because it can load command-supplied local configuration or code. Put trusted connection settings in ~/.ssh/config instead."
                ));
            }

            let attached_offset = offset + option.len_utf8();
            let attached_value = &option_text[attached_offset..];
            let value = if attached_value.is_empty() {
                *index += 1;
                if *index >= command_end {
                    return Err(anyhow!("SSH option `-{option}` requires an argument."));
                }
                tokens[*index].as_str()
            } else {
                attached_value
            };
            if value == CODEX_COMMAND_PLACEHOLDER {
                return Err(anyhow!(
                    "{CODEX_COMMAND_PLACEHOLDER} can only be the final SSH command argument."
                ));
            }
            if option == 'o' {
                validate_ssh_config_option(value)?;
            }
            *index += 1;
            return Ok(());
        }

        if !"46AaCfGgKkMNnqsTtVvXxYy".contains(option) {
            return Err(anyhow!("Unsupported SSH option `-{option}`."));
        }
    }

    *index += 1;
    Ok(())
}

fn parse_ssh_command(command: &str) -> Result<ParsedRemoteCommand> {
    let tokens = parse_remote_command_words(command, "SSH")?;
    if tokens.first().map(String::as_str) != Some("ssh") {
        return Err(anyhow!(
            "SSH command must start with `ssh` (example: ssh user@host)."
        ));
    }

    let command_end = if tokens.last().map(String::as_str) == Some(CODEX_COMMAND_PLACEHOLDER) {
        tokens.len() - 1
    } else {
        tokens.len()
    };
    let mut index = 1;
    let mut destination = None;
    let mut options_ended = false;
    while index < command_end {
        let token = &tokens[index];
        if destination.is_some() {
            return Err(anyhow!(
                "SSH command cannot include a custom remote command. ATController launches Codex after connecting; use {CODEX_COMMAND_PLACEHOLDER} only as the final argument when a command placeholder is required."
            ));
        }
        if !options_ended && token == "--" {
            options_ended = true;
            index += 1;
            continue;
        }
        if !options_ended && token.starts_with('-') {
            consume_ssh_option(&tokens, &mut index, command_end)?;
            continue;
        }
        if token.is_empty() || token.starts_with('-') || token == CODEX_COMMAND_PLACEHOLDER {
            return Err(anyhow!("SSH command has an invalid destination."));
        }
        destination = Some(token.clone());
        index += 1;
    }

    if destination.is_none() {
        return Err(anyhow!(
            "SSH command must include a destination (example: ssh user@host)."
        ));
    }
    Ok(ParsedRemoteCommand {
        tokens,
        destination,
    })
}

fn rdev_option_requires_argument(option: &str) -> Option<bool> {
    match option {
        "-p" | "--forward-port" | "--ssh-log-level" | "-f" | "--flavor" => Some(true),
        "-n" | "--new" | "-c" | "--color" | "--tmux" | "-d" | "--non-tmux" | "-h" | "--help" => {
            Some(false)
        }
        _ => None,
    }
}

fn parse_rdev_ssh_command(command: &str, ensure_non_tmux: bool) -> Result<ParsedRemoteCommand> {
    let mut tokens = parse_remote_command_words(command, "rdev ssh")?;
    if tokens.first().map(String::as_str) != Some("rdev")
        || tokens.get(1).map(String::as_str) != Some("ssh")
    {
        return Err(anyhow!(
            "rdev command must start with `rdev ssh` (example: rdev ssh <workspace>/<env>)."
        ));
    }

    let placeholder = tokens.last().map(String::as_str) == Some(CODEX_COMMAND_PLACEHOLDER);
    let command_end = tokens.len() - usize::from(placeholder);
    let mut index = 2;
    let mut destination = None;
    let mut explicit_tmux_mode = false;
    while index < command_end {
        let token = &tokens[index];
        let (option, attached_value) = if let Some((option, value)) = token.split_once('=') {
            (option, Some(value))
        } else if token.starts_with("-p") && token.len() > 2 {
            ("-p", Some(&token[2..]))
        } else if token.starts_with("-f") && token.len() > 2 {
            ("-f", Some(&token[2..]))
        } else {
            (token.as_str(), None)
        };

        if option.starts_with('-') {
            let requires_argument = rdev_option_requires_argument(option)
                .ok_or_else(|| anyhow!("Unsupported rdev ssh option `{option}`."))?;
            if matches!(option, "--tmux" | "-d" | "--non-tmux") {
                explicit_tmux_mode = true;
            }
            if requires_argument && attached_value.is_none() {
                index += 1;
                if index >= command_end || tokens[index] == CODEX_COMMAND_PLACEHOLDER {
                    return Err(anyhow!("rdev ssh option `{option}` requires an argument."));
                }
            } else if !requires_argument && attached_value.is_some() {
                return Err(anyhow!(
                    "rdev ssh option `{option}` does not accept an argument."
                ));
            }
            index += 1;
            continue;
        }

        if destination.is_some() {
            return Err(anyhow!(
                "rdev ssh command accepts at most one environment name and cannot include a custom command. Use {CODEX_COMMAND_PLACEHOLDER} only as the final argument."
            ));
        }
        destination = Some(token.clone());
        index += 1;
    }

    if ensure_non_tmux && !explicit_tmux_mode {
        let insertion_index = tokens.len() - usize::from(placeholder);
        tokens.insert(insertion_index, "--non-tmux".to_string());
    }

    Ok(ParsedRemoteCommand {
        tokens,
        destination,
    })
}

pub(crate) fn canonicalize_ssh_command(command: &str) -> Result<String> {
    Ok(join_remote_command_tokens(
        &parse_ssh_command(command)?.tokens,
    ))
}

pub(crate) fn canonicalize_rdev_ssh_command(
    command: &str,
    ensure_non_tmux: bool,
) -> Result<String> {
    Ok(join_remote_command_tokens(
        &parse_rdev_ssh_command(command, ensure_non_tmux)?.tokens,
    ))
}

pub(crate) fn validate_remote_path(path: &str) -> Result<String> {
    if path.chars().any(|character| character.is_control()) {
        return Err(anyhow!(
            "Remote path must be one line and cannot contain control characters."
        ));
    }
    let trimmed = path.trim();
    if trimmed.len() > REMOTE_COMMAND_MAX_BYTES {
        return Err(anyhow!(
            "Remote path is too long (maximum {REMOTE_COMMAND_MAX_BYTES} bytes)."
        ));
    }
    Ok(trimmed.to_string())
}

fn thread_metadata_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn workspace_registry_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn hidden_codex_sessions_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn workspace_deletion_marker_path(workspace_id: &str) -> Result<PathBuf> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    Ok(app_support_root()?
        .join("tombstones/workspaces")
        .join(workspace_id))
}

fn thread_deletion_marker_path(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let thread_id = validate_storage_segment(thread_id, "thread id")?;
    Ok(app_support_root()?
        .join("tombstones/threads")
        .join(workspace_id)
        .join(thread_id))
}

fn ensure_workspace_storage_live_unlocked(workspace_id: &str) -> Result<()> {
    if workspace_deletion_marker_path(workspace_id)?.exists() {
        return Err(anyhow!("Workspace storage has been deleted"));
    }
    Ok(())
}

fn ensure_thread_storage_live_unlocked(workspace_id: &str, thread_id: &str) -> Result<()> {
    ensure_workspace_storage_live_unlocked(workspace_id)?;
    if thread_deletion_marker_path(workspace_id, thread_id)?.exists() {
        return Err(anyhow!("Thread storage has been deleted"));
    }
    Ok(())
}

fn mark_workspace_storage_deleted_unlocked(workspace_id: &str) -> Result<()> {
    let marker = workspace_deletion_marker_path(workspace_id)?;
    write_file_atomic(&marker, Utc::now().to_rfc3339().as_bytes())
}

fn mark_thread_storage_deleted_unlocked(workspace_id: &str, thread_id: &str) -> Result<()> {
    let marker = thread_deletion_marker_path(workspace_id, thread_id)?;
    write_file_atomic(&marker, Utc::now().to_rfc3339().as_bytes())
}

fn base_dirs_lock() -> &'static Mutex<()> {
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

fn validate_thread_metadata_identity(
    metadata: &ThreadMetadata,
    workspace_id: &str,
    thread_id: &str,
) -> Result<()> {
    let expected_workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let expected_thread_id = validate_storage_segment(thread_id, "thread id")?;
    if metadata.id != expected_thread_id || metadata.workspace_id != expected_workspace_id {
        return Err(anyhow!(
            "Thread metadata identity does not match its storage directory"
        ));
    }
    Ok(())
}

fn parse_thread_metadata_for_location(
    raw: &str,
    workspace_id: &str,
    thread_id: &str,
) -> Result<ThreadMetadata> {
    let metadata: ThreadMetadata = serde_json::from_str(raw)?;
    validate_thread_metadata_identity(&metadata, workspace_id, thread_id)?;
    Ok(metadata)
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
    let write_result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(raw)?;
        file.sync_all()?;
        fs::rename(&temp_path, path)?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

fn read_hidden_codex_sessions_unlocked(root: &Path) -> Result<BTreeSet<String>> {
    let path = root.join(HIDDEN_CODEX_SESSIONS_FILE);
    if !path.is_file() {
        return Ok(BTreeSet::new());
    }
    let raw = fs::read(&path).with_context(|| format!("Unable to read {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_slice(&raw)
        .with_context(|| format!("Invalid hidden Codex session data in {}", path.display()))?;
    if value.get("version").and_then(serde_json::Value::as_u64)
        != Some(u64::from(HIDDEN_CODEX_SESSIONS_VERSION))
    {
        return Err(anyhow!(
            "Unsupported hidden Codex session data in {}",
            path.display()
        ));
    }
    let session_ids = value
        .get("sessionIds")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow!("Hidden Codex session data is missing sessionIds"))?;
    session_ids
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|session_id| !session_id.is_empty())
                .map(str::to_string)
                .ok_or_else(|| anyhow!("Hidden Codex session data contains an invalid session ID"))
        })
        .collect()
}

fn write_hidden_codex_sessions_unlocked(root: &Path, session_ids: &BTreeSet<String>) -> Result<()> {
    let value = serde_json::json!({
        "version": HIDDEN_CODEX_SESSIONS_VERSION,
        "sessionIds": session_ids,
    });
    write_file_atomic(
        &root.join(HIDDEN_CODEX_SESSIONS_FILE),
        serde_json::to_string_pretty(&value)?.as_bytes(),
    )
}

fn update_hidden_codex_sessions_at_root(
    root: &Path,
    session_ids: impl IntoIterator<Item = String>,
    hidden: bool,
) -> Result<()> {
    let normalized = session_ids
        .into_iter()
        .map(|session_id| session_id.trim().to_string())
        .filter(|session_id| !session_id.is_empty())
        .collect::<BTreeSet<_>>();
    if normalized.is_empty() {
        return Ok(());
    }
    let _guard = hidden_codex_sessions_lock()
        .lock()
        .map_err(|_| anyhow!("Hidden Codex session storage lock poisoned"))?;
    let mut stored = read_hidden_codex_sessions_unlocked(root)?;
    if hidden {
        stored.extend(normalized);
    } else {
        stored.retain(|session_id| !normalized.contains(session_id));
    }
    write_hidden_codex_sessions_unlocked(root, &stored)
}

pub fn hidden_codex_session_ids() -> Result<BTreeSet<String>> {
    let root = ensure_base_dirs()?;
    let _guard = hidden_codex_sessions_lock()
        .lock()
        .map_err(|_| anyhow!("Hidden Codex session storage lock poisoned"))?;
    read_hidden_codex_sessions_unlocked(&root)
}

pub fn restore_codex_session_to_sidebar(codex_session_id: &str) -> Result<()> {
    let root = ensure_base_dirs()?;
    update_hidden_codex_sessions_at_root(&root, [codex_session_id.trim().to_string()], false)
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

#[derive(Default)]
struct CodexOnlyMigrationSummary {
    reset_thread_count: u64,
    reset_default_full_access: bool,
    quarantined_file_count: u64,
}

fn quarantine_invalid_storage_file_for_migration(path: &Path, migration_name: &str) -> Result<()> {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Err(anyhow!(
            "Cannot quarantine storage file without a valid name: {}",
            path.display()
        ));
    };
    let preferred_path = path.with_file_name(format!("{file_name}.{migration_name}.invalid"));
    let quarantine_path = if preferred_path.exists() {
        path.with_file_name(format!(
            "{file_name}.{migration_name}.invalid-{}",
            Uuid::new_v4()
        ))
    } else {
        preferred_path
    };

    if let Err(error) = fs::rename(path, &quarantine_path) {
        if error.kind() == std::io::ErrorKind::NotFound && !path.exists() {
            return Ok(());
        }
        return Err(error).with_context(|| {
            format!(
                "Unable to quarantine invalid storage file {}",
                path.display()
            )
        });
    }
    Ok(())
}

fn quarantine_invalid_storage_file(path: &Path) -> Result<()> {
    quarantine_invalid_storage_file_for_migration(path, "codex-only-v1")
}

fn quarantine_invalid_workspaces(
    root: &Path,
    summary: &mut CodexOnlyMigrationSummary,
) -> Result<()> {
    let workspaces_path = root.join("workspaces.json");
    if !workspaces_path.is_file() {
        return Ok(());
    }

    let raw = fs::read(&workspaces_path)
        .with_context(|| format!("Unable to read {}", workspaces_path.display()))?;
    if serde_json::from_slice::<Vec<Workspace>>(&raw).is_err() {
        quarantine_invalid_storage_file(&workspaces_path)?;
        summary.quarantined_file_count += 1;
    }

    Ok(())
}

fn reset_legacy_settings_full_access(
    root: &Path,
    summary: &mut CodexOnlyMigrationSummary,
) -> Result<()> {
    let settings_path = root.join("settings.json");
    if !settings_path.is_file() {
        return Ok(());
    }

    let raw = fs::read(&settings_path)
        .with_context(|| format!("Unable to read {}", settings_path.display()))?;
    let mut settings: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(settings) => settings,
        Err(_) => {
            quarantine_invalid_storage_file(&settings_path)?;
            summary.quarantined_file_count += 1;
            return Ok(());
        }
    };

    let should_reset = settings
        .get("defaultNewThreadFullAccess")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    if should_reset {
        settings["defaultNewThreadFullAccess"] = serde_json::Value::Bool(false);
    }

    if serde_json::from_value::<Settings>(settings.clone()).is_err() {
        quarantine_invalid_storage_file(&settings_path)?;
        summary.quarantined_file_count += 1;
        return Ok(());
    }

    if should_reset {
        let migrated = serde_json::to_string_pretty(&settings)?;
        write_file_atomic(&settings_path, migrated.as_bytes())
            .with_context(|| format!("Unable to migrate {}", settings_path.display()))?;
        summary.reset_default_full_access = true;
    }

    Ok(())
}

fn reset_legacy_thread_full_access(
    root: &Path,
    summary: &mut CodexOnlyMigrationSummary,
) -> Result<()> {
    let threads_root = root.join("threads");
    if !threads_root.is_dir() {
        return Ok(());
    }

    for workspace_entry in fs::read_dir(&threads_root)
        .with_context(|| format!("Unable to read {}", threads_root.display()))?
    {
        let workspace_entry = workspace_entry?;
        if !workspace_entry.file_type()?.is_dir() {
            continue;
        }
        let Some(workspace_id) = workspace_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };

        for thread_entry in fs::read_dir(workspace_entry.path())? {
            let thread_entry = thread_entry?;
            if !thread_entry.file_type()?.is_dir() {
                continue;
            }

            let metadata_path = thread_entry.path().join("thread.json");
            if !metadata_path.is_file() {
                continue;
            }
            let Some(thread_id) = thread_entry.file_name().to_str().map(str::to_string) else {
                quarantine_invalid_storage_file(&metadata_path)?;
                summary.quarantined_file_count += 1;
                continue;
            };

            let raw = fs::read(&metadata_path)
                .with_context(|| format!("Unable to read {}", metadata_path.display()))?;
            let mut metadata: serde_json::Value = match serde_json::from_slice(&raw) {
                Ok(metadata) => metadata,
                Err(_) => {
                    quarantine_invalid_storage_file(&metadata_path)?;
                    summary.quarantined_file_count += 1;
                    continue;
                }
            };
            let should_reset = metadata
                .get("fullAccess")
                .and_then(serde_json::Value::as_bool)
                == Some(true);
            if should_reset {
                metadata["fullAccess"] = serde_json::Value::Bool(false);
            }

            let metadata_is_valid = serde_json::from_value::<ThreadMetadata>(metadata.clone())
                .is_ok_and(|parsed| {
                    validate_thread_metadata_identity(&parsed, &workspace_id, &thread_id).is_ok()
                });
            if !metadata_is_valid {
                quarantine_invalid_storage_file(&metadata_path)?;
                summary.quarantined_file_count += 1;
                continue;
            }

            if !should_reset {
                continue;
            }

            let migrated = serde_json::to_string_pretty(&metadata)?;
            write_file_atomic(&metadata_path, migrated.as_bytes())
                .with_context(|| format!("Unable to migrate {}", metadata_path.display()))?;
            summary.reset_thread_count += 1;
        }
    }

    Ok(())
}

fn migration_marker_is_complete(marker_path: &Path) -> Result<bool> {
    if !marker_path.is_file() {
        return Ok(false);
    }

    let raw = fs::read(marker_path)
        .with_context(|| format!("Unable to read {}", marker_path.display()))?;
    let marker: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(marker) => marker,
        Err(_) => {
            quarantine_invalid_storage_file(marker_path)?;
            return Ok(false);
        }
    };
    let is_complete = marker.get("version").and_then(serde_json::Value::as_u64)
        == Some(u64::from(CODEX_ONLY_MIGRATION_VERSION))
        && marker
            .get("completedAt")
            .and_then(serde_json::Value::as_str)
            .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
            .is_some()
        && marker
            .get("resetThreadCount")
            .and_then(serde_json::Value::as_u64)
            .is_some()
        && marker
            .get("resetDefaultFullAccess")
            .and_then(serde_json::Value::as_bool)
            .is_some()
        && marker
            .get("quarantinedFileCount")
            .and_then(serde_json::Value::as_u64)
            .is_some();
    if is_complete {
        return Ok(true);
    }

    quarantine_invalid_storage_file(marker_path)?;
    Ok(false)
}

fn run_codex_only_migration(root: &Path) -> Result<()> {
    let marker_path = root.join(CODEX_ONLY_MIGRATION_MARKER);
    if migration_marker_is_complete(&marker_path)? {
        return Ok(());
    }

    let mut summary = CodexOnlyMigrationSummary::default();
    quarantine_invalid_workspaces(root, &mut summary)?;
    reset_legacy_settings_full_access(root, &mut summary)?;
    reset_legacy_thread_full_access(root, &mut summary)?;
    let marker = serde_json::json!({
        "version": CODEX_ONLY_MIGRATION_VERSION,
        "completedAt": Utc::now(),
        "resetThreadCount": summary.reset_thread_count,
        "resetDefaultFullAccess": summary.reset_default_full_access,
        "quarantinedFileCount": summary.quarantined_file_count,
    });
    let raw = serde_json::to_string_pretty(&marker)?;
    write_file_atomic(&marker_path, raw.as_bytes())
        .with_context(|| format!("Unable to record migration {}", marker_path.display()))
}

fn codex_only_migration_completed_at(root: &Path) -> Result<DateTime<Utc>> {
    let marker_path = root.join(CODEX_ONLY_MIGRATION_MARKER);
    let raw = fs::read(&marker_path)
        .with_context(|| format!("Unable to read {}", marker_path.display()))?;
    let marker: serde_json::Value = serde_json::from_slice(&raw)
        .with_context(|| format!("Invalid migration marker {}", marker_path.display()))?;
    let completed_at = marker
        .get("completedAt")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow!(
                "Migration marker {} is missing completedAt",
                marker_path.display()
            )
        })?;
    DateTime::parse_from_rfc3339(completed_at)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .with_context(|| {
            format!(
                "Migration marker {} has an invalid completedAt",
                marker_path.display()
            )
        })
}

fn codex_sidebar_migration_marker_is_complete(
    marker_path: &Path,
    codex_only_completed_at: DateTime<Utc>,
) -> Result<bool> {
    if !marker_path.is_file() {
        return Ok(false);
    }

    let raw = fs::read(marker_path)
        .with_context(|| format!("Unable to read {}", marker_path.display()))?;
    let marker: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(marker) => marker,
        Err(_) => {
            quarantine_invalid_storage_file_for_migration(marker_path, "codex-sidebar-v2")?;
            return Ok(false);
        }
    };
    let recorded_cutoff = marker
        .get("codexOnlyV1CompletedAt")
        .and_then(serde_json::Value::as_str)
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.with_timezone(&Utc));
    let is_complete = marker.get("version").and_then(serde_json::Value::as_u64)
        == Some(u64::from(CODEX_SIDEBAR_MIGRATION_VERSION))
        && marker
            .get("completedAt")
            .and_then(serde_json::Value::as_str)
            .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
            .is_some()
        && marker
            .get("removedThreadCount")
            .and_then(serde_json::Value::as_u64)
            .is_some()
        && marker
            .get("backupDirectory")
            .and_then(serde_json::Value::as_str)
            == Some(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
        && recorded_cutoff == Some(codex_only_completed_at);
    if is_complete {
        return Ok(true);
    }

    quarantine_invalid_storage_file_for_migration(marker_path, "codex-sidebar-v2")?;
    Ok(false)
}

fn unique_codex_sidebar_backup_path(
    root: &Path,
    workspace_id: &str,
    thread_id: &str,
) -> Result<PathBuf> {
    let backup_workspace_dir = root
        .join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
        .join(workspace_id);
    fs::create_dir_all(&backup_workspace_dir)?;

    let preferred_path = backup_workspace_dir.join(thread_id);
    if !preferred_path.exists() {
        return Ok(preferred_path);
    }

    loop {
        let candidate = backup_workspace_dir.join(format!("{thread_id}-{}", Uuid::new_v4()));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
}

fn count_codex_sidebar_backups(root: &Path) -> Result<u64> {
    let backup_root = root.join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR);
    if !backup_root.is_dir() {
        return Ok(0);
    }

    let mut backup_count = 0;
    for workspace_entry in fs::read_dir(&backup_root)
        .with_context(|| format!("Unable to read {}", backup_root.display()))?
    {
        let workspace_entry = workspace_entry?;
        if !workspace_entry.file_type()?.is_dir() {
            continue;
        }
        for thread_entry in fs::read_dir(workspace_entry.path())? {
            let thread_entry = thread_entry?;
            if thread_entry.file_type()?.is_dir()
                && thread_entry.path().join("thread.json").is_file()
            {
                backup_count += 1;
            }
        }
    }
    Ok(backup_count)
}

fn move_pre_codex_unbound_threads_to_backup(
    root: &Path,
    codex_only_completed_at: DateTime<Utc>,
) -> Result<u64> {
    let threads_root = root.join("threads");
    if !threads_root.is_dir() {
        return Ok(0);
    }

    for workspace_entry in fs::read_dir(&threads_root)
        .with_context(|| format!("Unable to read {}", threads_root.display()))?
    {
        let workspace_entry = workspace_entry?;
        if !workspace_entry.file_type()?.is_dir() {
            continue;
        }
        let Some(workspace_id) = workspace_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };

        for thread_entry in fs::read_dir(workspace_entry.path())? {
            let thread_entry = thread_entry?;
            if !thread_entry.file_type()?.is_dir() {
                continue;
            }
            let thread_dir = thread_entry.path();
            let Some(thread_id) = thread_entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let metadata_path = thread_dir.join("thread.json");
            if !metadata_path.is_file() {
                continue;
            }

            let raw = fs::read_to_string(&metadata_path)
                .with_context(|| format!("Unable to read {}", metadata_path.display()))?;
            let metadata = parse_thread_metadata_for_location(&raw, &workspace_id, &thread_id)
                .with_context(|| format!("Invalid thread metadata {}", metadata_path.display()))?;

            let has_codex_session = metadata
                .codex_session_id
                .as_deref()
                .is_some_and(|session_id| !session_id.trim().is_empty());
            if metadata.is_archived
                || has_codex_session
                || metadata.created_at >= codex_only_completed_at
            {
                continue;
            }

            let backup_path = unique_codex_sidebar_backup_path(root, &workspace_id, &thread_id)?;
            let backup_parent = backup_path
                .parent()
                .ok_or_else(|| anyhow!("Backup path has no parent: {}", backup_path.display()))?
                .to_path_buf();
            fs::rename(&thread_dir, &backup_path).with_context(|| {
                format!(
                    "Unable to move legacy thread {} to {}",
                    thread_dir.display(),
                    backup_path.display()
                )
            })?;
            File::open(workspace_entry.path())?.sync_all()?;
            File::open(backup_parent)?.sync_all()?;
        }
    }

    count_codex_sidebar_backups(root)
}

fn run_codex_sidebar_migration(root: &Path) -> Result<()> {
    let codex_only_completed_at = codex_only_migration_completed_at(root)?;
    let marker_path = root.join(CODEX_SIDEBAR_MIGRATION_MARKER);
    if codex_sidebar_migration_marker_is_complete(&marker_path, codex_only_completed_at)? {
        return Ok(());
    }

    let removed_thread_count =
        move_pre_codex_unbound_threads_to_backup(root, codex_only_completed_at)?;
    let marker = serde_json::json!({
        "version": CODEX_SIDEBAR_MIGRATION_VERSION,
        "completedAt": Utc::now(),
        "codexOnlyV1CompletedAt": codex_only_completed_at,
        "removedThreadCount": removed_thread_count,
        "backupDirectory": CODEX_SIDEBAR_MIGRATION_BACKUP_DIR,
    });
    let raw = serde_json::to_string_pretty(&marker)?;
    write_file_atomic(&marker_path, raw.as_bytes())
        .with_context(|| format!("Unable to record migration {}", marker_path.display()))
}

pub fn ensure_base_dirs() -> Result<PathBuf> {
    let _guard = base_dirs_lock()
        .lock()
        .map_err(|_| anyhow!("Application storage lock poisoned"))?;
    let root = app_support_root()?;
    fs::create_dir_all(&root)?;
    run_codex_only_migration(&root)?;
    run_codex_sidebar_migration(&root)?;
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
    let raw =
        fs::read_to_string(&file).with_context(|| format!("Unable to read {}", file.display()))?;
    let settings: Settings = serde_json::from_str(&raw)
        .with_context(|| format!("Invalid settings JSON in {}", file.display()))?;
    Ok(settings.normalized())
}

pub fn save_settings(settings: &Settings) -> Result<()> {
    let file = settings_file()?;
    let raw = serde_json::to_string_pretty(&settings.clone().normalized())?;
    write_file_atomic(&file, raw.as_bytes())?;
    Ok(())
}

pub fn load_workspaces() -> Result<Vec<Workspace>> {
    let file = workspaces_file()?;
    let raw =
        fs::read_to_string(&file).with_context(|| format!("Unable to read {}", file.display()))?;
    let list: Vec<Workspace> = serde_json::from_str(&raw)
        .with_context(|| format!("Invalid workspace JSON in {}", file.display()))?;
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
    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;

    let mut workspaces = load_workspaces()?;
    if let Some(existing) = workspaces
        .iter()
        .find(|workspace| workspace.path == canonical)
    {
        fs::create_dir_all(thread_workspace_dir(&existing.id)?)?;
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
        rdev_ssh_command: None,
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

pub fn add_rdev_workspace(rdev_ssh_command: &str, display_name: Option<&str>) -> Result<Workspace> {
    let parsed_command = parse_rdev_ssh_command(rdev_ssh_command, false)?;
    let normalized_command = join_remote_command_tokens(&parsed_command.tokens);
    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;

    let mut workspaces = load_workspaces()?;
    if let Some(existing) = workspaces.iter().find(|workspace| {
        workspace.kind == WorkspaceKind::Rdev
            && workspace
                .rdev_ssh_command
                .as_deref()
                .and_then(|command| canonicalize_rdev_ssh_command(command, false).ok())
                .as_deref()
                == Some(normalized_command.as_str())
    }) {
        fs::create_dir_all(thread_workspace_dir(&existing.id)?)?;
        return Ok(existing.clone());
    }

    let now = Utc::now();
    let trimmed_display_name = display_name.unwrap_or_default().trim().to_string();
    let fallback_name = parsed_command
        .destination
        .as_deref()
        .unwrap_or("rdev")
        .split('/')
        .next_back()
        .unwrap_or("rdev")
        .to_string();
    let workspace_name = if trimmed_display_name.is_empty() {
        fallback_name
    } else {
        trimmed_display_name
    };

    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name: workspace_name,
        path: format!("rdev-workspace-{}", Uuid::new_v4()),
        kind: WorkspaceKind::Rdev,
        rdev_ssh_command: Some(normalized_command),
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
    let parsed_command = parse_ssh_command(ssh_command)?;
    let normalized_command = join_remote_command_tokens(&parsed_command.tokens);
    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;

    let mut workspaces = load_workspaces()?;
    if let Some(existing) = workspaces.iter().find(|workspace| {
        workspace.kind == WorkspaceKind::Ssh
            && workspace
                .ssh_command
                .as_deref()
                .and_then(|command| canonicalize_ssh_command(command).ok())
                .as_deref()
                == Some(normalized_command.as_str())
    }) {
        fs::create_dir_all(thread_workspace_dir(&existing.id)?)?;
        return Ok(existing.clone());
    }

    let now = Utc::now();
    let trimmed_display_name = display_name.unwrap_or_default().trim().to_string();
    let fallback_name = parsed_command
        .destination
        .as_deref()
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
        .map(validate_remote_path)
        .transpose()?;

    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name: workspace_name,
        path: format!("ssh-workspace-{}", Uuid::new_v4()),
        kind: WorkspaceKind::Ssh,
        rdev_ssh_command: None,
        ssh_command: Some(normalized_command),
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
    let root = ensure_base_dirs()?;
    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
    let mut workspaces = load_workspaces()?;
    let original_len = workspaces.len();
    workspaces.retain(|workspace| workspace.id != workspace_id);
    if workspaces.len() == original_len {
        if !workspace_deletion_marker_path(workspace_id)?.is_file() {
            return Ok(false);
        }
        let _metadata_guard = thread_metadata_lock()
            .lock()
            .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
        remove_workspace_storage_dirs(workspace_id)?;
        return Ok(false);
    }

    let _metadata_guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    let bound_session_ids = codex_session_ids_for_workspace_unlocked(workspace_id)?;
    update_hidden_codex_sessions_at_root(&root, bound_session_ids, true)?;
    mark_workspace_storage_deleted_unlocked(workspace_id)?;
    save_workspaces(&workspaces)?;
    remove_workspace_storage_dirs(workspace_id)?;

    Ok(true)
}

fn remove_workspace_storage_dirs(workspace_id: &str) -> Result<()> {
    let workspace_threads_dir = thread_workspace_dir(workspace_id)?;
    if workspace_threads_dir.exists() {
        fs::remove_dir_all(workspace_threads_dir)?;
    }
    let workspace_shells_dir = workspace_shell_sessions_dir(workspace_id)?;
    if workspace_shells_dir.exists() {
        fs::remove_dir_all(workspace_shells_dir)?;
    }

    Ok(())
}

pub fn set_workspace_git_pull_on_master_for_new_threads(
    workspace_id: &str,
    enabled: bool,
) -> Result<Workspace> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let _registry_guard = workspace_registry_lock()
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

#[allow(dead_code)]
pub fn set_workspace_remote_path(
    workspace_id: &str,
    remote_path: Option<&str>,
) -> Result<Workspace> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
    let mut workspaces = load_workspaces()?;
    let workspace = workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| anyhow!("Workspace not found"))?;

    workspace.remote_path = remote_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_remote_path)
        .transpose()?;
    workspace.updated_at = Utc::now();
    let updated = workspace.clone();
    save_workspaces(&workspaces)?;
    Ok(updated)
}

pub fn set_workspace_order(workspace_ids: Vec<String>) -> Result<Vec<Workspace>> {
    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
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

fn latest_thread_run_pointer_path(workspace_id: &str, thread_id: &str) -> Result<PathBuf> {
    Ok(thread_dir(workspace_id, thread_id)?.join("latest-run.txt"))
}

pub fn set_latest_thread_run_id(workspace_id: &str, thread_id: &str, run_id: &str) -> Result<()> {
    let run_id = validate_storage_segment(run_id, "run id")?;
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    ensure_thread_storage_live_unlocked(workspace_id, thread_id)?;
    let path = latest_thread_run_pointer_path(workspace_id, thread_id)?;
    write_file_atomic(&path, run_id.as_bytes())
}

pub fn latest_thread_run_dir(workspace_id: &str, thread_id: &str) -> Result<Option<PathBuf>> {
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    ensure_thread_storage_live_unlocked(workspace_id, thread_id)?;
    let path = latest_thread_run_pointer_path(workspace_id, thread_id)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)?;
    let Ok(run_id) = validate_storage_segment(&raw, "run id") else {
        return Ok(None);
    };

    let run_dir = runs_dir(workspace_id, thread_id)?.join(run_id);
    if run_dir.is_dir() {
        Ok(Some(run_dir))
    } else {
        Ok(None)
    }
}

pub fn workspace_shell_sessions_dir(workspace_id: &str) -> Result<PathBuf> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    Ok(ensure_base_dirs()?
        .join("workspace-shells")
        .join(workspace_id))
}

pub fn create_thread(workspace_id: &str, full_access: bool) -> Result<ThreadMetadata> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
    if !load_workspaces()?
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Err(anyhow!("Workspace not found"));
    }
    let now = Utc::now();
    let thread = ThreadMetadata {
        id: Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        full_access,
        enabled_skills: Vec::new(),
        created_at: now,
        updated_at: now,
        title: "New thread".to_string(),
        is_archived: false,
        last_run_status: ThreadRunStatus::Idle,
        last_run_started_at: None,
        last_run_ended_at: None,
        codex_session_id: None,
        forked_from_codex_session_id: None,
        pending_fork_source_codex_session_id: None,
        pending_fork_known_child_session_ids: Vec::new(),
        pending_fork_requested_at: None,
        pending_fork_launch_consumed: false,
        last_resume_at: None,
        last_new_session_at: None,
    };

    initialize_thread_storage(&thread)?;
    Ok(thread)
}

pub fn create_imported_codex_thread(
    workspace_id: &str,
    codex_session_id: &str,
    title: Option<&str>,
    full_access: bool,
) -> Result<ThreadMetadata> {
    let workspace_id = validate_storage_segment(workspace_id, "workspace id")?;
    let codex_session_id = normalize_uuid_session_id(codex_session_id)
        .ok_or_else(|| anyhow!("Codex session ID must be a valid UUID"))?;
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(80).collect::<String>())
        .unwrap_or_else(|| "New thread".to_string());

    let _registry_guard = workspace_registry_lock()
        .lock()
        .map_err(|_| anyhow!("Workspace registry lock poisoned"))?;
    if !load_workspaces()?
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Err(anyhow!("Workspace not found"));
    }
    let _metadata_guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    ensure_workspace_storage_live_unlocked(workspace_id)?;

    let workspace_dir = thread_workspace_dir(workspace_id)?;
    fs::create_dir_all(&workspace_dir)?;
    let thread_id = loop {
        let candidate = Uuid::new_v4().to_string();
        if !workspace_dir.join(&candidate).exists() {
            break candidate;
        }
    };
    if codex_session_id_claimed_by_other_thread_unlocked(
        workspace_id,
        &thread_id,
        &codex_session_id,
    )? {
        return Err(anyhow!(
            "That Codex session is already imported into another active thread"
        ));
    }

    let now = Utc::now();
    let thread = ThreadMetadata {
        id: thread_id.clone(),
        workspace_id: workspace_id.to_string(),
        full_access,
        enabled_skills: Vec::new(),
        created_at: now,
        updated_at: now,
        title,
        is_archived: false,
        last_run_status: ThreadRunStatus::Idle,
        last_run_started_at: None,
        last_run_ended_at: None,
        codex_session_id: Some(codex_session_id),
        forked_from_codex_session_id: None,
        pending_fork_source_codex_session_id: None,
        pending_fork_known_child_session_ids: Vec::new(),
        pending_fork_requested_at: None,
        pending_fork_launch_consumed: false,
        last_resume_at: None,
        last_new_session_at: None,
    };

    let staging_dir = workspace_dir.join(format!(".{thread_id}.import-staging-{}", Uuid::new_v4()));
    let final_dir = workspace_dir.join(&thread_id);
    let write_result = (|| -> Result<()> {
        fs::create_dir(&staging_dir)?;
        fs::create_dir(staging_dir.join("runs"))?;
        let raw = serde_json::to_string_pretty(&thread)?;
        write_file_atomic(&staging_dir.join("thread.json"), raw.as_bytes())?;
        File::open(&staging_dir)?.sync_all()?;
        fs::rename(&staging_dir, &final_dir)?;
        File::open(&workspace_dir)?.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }
    Ok(thread)
}

fn initialize_thread_storage(thread: &ThreadMetadata) -> Result<()> {
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    write_thread_metadata_unlocked(thread)?;
    let dir = thread_dir(&thread.workspace_id, &thread.id)?;
    fs::create_dir_all(dir.join("runs"))?;

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
    ensure_thread_storage_live_unlocked(&thread.workspace_id, &thread.id)?;
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
    ensure_thread_storage_live_unlocked(workspace_id, thread_id)?;
    let raw = fs::read_to_string(thread_metadata_path(workspace_id, thread_id)?)?;
    parse_thread_metadata_for_location(&raw, workspace_id, thread_id)
}

fn codex_session_id_claimed_by_other_thread_unlocked(
    workspace_id: &str,
    thread_id: &str,
    codex_session_id: &str,
) -> Result<bool> {
    let normalized = codex_session_id.trim();
    if normalized.is_empty() {
        return Ok(false);
    }

    let threads_root = ensure_base_dirs()?.join("threads");
    if !threads_root.exists() {
        return Ok(false);
    }

    for workspace_entry in fs::read_dir(threads_root)? {
        let workspace_entry = workspace_entry?;
        if !workspace_entry.file_type()?.is_dir() {
            continue;
        }
        let Some(candidate_workspace_id) = workspace_entry.file_name().to_str().map(str::to_string)
        else {
            continue;
        };
        for thread_entry in fs::read_dir(workspace_entry.path())? {
            let thread_entry = thread_entry?;
            if !thread_entry.file_type()?.is_dir() {
                continue;
            }
            let Some(candidate_thread_id) = thread_entry.file_name().to_str().map(str::to_string)
            else {
                continue;
            };
            if candidate_workspace_id == workspace_id && candidate_thread_id == thread_id {
                continue;
            }
            let metadata_path = thread_entry.path().join("thread.json");
            if !metadata_path.is_file() {
                continue;
            }
            let raw = fs::read_to_string(metadata_path)?;
            let metadata = parse_thread_metadata_for_location(
                &raw,
                &candidate_workspace_id,
                &candidate_thread_id,
            )?;
            if metadata.is_archived {
                continue;
            }
            if metadata
                .codex_session_id
                .as_deref()
                .is_some_and(|existing| existing == normalized)
            {
                return Ok(true);
            }
        }
    }

    Ok(false)
}

fn codex_session_ids_for_workspace_unlocked(workspace_id: &str) -> Result<BTreeSet<String>> {
    let mut session_ids = BTreeSet::new();
    let workspace_dir = thread_workspace_dir(workspace_id)?;
    if !workspace_dir.is_dir() {
        return Ok(session_ids);
    }
    for entry in fs::read_dir(workspace_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(thread_id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let metadata_path = entry.path().join("thread.json");
        if !metadata_path.is_file() {
            continue;
        }
        let raw = fs::read_to_string(metadata_path)?;
        let metadata = parse_thread_metadata_for_location(&raw, workspace_id, &thread_id)?;
        if let Some(session_id) = metadata
            .codex_session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
        {
            session_ids.insert(session_id.to_string());
        }
    }
    Ok(session_ids)
}

pub fn known_codex_session_ids() -> Result<BTreeSet<String>> {
    let root = ensure_base_dirs()?;
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    let threads_root = root.join("threads");
    if !threads_root.is_dir() {
        return Ok(BTreeSet::new());
    }
    let mut session_ids = BTreeSet::new();
    for entry in fs::read_dir(threads_root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(workspace_id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        session_ids.extend(codex_session_ids_for_workspace_unlocked(&workspace_id)?);
    }
    Ok(session_ids)
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
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    read_thread_metadata_unlocked(workspace_id, thread_id)
}

pub fn list_threads(workspace_id: &str) -> Result<Vec<ThreadMetadata>> {
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    ensure_workspace_storage_live_unlocked(workspace_id)?;
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
        let candidate_thread_id = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("Thread storage directory has an invalid name"))?;
        let raw = fs::read_to_string(metadata_path)?;
        let mut metadata =
            parse_thread_metadata_for_location(&raw, workspace_id, candidate_thread_id)?;
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

    threads.sort_by_key(|thread| std::cmp::Reverse(thread.updated_at));
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
        let Some(thread_id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        // Read the raw file to check status before taking the lock.
        let raw = match fs::read_to_string(&metadata_path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let metadata = match parse_thread_metadata_for_location(&raw, workspace_id, &thread_id) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if matches!(metadata.last_run_status, ThreadRunStatus::Running) {
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

pub fn clear_thread_codex_session(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.codex_session_id = None;
        thread.pending_fork_source_codex_session_id = None;
        thread.pending_fork_known_child_session_ids.clear();
        thread.pending_fork_requested_at = None;
        thread.pending_fork_launch_consumed = false;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn set_thread_codex_session_id(
    workspace_id: &str,
    thread_id: &str,
    codex_session_id: &str,
) -> Result<ThreadMetadata> {
    let normalized = normalize_optional_session_id(codex_session_id);
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        if let Some(session_id) = normalized.as_deref() {
            if codex_session_id_claimed_by_other_thread_unlocked(
                workspace_id,
                thread_id,
                session_id,
            )? {
                return Err(anyhow!(
                    "Codex session id is already claimed by another thread"
                ));
            }
        }
        thread.codex_session_id = normalized.clone();
        if normalized.is_some() {
            if let Some(source_session_id) = thread.pending_fork_source_codex_session_id.clone() {
                thread.forked_from_codex_session_id = Some(source_session_id);
                thread.pending_fork_source_codex_session_id = None;
                thread.pending_fork_known_child_session_ids.clear();
                thread.pending_fork_requested_at = None;
                thread.pending_fork_launch_consumed = false;
            }
        }
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn set_thread_codex_session_id_if_missing(
    workspace_id: &str,
    thread_id: &str,
    codex_session_id: &str,
) -> Result<Option<ThreadMetadata>> {
    let Some(normalized) = normalize_optional_session_id(codex_session_id) else {
        return Ok(None);
    };

    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread metadata lock poisoned"))?;
    let mut thread = read_thread_metadata_unlocked(workspace_id, thread_id)?;
    if thread.codex_session_id.is_some() {
        return Ok(None);
    }
    if codex_session_id_claimed_by_other_thread_unlocked(workspace_id, thread_id, &normalized)? {
        return Err(anyhow!(
            "Codex session id is already claimed by another thread"
        ));
    }

    thread.codex_session_id = Some(normalized.to_string());
    thread.updated_at = Utc::now();
    write_thread_metadata_unlocked(&thread)?;
    Ok(Some(thread))
}

pub fn set_thread_pending_fork(
    workspace_id: &str,
    thread_id: &str,
    source_codex_session_id: &str,
    known_child_session_ids: Vec<String>,
    requested_at: DateTime<Utc>,
) -> Result<ThreadMetadata> {
    let source_codex_session_id = normalize_uuid_session_id(source_codex_session_id)
        .ok_or_else(|| anyhow!("Source Codex session id must be a UUID"))?;
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.pending_fork_source_codex_session_id = Some(source_codex_session_id.clone());
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
    let source_codex_session_id = normalize_uuid_session_id(&prepared.source_codex_session_id)
        .ok_or_else(|| anyhow!("Source Codex session id must be a UUID"))?;
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.pending_fork_source_codex_session_id = Some(source_codex_session_id.clone());
        thread.pending_fork_known_child_session_ids = prepared.known_child_session_ids.clone();
        thread.pending_fork_requested_at = Some(prepared.requested_at);
        thread.pending_fork_launch_consumed = true;
        thread.updated_at = Utc::now();
        Ok(())
    })
}

pub fn clear_thread_pending_fork(workspace_id: &str, thread_id: &str) -> Result<ThreadMetadata> {
    mutate_thread_metadata(workspace_id, thread_id, |thread| {
        thread.pending_fork_source_codex_session_id = None;
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
        if thread.pending_fork_source_codex_session_id.is_some() {
            thread.pending_fork_launch_consumed = true;
            thread.updated_at = Utc::now();
        }
        Ok(())
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

fn delete_thread_unlocked(workspace_id: &str, thread_id: &str) -> Result<()> {
    let path = thread_dir(workspace_id, thread_id)?;
    mark_thread_storage_deleted_unlocked(workspace_id, thread_id)?;
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

#[cfg(test)]
pub fn delete_thread(workspace_id: &str, thread_id: &str) -> Result<()> {
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    delete_thread_unlocked(workspace_id, thread_id)
}

pub fn delete_thread_from_sidebar(workspace_id: &str, thread_id: &str) -> Result<()> {
    let root = ensure_base_dirs()?;
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    let metadata = read_thread_metadata_unlocked(workspace_id, thread_id)?;
    if let Some(session_id) = metadata
        .codex_session_id
        .as_deref()
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
    {
        update_hidden_codex_sessions_at_root(&root, [session_id.to_string()], true)?;
    }
    delete_thread_unlocked(workspace_id, thread_id)
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

pub fn write_thread_run_json_file<T: serde::Serialize>(
    workspace_id: &str,
    thread_id: &str,
    run_id: &str,
    file_name: &str,
    value: &T,
) -> Result<()> {
    let run_id = validate_storage_segment(run_id, "run id")?;
    let file_name = validate_storage_segment(file_name, "run file name")?;
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    ensure_thread_storage_live_unlocked(workspace_id, thread_id)?;
    let path = runs_dir(workspace_id, thread_id)?
        .join(run_id)
        .join(file_name);
    let raw = serde_json::to_string_pretty(value)?;
    write_file_atomic(&path, raw.as_bytes())
}

pub fn write_thread_run_file(
    workspace_id: &str,
    thread_id: &str,
    run_id: &str,
    file_name: &str,
    raw: &[u8],
) -> Result<()> {
    let run_id = validate_storage_segment(run_id, "run id")?;
    let file_name = validate_storage_segment(file_name, "run file name")?;
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    ensure_thread_storage_live_unlocked(workspace_id, thread_id)?;
    let path = runs_dir(workspace_id, thread_id)?
        .join(run_id)
        .join(file_name);
    write_file_atomic(&path, raw)
}

pub fn write_workspace_shell_run_json_file<T: serde::Serialize>(
    workspace_id: &str,
    run_id: &str,
    file_name: &str,
    value: &T,
) -> Result<()> {
    let run_id = validate_storage_segment(run_id, "run id")?;
    let file_name = validate_storage_segment(file_name, "run file name")?;
    let _guard = thread_metadata_lock()
        .lock()
        .map_err(|_| anyhow!("Thread storage lock poisoned"))?;
    ensure_workspace_storage_live_unlocked(workspace_id)?;
    let path = workspace_shell_sessions_dir(workspace_id)?
        .join(run_id)
        .join(file_name);
    let raw = serde_json::to_string_pretty(value)?;
    write_file_atomic(&path, raw.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_commands_accept_supported_arguments_and_reconstruct_canonically() {
        let ssh = canonicalize_ssh_command(
            r#"ssh -vv -p 2222 -i "~/.ssh/dev key" -J jump@example.com -o ServerAliveInterval=30 dev@remote-host {CODEX_CMD}"#,
        )
        .expect("supported SSH arguments should be accepted");
        assert!(
            ssh.starts_with("'ssh' '-vv' '-p' '2222'"),
            "every user-supplied argument should be quoted before login-shell execution"
        );
        assert_eq!(
            shell_words::split(&ssh).expect("canonical SSH command should parse"),
            vec![
                "ssh",
                "-vv",
                "-p",
                "2222",
                "-i",
                "~/.ssh/dev key",
                "-J",
                "jump@example.com",
                "-o",
                "ServerAliveInterval=30",
                "dev@remote-host",
                CODEX_COMMAND_PLACEHOLDER,
            ]
        );

        let rdev = canonicalize_rdev_ssh_command(
            "rdev ssh -p 8022 --ssh-log-level DEBUG team/example-env {CODEX_CMD}",
            true,
        )
        .expect("supported rdev ssh arguments should be accepted");
        assert_eq!(
            shell_words::split(&rdev).expect("canonical rdev command should parse"),
            vec![
                "rdev",
                "ssh",
                "-p",
                "8022",
                "--ssh-log-level",
                "DEBUG",
                "team/example-env",
                "--non-tmux",
                CODEX_COMMAND_PLACEHOLDER,
            ]
        );
    }

    #[test]
    fn remote_commands_reject_local_shell_injection_payloads() {
        let ssh_payloads = [
            "ssh dev@host & local-command",
            "ssh dev@host; local-command",
            "ssh dev@host || local-command",
            "ssh dev@host $(local-command)",
            "ssh dev@host `local-command`",
            "ssh dev@host > /tmp/output",
            "ssh dev@host < /tmp/input",
            "ssh dev@host\nlocal-command",
            "ssh dev@host {CODEX_CMD}; local-command",
            "ssh dev@host custom-remote-command",
            "ssh -o ProxyCommand=local-command dev@host",
            "ssh -o LocalCommand=local-command dev@host",
            "ssh -o KnownHostsCommand=local-command dev@host",
            "ssh -o RemoteCommand=custom-remote-command dev@host",
            "ssh -o ForkAfterAuthentication=yes dev@host",
            "ssh -o SessionType=none dev@host",
            "ssh -o StdinNull=yes dev@host",
            "ssh -F /tmp/command-supplied-config dev@host",
            "ssh -I /tmp/command-supplied-library dev@host",
            "ssh -N dev@host",
            "ssh -n dev@host",
            "ssh -T dev@host",
            "ssh -W internal@host:22 dev@host",
        ];
        for payload in ssh_payloads {
            assert!(
                canonicalize_ssh_command(payload).is_err(),
                "unsafe SSH payload should be rejected: {payload}"
            );
        }

        let rdev_payloads = [
            "rdev ssh team/env & local-command",
            "rdev ssh team/env; local-command",
            "rdev ssh team/env $(local-command)",
            "rdev ssh team/env > /tmp/output",
            "rdev ssh team/env\nlocal-command",
            "rdev ssh team/env {CODEX_CMD} local-command",
            "rdev ssh team/env custom-remote-command",
        ];
        for payload in rdev_payloads {
            assert!(
                canonicalize_rdev_ssh_command(payload, true).is_err(),
                "unsafe rdev payload should be rejected: {payload}"
            );
        }
    }

    #[test]
    fn remote_command_placeholders_must_be_a_single_final_argument() {
        for payload in [
            "ssh dev@host prefix-{CODEX_CMD}",
            "ssh dev@host {CODEX_CMD} {CODEX_CMD}",
            "ssh {CODEX_CMD}",
            "ssh -o {CODEX_CMD} dev@host",
        ] {
            assert!(
                canonicalize_ssh_command(payload).is_err(),
                "invalid placeholder should be rejected: {payload}"
            );
        }

        assert!(
            canonicalize_rdev_ssh_command("rdev ssh team/env prefix-{CODEX_CMD}", true).is_err()
        );
    }

    #[test]
    fn remote_paths_reject_terminal_control_characters() {
        assert_eq!(
            validate_remote_path("  ~/projects/example;literal  ")
                .expect("shell punctuation in a path is safely quoted later"),
            "~/projects/example;literal"
        );
        assert!(validate_remote_path("~/projects/example\nlocal-command").is_err());
        assert!(validate_remote_path("~/projects/\u{1b}[31m").is_err());
    }

    fn legacy_thread_fixture(full_access: bool) -> serde_json::Value {
        serde_json::json!({
            "id": "thread-1",
            "workspaceId": "workspace-1",
            "fullAccess": full_access,
            "enabledSkills": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "title": "Existing thread",
            "customLegacyField": "preserved"
        })
    }

    fn dated_thread_fixture(thread_id: &str, created_at: &str) -> serde_json::Value {
        let mut fixture = legacy_thread_fixture(false);
        fixture["id"] = serde_json::Value::String(thread_id.to_string());
        fixture["createdAt"] = serde_json::Value::String(created_at.to_string());
        fixture["updatedAt"] = serde_json::Value::String(created_at.to_string());
        fixture
    }

    fn write_thread_fixture(root: &Path, thread_id: &str, fixture: &serde_json::Value) -> PathBuf {
        let thread_path = root
            .join("threads/workspace-1")
            .join(thread_id)
            .join("thread.json");
        fs::create_dir_all(
            thread_path
                .parent()
                .expect("thread path should have a parent"),
        )
        .expect("failed to create thread fixture directory");
        fs::write(
            &thread_path,
            serde_json::to_vec_pretty(fixture).expect("failed to serialize thread fixture"),
        )
        .expect("failed to write thread fixture");
        thread_path
    }

    fn write_codex_only_marker_fixture(root: &Path, completed_at: &str) {
        let marker_path = root.join(CODEX_ONLY_MIGRATION_MARKER);
        fs::create_dir_all(
            marker_path
                .parent()
                .expect("marker path should have a parent"),
        )
        .expect("failed to create migration fixture directory");
        let marker = serde_json::json!({
            "version": CODEX_ONLY_MIGRATION_VERSION,
            "completedAt": completed_at,
            "resetThreadCount": 0,
            "resetDefaultFullAccess": false,
            "quarantinedFileCount": 0,
        });
        fs::write(
            marker_path,
            serde_json::to_vec_pretty(&marker).expect("failed to serialize migration fixture"),
        )
        .expect("failed to write migration fixture");
    }

    #[test]
    fn codex_sidebar_migration_moves_legacy_threads_and_preserves_all_contents() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-sidebar-legacy-migration-test-{}",
            Uuid::new_v4()
        ));
        write_codex_only_marker_fixture(&temp_root, "2026-02-01T00:00:00Z");

        let mut legacy_thread = dated_thread_fixture("legacy-thread", "2026-01-01T00:00:00Z");
        legacy_thread["retiredRuntime"] = serde_json::Value::String("legacy-cli".to_string());
        legacy_thread["retiredSessionId"] = serde_json::Value::String("legacy-session".to_string());
        legacy_thread["customLegacyField"] = serde_json::json!({
            "nested": ["value", 7],
            "enabled": true,
        });
        let legacy_thread_path = write_thread_fixture(&temp_root, "legacy-thread", &legacy_thread);
        let legacy_thread_raw =
            fs::read(&legacy_thread_path).expect("legacy fixture should be readable");
        let legacy_run_path = legacy_thread_path
            .parent()
            .expect("thread path should have a parent")
            .join("runs/run-1/output.log");
        fs::create_dir_all(
            legacy_run_path
                .parent()
                .expect("run path should have a parent"),
        )
        .expect("failed to create legacy run fixture");
        fs::write(&legacy_run_path, b"complete legacy run output")
            .expect("failed to write legacy run fixture");

        // This current-shape file is written after the v1 marker but retains its
        // original creation time, as happens when a legacy record is rewritten.
        let rewritten_thread = serde_json::to_value(
            serde_json::from_value::<ThreadMetadata>(dated_thread_fixture(
                "rewritten-thread",
                "2026-01-15T00:00:00Z",
            ))
            .expect("rewritten fixture should deserialize"),
        )
        .expect("rewritten fixture should serialize");
        assert_eq!(rewritten_thread["codexSessionId"], serde_json::Value::Null);
        let rewritten_thread_path =
            write_thread_fixture(&temp_root, "rewritten-thread", &rewritten_thread);
        let rewritten_thread_raw =
            fs::read(&rewritten_thread_path).expect("rewritten fixture should be readable");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        ensure_base_dirs().expect("sidebar migration should succeed");

        assert!(
            list_threads("workspace-1")
                .expect("live threads should remain listable")
                .is_empty(),
            "moved legacy threads must not appear in the sidebar"
        );
        assert!(
            !legacy_thread_path
                .parent()
                .expect("thread path should have a parent")
                .exists(),
            "legacy directory must leave live thread storage"
        );
        assert!(
            !rewritten_thread_path
                .parent()
                .expect("thread path should have a parent")
                .exists(),
            "rewritten legacy directory must leave live thread storage"
        );
        let legacy_backup_dir = temp_root
            .join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
            .join("workspace-1/legacy-thread");
        let rewritten_backup_dir = temp_root
            .join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
            .join("workspace-1/rewritten-thread");
        assert_eq!(
            fs::read(legacy_backup_dir.join("thread.json"))
                .expect("legacy metadata should be backed up"),
            legacy_thread_raw
        );
        assert_eq!(
            fs::read(legacy_backup_dir.join("runs/run-1/output.log"))
                .expect("legacy run output should be backed up"),
            b"complete legacy run output"
        );
        assert_eq!(
            fs::read(rewritten_backup_dir.join("thread.json"))
                .expect("rewritten metadata should be backed up"),
            rewritten_thread_raw
        );

        let backed_up_legacy: serde_json::Value = serde_json::from_slice(
            &fs::read(legacy_backup_dir.join("thread.json"))
                .expect("legacy metadata backup should remain stored"),
        )
        .expect("legacy metadata should remain valid JSON");
        assert_eq!(backed_up_legacy["retiredRuntime"], "legacy-cli");
        assert_eq!(backed_up_legacy["retiredSessionId"], "legacy-session");
        assert_eq!(
            backed_up_legacy["customLegacyField"],
            legacy_thread["customLegacyField"]
        );

        let marker: serde_json::Value = serde_json::from_slice(
            &fs::read(temp_root.join(CODEX_SIDEBAR_MIGRATION_MARKER))
                .expect("sidebar migration marker should exist"),
        )
        .expect("sidebar migration marker should be valid JSON");
        assert_eq!(marker["version"], CODEX_SIDEBAR_MIGRATION_VERSION);
        assert_eq!(marker["codexOnlyV1CompletedAt"], "2026-02-01T00:00:00Z");
        assert_eq!(marker["removedThreadCount"], 2);
        assert_eq!(
            marker["backupDirectory"],
            CODEX_SIDEBAR_MIGRATION_BACKUP_DIR
        );
        assert!(marker["completedAt"].is_string());

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_sidebar_migration_preserves_new_unbound_and_existing_bound_threads() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-sidebar-current-thread-test-{}",
            Uuid::new_v4()
        ));
        write_codex_only_marker_fixture(&temp_root, "2026-02-01T00:00:00Z");

        let mut new_unbound_thread =
            dated_thread_fixture("new-unbound-thread", "2026-02-02T00:00:00Z");
        new_unbound_thread["codexSessionId"] = serde_json::Value::Null;
        let new_unbound_path =
            write_thread_fixture(&temp_root, "new-unbound-thread", &new_unbound_thread);

        let mut bound_thread = dated_thread_fixture("bound-thread", "2026-01-01T00:00:00Z");
        bound_thread["codexSessionId"] =
            serde_json::Value::String("019c1551-4a4f-7713-bdf9-d70ee357f287".to_string());
        let bound_path = write_thread_fixture(&temp_root, "bound-thread", &bound_thread);
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        ensure_base_dirs().expect("sidebar migration should succeed");

        let live_thread_ids: Vec<String> = list_threads("workspace-1")
            .expect("live threads should remain listable")
            .into_iter()
            .map(|thread| thread.id)
            .collect();
        assert_eq!(live_thread_ids.len(), 2);
        assert!(live_thread_ids.contains(&"new-unbound-thread".to_string()));
        assert!(live_thread_ids.contains(&"bound-thread".to_string()));
        let migrated_new: serde_json::Value = serde_json::from_slice(
            &fs::read(&new_unbound_path).expect("new unbound thread should remain live"),
        )
        .expect("new unbound thread should remain valid JSON");
        assert_ne!(migrated_new["isArchived"], true);

        let migrated_bound: serde_json::Value = serde_json::from_slice(
            &fs::read(&bound_path).expect("bound Codex thread should remain live"),
        )
        .expect("bound Codex thread should remain valid JSON");
        assert_ne!(migrated_bound["isArchived"], true);
        assert_eq!(
            migrated_bound["codexSessionId"],
            "019c1551-4a4f-7713-bdf9-d70ee357f287"
        );

        let marker: serde_json::Value = serde_json::from_slice(
            &fs::read(temp_root.join(CODEX_SIDEBAR_MIGRATION_MARKER))
                .expect("sidebar migration marker should exist"),
        )
        .expect("sidebar migration marker should be valid JSON");
        assert_eq!(marker["removedThreadCount"], 0);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_sidebar_migration_marker_makes_removal_idempotent() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-sidebar-idempotence-test-{}",
            Uuid::new_v4()
        ));
        write_codex_only_marker_fixture(&temp_root, "2026-02-01T00:00:00Z");
        let mut legacy_thread = dated_thread_fixture("legacy-thread", "2026-01-01T00:00:00Z");
        legacy_thread["unknownObject"] = serde_json::json!({
            "preserve": {
                "all": ["of", "this"],
            },
        });
        let thread_path = write_thread_fixture(&temp_root, "legacy-thread", &legacy_thread);
        let original_raw =
            fs::read(&thread_path).expect("legacy thread fixture should be readable");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        ensure_base_dirs().expect("first sidebar migration should succeed");
        let marker_path = temp_root.join(CODEX_SIDEBAR_MIGRATION_MARKER);
        let marker_after_first_run =
            fs::read(&marker_path).expect("sidebar migration marker should exist");
        let backup_path = temp_root
            .join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
            .join("workspace-1/legacy-thread/thread.json");
        assert!(!thread_path.exists());
        assert_eq!(
            fs::read(&backup_path).expect("legacy thread backup should exist"),
            original_raw
        );

        // Recreating a matching live record after completion must not rerun the
        // one-time migration or overwrite the existing backup.
        let recreated_path = write_thread_fixture(&temp_root, "legacy-thread", &legacy_thread);
        ensure_base_dirs().expect("subsequent initialization should succeed");

        assert!(recreated_path.exists());
        assert_eq!(
            fs::read(&backup_path).expect("original backup should remain stored"),
            original_raw
        );
        assert_eq!(
            fs::read(&marker_path).expect("marker should remain stored"),
            marker_after_first_run
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_sidebar_migration_uses_collision_safe_backup_names() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-sidebar-backup-collision-test-{}",
            Uuid::new_v4()
        ));
        write_codex_only_marker_fixture(&temp_root, "2026-02-01T00:00:00Z");
        let legacy_thread = dated_thread_fixture("collision-thread", "2026-01-01T00:00:00Z");
        let thread_path = write_thread_fixture(&temp_root, "collision-thread", &legacy_thread);
        let original_raw =
            fs::read(&thread_path).expect("legacy thread fixture should be readable");

        let backup_workspace_dir = temp_root
            .join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
            .join("workspace-1");
        let occupied_path = backup_workspace_dir.join("collision-thread");
        fs::create_dir_all(&occupied_path).expect("failed to create occupied backup fixture");
        fs::write(occupied_path.join("sentinel.txt"), b"do not overwrite")
            .expect("failed to write occupied backup fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        ensure_base_dirs().expect("sidebar migration should succeed");

        assert!(!thread_path.exists());
        assert_eq!(
            fs::read(occupied_path.join("sentinel.txt"))
                .expect("occupied backup should remain intact"),
            b"do not overwrite"
        );
        let collision_backups: Vec<PathBuf> = fs::read_dir(&backup_workspace_dir)
            .expect("backup workspace should be readable")
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name();
                let name = name.to_str()?;
                (name.starts_with("collision-thread-")
                    && entry.path().join("thread.json").is_file())
                .then(|| entry.path())
            })
            .collect();
        assert_eq!(collision_backups.len(), 1);
        assert_eq!(
            fs::read(collision_backups[0].join("thread.json"))
                .expect("collision-safe backup should contain metadata"),
            original_raw
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_only_migration_resets_legacy_full_access_and_preserves_storage() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-migration-test-{}", Uuid::new_v4()));
        let thread_dir = temp_root.join("threads/workspace-1/thread-1");
        fs::create_dir_all(&thread_dir).expect("failed to create legacy thread fixture");
        fs::write(temp_root.join("preserve-me.txt"), "unchanged")
            .expect("failed to create preservation fixture");
        fs::write(
            thread_dir.join("thread.json"),
            serde_json::to_vec_pretty(&legacy_thread_fixture(true))
                .expect("failed to serialize legacy thread"),
        )
        .expect("failed to write legacy thread");
        fs::write(
            temp_root.join("settings.json"),
            br#"{"defaultNewThreadFullAccess":true,"customLegacyField":"preserved"}"#,
        )
        .expect("failed to write legacy settings");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let resolved_root = ensure_base_dirs().expect("migration should succeed");

        assert_eq!(resolved_root, temp_root);
        assert_eq!(
            fs::read_to_string(temp_root.join("preserve-me.txt"))
                .expect("preserved fixture should remain"),
            "unchanged"
        );
        let migrated_path = temp_root
            .join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
            .join("workspace-1/thread-1/thread.json");
        let migrated: serde_json::Value = serde_json::from_slice(
            &fs::read(migrated_path).expect("migrated thread backup should exist"),
        )
        .expect("migrated thread backup should remain valid JSON");
        assert_eq!(migrated["fullAccess"], false);
        assert_eq!(migrated["customLegacyField"], "preserved");
        let settings: serde_json::Value = serde_json::from_slice(
            &fs::read(temp_root.join("settings.json")).expect("migrated settings should exist"),
        )
        .expect("migrated settings should remain valid JSON");
        assert_eq!(settings["defaultNewThreadFullAccess"], false);
        assert_eq!(settings["customLegacyField"], "preserved");

        let marker_path = temp_root.join(CODEX_ONLY_MIGRATION_MARKER);
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(&marker_path).expect("migration marker should exist"))
                .expect("migration marker should be valid JSON");
        assert_eq!(marker["version"], CODEX_ONLY_MIGRATION_VERSION);
        assert_eq!(marker["resetThreadCount"], 1);
        assert_eq!(marker["resetDefaultFullAccess"], true);
        assert_eq!(marker["quarantinedFileCount"], 0);
        assert!(marker["completedAt"].is_string());
        assert!(!temp_root.join("agents").exists());
        assert!(
            fs::read_dir(marker_path.parent().expect("marker should have a parent"))
                .expect("migration directory should be readable")
                .all(|entry| !entry
                    .expect("migration directory entry should be readable")
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-"))
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_only_migration_runs_once_after_marker_is_recorded() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-one-time-migration-test-{}",
            Uuid::new_v4()
        ));
        let thread_path = temp_root.join("threads/workspace-1/thread-1/thread.json");
        fs::create_dir_all(
            thread_path
                .parent()
                .expect("thread path should have a parent"),
        )
        .expect("failed to create legacy thread fixture");
        fs::write(
            &thread_path,
            serde_json::to_vec(&legacy_thread_fixture(true))
                .expect("failed to serialize legacy thread"),
        )
        .expect("failed to write legacy thread");
        let settings_path = temp_root.join("settings.json");
        fs::write(&settings_path, br#"{"defaultNewThreadFullAccess":true}"#)
            .expect("failed to write legacy settings");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        ensure_base_dirs().expect("first migration should succeed");
        let mut explicit_thread = legacy_thread_fixture(true);
        explicit_thread["customLegacyField"] = serde_json::Value::String("explicit".to_string());
        fs::create_dir_all(
            thread_path
                .parent()
                .expect("thread path should have a parent"),
        )
        .expect("failed to recreate the live thread directory");
        fs::write(
            &thread_path,
            serde_json::to_vec(&explicit_thread).expect("failed to serialize explicit choice"),
        )
        .expect("failed to simulate an explicit post-migration choice");
        fs::write(&settings_path, br#"{"defaultNewThreadFullAccess":true}"#)
            .expect("failed to simulate an explicit post-migration default");
        ensure_base_dirs().expect("subsequent initialization should succeed");

        let thread: serde_json::Value =
            serde_json::from_slice(&fs::read(&thread_path).expect("thread should remain readable"))
                .expect("thread should remain valid JSON");
        assert_eq!(thread["fullAccess"], true);
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).expect("settings should be readable"))
                .expect("settings should remain valid JSON");
        assert_eq!(settings["defaultNewThreadFullAccess"], true);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_only_migration_quarantines_invalid_files_and_uses_safe_settings() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-invalid-migration-test-{}",
            Uuid::new_v4()
        ));
        let thread_path = temp_root.join("threads/workspace-1/thread-1/thread.json");
        fs::create_dir_all(
            thread_path
                .parent()
                .expect("thread path should have a parent"),
        )
        .expect("failed to create invalid legacy thread fixture");
        fs::write(&thread_path, b"{not-json").expect("failed to write invalid thread fixture");
        let settings_path = temp_root.join("settings.json");
        fs::write(&settings_path, b"{also-not-json")
            .expect("failed to write invalid settings fixture");
        let workspaces_path = temp_root.join("workspaces.json");
        fs::write(&workspaces_path, b"[{invalid-workspace")
            .expect("failed to write invalid workspaces fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        ensure_base_dirs().expect("invalid metadata should be quarantined");

        assert!(!thread_path.exists());
        assert_eq!(
            fs::read(thread_path.with_file_name("thread.json.codex-only-v1.invalid"))
                .expect("invalid thread should be preserved"),
            b"{not-json"
        );
        assert_eq!(
            fs::read(settings_path.with_file_name("settings.json.codex-only-v1.invalid"))
                .expect("invalid settings should be preserved"),
            b"{also-not-json"
        );
        assert_eq!(
            fs::read(&workspaces_path).expect("safe workspaces should be recreated"),
            b"[]"
        );
        assert_eq!(
            fs::read(workspaces_path.with_file_name("workspaces.json.codex-only-v1.invalid"))
                .expect("invalid workspaces should be preserved"),
            b"[{invalid-workspace"
        );
        let safe_settings = load_settings().expect("safe default settings should load");
        assert!(!safe_settings.default_new_thread_full_access);
        assert!(load_workspaces()
            .expect("safe default workspaces should load")
            .is_empty());
        let marker: serde_json::Value = serde_json::from_slice(
            &fs::read(temp_root.join(CODEX_ONLY_MIGRATION_MARKER))
                .expect("completed migration should have a marker"),
        )
        .expect("migration marker should be valid");
        assert_eq!(marker["quarantinedFileCount"], 3);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_only_migration_quarantines_mismatched_thread_identity() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-mismatched-thread-migration-test-{}",
            Uuid::new_v4()
        ));
        let thread_path = temp_root.join("threads/workspace-1/thread-1/thread.json");
        fs::create_dir_all(
            thread_path
                .parent()
                .expect("thread path should have a parent"),
        )
        .expect("failed to create legacy thread fixture");
        let mut mismatched = legacy_thread_fixture(true);
        mismatched["id"] = serde_json::Value::String("redirected-thread".to_string());
        let original_raw =
            serde_json::to_vec_pretty(&mismatched).expect("fixture should serialize");
        fs::write(&thread_path, &original_raw).expect("fixture should be written");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        ensure_base_dirs().expect("mismatched metadata should be quarantined");

        assert!(!thread_path.exists());
        assert_eq!(
            fs::read(thread_path.with_file_name("thread.json.codex-only-v1.invalid"))
                .expect("mismatched metadata should be preserved"),
            original_raw
        );
        assert!(
            !temp_root
                .join("threads/workspace-1/redirected-thread/thread.json")
                .exists(),
            "migration must not redirect a write using an embedded thread id"
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_only_migration_is_atomic_under_concurrent_initialization() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-concurrent-migration-test-{}",
            Uuid::new_v4()
        ));
        let thread_path = temp_root.join("threads/workspace-1/thread-1/thread.json");
        fs::create_dir_all(
            thread_path
                .parent()
                .expect("thread path should have a parent"),
        )
        .expect("failed to create legacy thread fixture");
        fs::write(
            &thread_path,
            serde_json::to_vec(&legacy_thread_fixture(true))
                .expect("failed to serialize legacy thread"),
        )
        .expect("failed to write legacy thread");
        fs::write(
            temp_root.join("settings.json"),
            br#"{"defaultNewThreadFullAccess":true}"#,
        )
        .expect("failed to write legacy settings");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let initializers: Vec<_> = (0..8)
            .map(|_| std::thread::spawn(ensure_base_dirs))
            .collect();
        for initializer in initializers {
            assert_eq!(
                initializer
                    .join()
                    .expect("initializer should not panic")
                    .expect("initializer should succeed"),
                temp_root
            );
        }

        let migrated_thread_path = temp_root
            .join(CODEX_SIDEBAR_MIGRATION_BACKUP_DIR)
            .join("workspace-1/thread-1/thread.json");
        let thread: serde_json::Value = serde_json::from_slice(
            &fs::read(migrated_thread_path).expect("thread backup should be readable"),
        )
        .expect("thread backup should remain valid JSON");
        assert_eq!(thread["fullAccess"], false);
        let marker_path = temp_root.join(CODEX_ONLY_MIGRATION_MARKER);
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(&marker_path).expect("marker should exist"))
                .expect("marker should remain valid JSON");
        assert_eq!(marker["resetThreadCount"], 1);
        assert_eq!(marker["resetDefaultFullAccess"], true);
        assert!(
            fs::read_dir(marker_path.parent().expect("marker should have a parent"))
                .expect("migration directory should be readable")
                .all(|entry| !entry
                    .expect("migration entry should be readable")
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-"))
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn add_workspace_persists_across_loads() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!("atcontroller-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let added = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let first_load = load_workspaces().expect("workspaces should load");
        let second_load = load_workspaces().expect("workspaces should load after reload");

        assert_eq!(first_load.len(), 1);
        assert_eq!(second_load.len(), 1);
        assert_eq!(first_load[0].id, added.id);
        assert_eq!(first_load[0].path, second_load[0].path);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn add_ssh_workspace_persists_command_and_kind() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-ssh-workspace-test-{}",
            Uuid::new_v4()
        ));
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let added = add_ssh_workspace(
            "ssh dev@remote-host",
            Some("remote-host"),
            Some("  ~/projects/example  "),
        )
        .expect("ssh workspace should be added");
        assert_eq!(added.kind, WorkspaceKind::Ssh);
        assert_eq!(
            added.ssh_command.as_deref(),
            Some("'ssh' 'dev@remote-host'")
        );
        assert_eq!(added.remote_path.as_deref(), Some("~/projects/example"));
        assert!(
            added.path.starts_with("ssh-workspace-"),
            "ssh workspace path should use deterministic non-filesystem marker"
        );

        let loaded = load_workspaces().expect("workspaces should load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, added.id);
        assert_eq!(loaded[0].kind, WorkspaceKind::Ssh);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn add_rdev_workspace_persists_command_and_kind() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-rdev-workspace-test-{}",
            Uuid::new_v4()
        ));
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let added = add_rdev_workspace("rdev ssh team/example-env", Some("example-env"))
            .expect("rdev workspace should be added");
        assert_eq!(added.kind, WorkspaceKind::Rdev);
        assert_eq!(
            added.rdev_ssh_command.as_deref(),
            Some("'rdev' 'ssh' 'team/example-env'")
        );
        assert!(
            added.path.starts_with("rdev-workspace-"),
            "rdev workspace path should use deterministic non-filesystem marker"
        );

        let loaded = load_workspaces().expect("workspaces should load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, added.id);
        assert_eq!(loaded[0].kind, WorkspaceKind::Rdev);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_workspace_remote_path_trims_and_clears() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-ssh-remote-path-test-{}",
            Uuid::new_v4()
        ));
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let added = add_ssh_workspace("ssh dev@remote-host", Some("remote-host"), None)
            .expect("ssh workspace should be added");
        assert!(added.remote_path.is_none());

        let updated = set_workspace_remote_path(&added.id, Some("  ~/projects/foo  "))
            .expect("should set remote path");
        assert_eq!(updated.remote_path.as_deref(), Some("~/projects/foo"));

        let cleared =
            set_workspace_remote_path(&added.id, Some("   ")).expect("should clear remote path");
        assert!(cleared.remote_path.is_none());

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn remove_workspace_prunes_registry_and_thread_storage() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-remove-workspace-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");
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

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn full_access_persists_per_thread() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-thread-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");

        let updated = set_thread_full_access(&workspace.id, &thread.id, true)
            .expect("full access should update");
        assert!(updated.full_access);

        let reloaded =
            read_thread_metadata(&workspace.id, &thread.id).expect("thread should reload");
        assert!(reloaded.full_access);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn create_thread_can_start_with_full_access_enabled() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-create-thread-full-access-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, true).expect("thread should be created");

        assert!(thread.full_access);
        assert!(
            !thread_dir(&workspace.id, &thread.id)
                .expect("thread dir should resolve")
                .join("transcript.jsonl")
                .exists(),
            "interactive threads should not create the removed transcript surface"
        );

        let reloaded =
            read_thread_metadata(&workspace.id, &thread.id).expect("thread should reload");
        assert!(reloaded.full_access);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn imported_thread_is_committed_once_and_session_ids_are_globally_unique() {
        let _guard = test_env_lock().lock().expect("lock poisoned");
        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-atomic-import-test-{}",
            Uuid::new_v4()
        ));
        let first_path = temp_root.join("first");
        let second_path = temp_root.join("second");
        fs::create_dir_all(&first_path).expect("failed to create first workspace");
        fs::create_dir_all(&second_path).expect("failed to create second workspace");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let first = add_workspace(first_path.to_string_lossy().as_ref())
            .expect("first workspace should be added");
        let second = add_workspace(second_path.to_string_lossy().as_ref())
            .expect("second workspace should be added");
        let session_id = "123e4567-e89b-12d3-a456-426614174000";
        let imported =
            create_imported_codex_thread(&first.id, session_id, Some("  Imported work  "), true)
                .expect("imported thread should be committed");

        assert_eq!(imported.title, "Imported work");
        assert!(imported.full_access);
        assert_eq!(imported.codex_session_id.as_deref(), Some(session_id));
        assert!(
            fs::read_dir(thread_workspace_dir(&first.id).expect("workspace dir should resolve"))
                .expect("workspace dir should be readable")
                .all(|entry| {
                    !entry
                        .expect("thread entry should be readable")
                        .file_name()
                        .to_string_lossy()
                        .contains("import-staging")
                }),
            "successful import must not leave a staging directory"
        );

        let duplicate =
            create_imported_codex_thread(&second.id, session_id, Some("Duplicate"), false)
                .expect_err("the same session cannot be active in another workspace");
        assert!(duplicate.to_string().contains("already imported"));
        assert!(list_threads(&second.id)
            .expect("second workspace should remain listable")
            .is_empty());
        assert!(known_codex_session_ids()
            .expect("known sessions should load")
            .contains(session_id));
        assert!(!hidden_codex_session_ids()
            .expect("failed imports must not hide their source session")
            .contains(session_id));

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn user_deletion_and_workspace_removal_persist_sidebar_suppression() {
        let _guard = test_env_lock().lock().expect("lock poisoned");
        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-sidebar-suppression-test-{}",
            Uuid::new_v4()
        ));
        let first_path = temp_root.join("first");
        let second_path = temp_root.join("second");
        fs::create_dir_all(&first_path).expect("failed to create first workspace");
        fs::create_dir_all(&second_path).expect("failed to create second workspace");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let first = add_workspace(first_path.to_string_lossy().as_ref())
            .expect("first workspace should be added");
        let second = add_workspace(second_path.to_string_lossy().as_ref())
            .expect("second workspace should be added");
        let deleted_session = "123e4567-e89b-12d3-a456-426614174001";
        let removed_workspace_session = "123e4567-e89b-12d3-a456-426614174002";
        let deleted =
            create_imported_codex_thread(&first.id, deleted_session, Some("Delete me"), false)
                .expect("deleted fixture should import");
        create_imported_codex_thread(
            &second.id,
            removed_workspace_session,
            Some("Remove project"),
            false,
        )
        .expect("workspace fixture should import");

        delete_thread_from_sidebar(&first.id, &deleted.id).expect("user deletion should succeed");
        assert!(hidden_codex_session_ids()
            .expect("hidden sessions should load")
            .contains(deleted_session));

        restore_codex_session_to_sidebar(deleted_session)
            .expect("explicit restore should clear suppression");
        assert!(!hidden_codex_session_ids()
            .expect("hidden sessions should reload")
            .contains(deleted_session));

        assert!(remove_workspace(&second.id).expect("workspace should be removed"));
        assert!(hidden_codex_session_ids()
            .expect("workspace sessions should be hidden")
            .contains(removed_workspace_session));

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn codex_session_id_persists_per_thread() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-session-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");

        let captured = set_thread_codex_session_id_if_missing(
            &workspace.id,
            &thread.id,
            "123e4567-e89b-12d3-a456-426614174000",
        )
        .expect("session id should persist")
        .expect("thread should update");
        assert_eq!(
            captured.codex_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let duplicate = set_thread_codex_session_id_if_missing(
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
            reloaded.codex_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let cleared =
            clear_thread_codex_session(&workspace.id, &thread.id).expect("clear should succeed");
        assert!(cleared.codex_session_id.is_none());

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_codex_session_id_overwrites_and_trims() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-force-session-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");

        let updated = set_thread_codex_session_id(
            &workspace.id,
            &thread.id,
            " 123e4567-e89b-12d3-a456-426614174000 ",
        )
        .expect("force set should succeed");
        assert_eq!(
            updated.codex_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );

        let overwritten = set_thread_codex_session_id(
            &workspace.id,
            &thread.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("overwrite should succeed");
        assert_eq!(
            overwritten.codex_session_id.as_deref(),
            Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        );

        let cleared = set_thread_codex_session_id(&workspace.id, &thread.id, "   ")
            .expect("clear should succeed");
        assert!(cleared.codex_session_id.is_none());

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn rejects_invalid_thread_path_segments() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-invalid-thread-id-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);
        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");

        let error = read_thread_metadata(&workspace.id, "../escape")
            .expect_err("invalid thread id should fail");
        assert!(
            error.to_string().contains("Invalid thread id"),
            "unexpected error: {error}"
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_codex_session_id_is_atomic_across_threads() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-session-race-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");

        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");

        let mut handles = Vec::new();
        for _ in 0..8 {
            let workspace_id = workspace.id.clone();
            let thread_id = thread.id.clone();
            let session_candidate = Uuid::new_v4().to_string();
            handles.push(std::thread::spawn(move || {
                set_thread_codex_session_id_if_missing(
                    &workspace_id,
                    &thread_id,
                    &session_candidate,
                )
                .expect("capture should not fail")
                .and_then(|metadata| metadata.codex_session_id)
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
            .codex_session_id
            .expect("session id should be stored");
        assert_eq!(stored, captured[0]);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn clear_thread_pending_fork_resets_pending_state_without_changing_session_id() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-clear-pending-fork-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");
        let thread = set_thread_codex_session_id(
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
            cleared.codex_session_id.as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
        assert!(cleared.pending_fork_source_codex_session_id.is_none());
        assert!(cleared.pending_fork_known_child_session_ids.is_empty());
        assert!(cleared.pending_fork_requested_at.is_none());
        assert!(!cleared.pending_fork_launch_consumed);

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn mark_thread_pending_fork_consumed_sets_consumed_flag() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-consume-pending-fork-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");
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

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn commit_prepared_thread_pending_fork_sets_pending_state_and_consumed_flag() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-commit-prepared-pending-fork-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");
        let prepared = PreparedNativeFork {
            source_codex_session_id: "123e4567-e89b-12d3-a456-426614174000".to_string(),
            known_child_session_ids: vec!["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string()],
            requested_at: Utc::now(),
        };

        let committed = commit_prepared_thread_pending_fork(&workspace.id, &thread.id, &prepared)
            .expect("prepared fork should commit");

        assert_eq!(
            committed.pending_fork_source_codex_session_id.as_deref(),
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

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_codex_session_id_rejects_duplicate_claims() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-duplicate-session-claim-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread_a = create_thread(&workspace.id, false).expect("thread A should be created");
        let thread_b = create_thread(&workspace.id, false).expect("thread B should be created");
        set_thread_codex_session_id(
            &workspace.id,
            &thread_a.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("thread A should claim the session");

        let error = set_thread_codex_session_id(
            &workspace.id,
            &thread_b.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect_err("duplicate claim should fail");

        assert!(error
            .to_string()
            .contains("already claimed by another thread"));

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn set_thread_codex_session_id_allows_reuse_from_archived_thread() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-archived-session-claim-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread_a = create_thread(&workspace.id, false).expect("thread A should be created");
        let thread_b = create_thread(&workspace.id, false).expect("thread B should be created");

        set_thread_codex_session_id(
            &workspace.id,
            &thread_a.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("thread A should claim the session");
        archive_thread(&workspace.id, &thread_a.id).expect("thread A should be archived");

        let reused = set_thread_codex_session_id(
            &workspace.id,
            &thread_b.id,
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )
        .expect("archived thread should not block reuse");

        assert_eq!(
            reused.codex_session_id.as_deref(),
            Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn source_session_is_unclaimed_after_native_fork_resolution_via_set_session_id() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-fork-unclaim-test-{}", Uuid::new_v4()));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("create workspace");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace =
            add_workspace(workspace_path.to_string_lossy().as_ref()).expect("add workspace");
        let thread = create_thread(&workspace.id, false).expect("create thread");

        let source_session = "99999999-9999-9999-9999-999999999999";
        let child_session = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

        // Bind source session to the thread.
        set_thread_codex_session_id(&workspace.id, &thread.id, source_session)
            .expect("set source session");

        // Commit a pending native fork.
        let prepared = PreparedNativeFork {
            source_codex_session_id: source_session.to_string(),
            known_child_session_ids: vec![],
            requested_at: Utc::now(),
        };
        commit_prepared_thread_pending_fork(&workspace.id, &thread.id, &prepared)
            .expect("commit pending fork");

        // Simulate resolution: rebind thread to the child session.
        let resolved = set_thread_codex_session_id(&workspace.id, &thread.id, child_session)
            .expect("resolve with child session");
        assert_eq!(resolved.codex_session_id.as_deref(), Some(child_session));
        assert!(resolved.pending_fork_source_codex_session_id.is_none());
        assert_eq!(
            resolved.forked_from_codex_session_id.as_deref(),
            Some(source_session)
        );

        // Import the source session into a brand-new thread — must succeed.
        let import_thread = create_thread(&workspace.id, false).expect("create import thread");
        let imported =
            set_thread_codex_session_id(&workspace.id, &import_thread.id, source_session)
                .expect("import source session should succeed");
        assert_eq!(imported.codex_session_id.as_deref(), Some(source_session));

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn thread_metadata_reads_reject_directory_identity_mismatches_without_redirecting_writes() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-thread-identity-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");
        let metadata_path =
            thread_metadata_path(&workspace.id, &thread.id).expect("metadata path should resolve");

        let redirected_thread_id = "redirected-thread";
        let mut wrong_thread_id =
            serde_json::to_value(&thread).expect("thread fixture should serialize");
        wrong_thread_id["id"] = serde_json::Value::String(redirected_thread_id.to_string());
        let wrong_thread_raw =
            serde_json::to_vec_pretty(&wrong_thread_id).expect("fixture should serialize");
        fs::write(&metadata_path, &wrong_thread_raw).expect("fixture should be written");

        assert!(read_thread_metadata(&workspace.id, &thread.id).is_err());
        assert!(rename_thread(
            &workspace.id,
            &thread.id,
            "This must not be redirected".to_string()
        )
        .is_err());
        assert_eq!(
            fs::read(&metadata_path).expect("mismatched metadata should remain untouched"),
            wrong_thread_raw
        );
        assert!(
            !thread_dir(&workspace.id, redirected_thread_id)
                .expect("redirected path should resolve")
                .exists(),
            "a mismatched embedded thread id must not redirect a metadata write"
        );

        let redirected_workspace_id = "redirected-workspace";
        let mut wrong_workspace_id =
            serde_json::to_value(&thread).expect("thread fixture should serialize");
        wrong_workspace_id["workspaceId"] =
            serde_json::Value::String(redirected_workspace_id.to_string());
        let wrong_workspace_raw =
            serde_json::to_vec_pretty(&wrong_workspace_id).expect("fixture should serialize");
        fs::write(&metadata_path, &wrong_workspace_raw).expect("fixture should be written");

        assert!(read_thread_metadata(&workspace.id, &thread.id).is_err());
        assert!(
            list_threads(&workspace.id).is_err(),
            "directory scans must fail closed on mismatched metadata"
        );
        assert!(set_thread_full_access(&workspace.id, &thread.id, true).is_err());
        assert_eq!(
            fs::read(&metadata_path).expect("mismatched metadata should remain untouched"),
            wrong_workspace_raw
        );
        assert!(
            !thread_dir(redirected_workspace_id, &thread.id)
                .expect("redirected path should resolve")
                .exists(),
            "a mismatched embedded workspace id must not redirect a metadata write"
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn deleted_thread_tombstone_blocks_async_finalizer_writes() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-thread-tombstone-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");
        let run_id = Uuid::new_v4().to_string();
        let original_thread_dir =
            thread_dir(&workspace.id, &thread.id).expect("thread path should resolve");
        fs::create_dir_all(
            runs_dir(&workspace.id, &thread.id)
                .expect("runs path should resolve")
                .join(&run_id),
        )
        .expect("run fixture should be created");

        delete_thread(&workspace.id, &thread.id).expect("thread deletion should succeed");

        assert!(write_thread_run_json_file(
            &workspace.id,
            &thread.id,
            &run_id,
            "metadata.json",
            &serde_json::json!({"ended": true})
        )
        .is_err());
        assert!(write_thread_run_file(
            &workspace.id,
            &thread.id,
            &run_id,
            "patch.diff",
            b"late patch"
        )
        .is_err());
        assert!(set_latest_thread_run_id(&workspace.id, &thread.id, &run_id).is_err());
        assert!(set_thread_run_state(
            &workspace.id,
            &thread.id,
            ThreadRunStatus::Succeeded,
            None,
            Some(Utc::now())
        )
        .is_err());
        assert!(
            !original_thread_dir.exists(),
            "late finalizer writes must not recreate deleted thread storage"
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn removed_workspace_tombstone_blocks_thread_and_shell_finalizer_writes() {
        let _guard = test_env_lock().lock().expect("lock poisoned");

        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-workspace-tombstone-test-{}",
            Uuid::new_v4()
        ));
        let workspace_path = temp_root.join("workspace");
        fs::create_dir_all(&workspace_path).expect("failed to create workspace fixture");
        std::env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", &temp_root);

        let workspace = add_workspace(workspace_path.to_string_lossy().as_ref())
            .expect("workspace should be added");
        let thread = create_thread(&workspace.id, false).expect("thread should be created");
        let thread_run_id = Uuid::new_v4().to_string();
        let shell_run_id = Uuid::new_v4().to_string();
        let thread_storage =
            thread_workspace_dir(&workspace.id).expect("thread storage should resolve");
        let shell_storage =
            workspace_shell_sessions_dir(&workspace.id).expect("shell storage should resolve");
        fs::create_dir_all(shell_storage.join(&shell_run_id))
            .expect("shell run fixture should be created");

        assert!(remove_workspace(&workspace.id).expect("workspace removal should succeed"));

        assert!(write_thread_run_json_file(
            &workspace.id,
            &thread.id,
            &thread_run_id,
            "metadata.json",
            &serde_json::json!({"ended": true})
        )
        .is_err());
        assert!(write_workspace_shell_run_json_file(
            &workspace.id,
            &shell_run_id,
            "metadata.json",
            &serde_json::json!({"ended": true})
        )
        .is_err());
        assert!(
            !thread_storage.exists(),
            "late finalizer writes must not recreate removed thread storage"
        );
        assert!(
            !shell_storage.exists(),
            "late finalizer writes must not recreate removed shell storage"
        );

        std::env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT");
        let _ = fs::remove_dir_all(temp_root);
    }
}
