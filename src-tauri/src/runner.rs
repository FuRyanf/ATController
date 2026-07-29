use std::collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child as StdChild, Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, Result};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Utc};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::git_tools;
use crate::models::{
    CodexTurnCompletionSummary, ImportableCodexProject, ImportableCodexSession, PreparedNativeFork,
    RecentCodexThread, Settings, TerminalDataEvent, TerminalExitEvent, TerminalOutputSnapshot,
    TerminalReadyEvent, TerminalSshAuthStatusEvent, TerminalStartResponse,
    TerminalTurnCompletedEvent, ThreadRunStatus, WorkspaceKind, WorkspaceShellStartResponse,
};
use crate::storage;

const TERMINAL_DATA_EVENT: &str = "terminal:data";
const TERMINAL_READY_EVENT: &str = "terminal:ready";
const TERMINAL_SSH_AUTH_STATUS_EVENT: &str = "terminal:ssh-auth-status";
const TERMINAL_TURN_COMPLETED_EVENT: &str = "terminal:turn-completed";
const TERMINAL_EXIT_EVENT: &str = "terminal:exit";
const THREAD_UPDATED_EVENT: &str = "thread:updated";
const LAUNCH_OUTPUT_PARSE_BUFFER_MAX: usize = 16 * 1024;
const POST_CONNECT_PROMPT_BUFFER_MAX: usize = 16 * 1024;
const POST_CONNECT_COMMAND_AFTER_SSH_START_TIMEOUT: Duration = Duration::from_secs(6);
const CODEX_TURN_COMPLETION_POLL_INTERVAL: Duration = Duration::from_millis(250);
const TERMINAL_LOG_SNAPSHOT_MAX_BYTES: u64 = 4 * 1024 * 1024;
const TERMINAL_OUTPUT_LOG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const TERMINAL_OUTPUT_LOG_COMPACT_BYTES: u64 = 6 * 1024 * 1024;
const _: () = assert!(TERMINAL_OUTPUT_LOG_COMPACT_BYTES < TERMINAL_OUTPUT_LOG_MAX_BYTES);
const RUNTIME_HISTORY_MAX_DIRECTORIES: usize = 32;
const RUNTIME_HISTORY_ACTIVE_MARKER: &str = ".active-session.json";
const TERMINAL_STREAM_TAIL_MAX_CHARS: u64 = 1_200_000;
const TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS: u64 = 120_000;
const _: () = assert!(TERMINAL_STREAM_TAIL_TRIM_HYSTERESIS < TERMINAL_STREAM_TAIL_MAX_CHARS);
const TERMINAL_ENV_DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_UPDATE_DMG_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_UPDATE_DMG_BYTES_ARG: &str = "1073741824";
const UPDATE_MANIFEST_SCHEMA_VERSION: u32 = 1;
const UPDATE_HEALTH_ACK_DELAY: Duration = Duration::from_secs(3);
const UPDATE_HEALTH_STABILITY_PERIOD: Duration = Duration::from_secs(30);
const UPDATE_HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(100);
const COMMAND_TIMEOUT_POLL_INTERVAL: Duration = Duration::from_millis(20);
const COMMAND_TERMINATION_GRACE_PERIOD: Duration = Duration::from_millis(500);
const COMMAND_OUTPUT_MAX_BYTES_PER_STREAM: usize = 1024 * 1024;
const COMMAND_OUTPUT_READ_BUFFER_BYTES: usize = 32 * 1024;
const JSONL_METADATA_CACHE_MAX_ENTRIES: usize = 256;
const JSONL_METADATA_CACHE_TAIL_HASH_BYTES: u64 = 8 * 1024;
const JSONL_SUMMARY_HEAD_BYTES: u64 = 512 * 1024;
const JSONL_SUMMARY_TAIL_BYTES: u64 = 1024 * 1024;
const JSONL_LIVE_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const JSONL_INCREMENTAL_CHUNK_BYTES: usize = 64 * 1024;
const JSONL_INCREMENTAL_MAX_BYTES_PER_POLL: usize = 4 * 1024 * 1024;
const JSONL_INCREMENTAL_MAX_LINE_BYTES: usize = 1024 * 1024;
const LOGIN_SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const CLI_VALIDATION_TIMEOUT: Duration = Duration::from_secs(10);
const RECENT_CODEX_THREADS_PER_WORKSPACE: usize = 20;
const GRACEFUL_TERMINATION_TIMEOUT: Duration = Duration::from_millis(1500);
const CODEX_FULL_ACCESS_ARGS: [&str; 1] = ["--dangerously-bypass-approvals-and-sandbox"];
const CODEX_WORKSPACE_ACCESS_ARGS: [&str; 4] = [
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
];

fn codex_access_args(full_access: bool) -> &'static [&'static str] {
    if full_access {
        &CODEX_FULL_ACCESS_ARGS
    } else {
        &CODEX_WORKSPACE_ACCESS_ARGS
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct JsonlMetadataFingerprint {
    len: u64,
    modified: SystemTime,
    tail_hash: u64,
}

#[derive(Clone)]
struct JsonlMetadataCacheEntry<T: Clone> {
    fingerprint: JsonlMetadataFingerprint,
    value: T,
}

type LatestCwdCache = HashMap<PathBuf, JsonlMetadataCacheEntry<Option<String>>>;
type LatestCompletionCache =
    HashMap<(PathBuf, String), JsonlMetadataCacheEntry<Option<CodexTurnCompletionSummary>>>;
type SessionSummaryCache = HashMap<PathBuf, JsonlMetadataCacheEntry<Option<CodexSessionSummary>>>;

fn latest_cwd_cache() -> &'static Mutex<LatestCwdCache> {
    static CACHE: OnceLock<Mutex<LatestCwdCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn latest_completion_cache() -> &'static Mutex<LatestCompletionCache> {
    static CACHE: OnceLock<Mutex<LatestCompletionCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_summary_cache() -> &'static Mutex<SessionSummaryCache> {
    static CACHE: OnceLock<Mutex<SessionSummaryCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn claimed_codex_session_ids() -> &'static Mutex<HashMap<String, String>> {
    static CLAIMS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CLAIMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn jsonl_metadata_fingerprint(path: &Path) -> Option<JsonlMetadataFingerprint> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let len = metadata.len();
    let tail_len = len.min(JSONL_METADATA_CACHE_TAIL_HASH_BYTES);

    let mut file = File::open(path).ok()?;
    if tail_len > 0 {
        file.seek(SeekFrom::End(-(tail_len as i64))).ok()?;
    }

    let mut tail = Vec::with_capacity(tail_len as usize);
    file.take(tail_len).read_to_end(&mut tail).ok()?;

    let mut hasher = DefaultHasher::new();
    tail.hash(&mut hasher);
    Some(JsonlMetadataFingerprint {
        len,
        modified,
        tail_hash: hasher.finish(),
    })
}

fn cached_jsonl_metadata_value<K, T, F>(
    cache: &'static Mutex<HashMap<K, JsonlMetadataCacheEntry<T>>>,
    key: K,
    path: &Path,
    load: F,
) -> T
where
    K: Eq + Hash + Clone,
    T: Clone,
    F: FnOnce(&Path) -> T,
{
    if let Some(fingerprint) = jsonl_metadata_fingerprint(path) {
        if let Ok(cache) = cache.lock() {
            if let Some(entry) = cache.get(&key) {
                if entry.fingerprint == fingerprint {
                    return entry.value.clone();
                }
            }
        }

        let value = load(path);
        if let Ok(mut cache) = cache.lock() {
            if cache.len() >= JSONL_METADATA_CACHE_MAX_ENTRIES && !cache.contains_key(&key) {
                if let Some(evicted_key) = cache.keys().next().cloned() {
                    cache.remove(&evicted_key);
                }
            }
            cache.insert(
                key,
                JsonlMetadataCacheEntry {
                    fingerprint,
                    value: value.clone(),
                },
            );
        }
        return value;
    }

    load(path)
}

struct BoundedCommandStream {
    bytes: VecDeque<u8>,
    truncated: bool,
}

impl BoundedCommandStream {
    fn new() -> Self {
        Self {
            bytes: VecDeque::new(),
            truncated: false,
        }
    }

    fn extend(&mut self, chunk: &[u8]) {
        if chunk.len() >= COMMAND_OUTPUT_MAX_BYTES_PER_STREAM {
            self.bytes.clear();
            self.bytes.extend(
                chunk[chunk.len() - COMMAND_OUTPUT_MAX_BYTES_PER_STREAM..]
                    .iter()
                    .copied(),
            );
            self.truncated = true;
            return;
        }

        let excess = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(COMMAND_OUTPUT_MAX_BYTES_PER_STREAM);
        if excess > 0 {
            self.bytes.drain(..excess);
            self.truncated = true;
        }
        self.bytes.extend(chunk.iter().copied());
    }

    fn finish(self, stream_name: &str) -> Vec<u8> {
        let mut retained = self.bytes.into_iter().collect::<Vec<_>>();
        if !self.truncated {
            return retained;
        }

        let marker =
            format!("[ATController: {stream_name} truncated; showing the final output bytes]\n")
                .into_bytes();
        let retained_limit = COMMAND_OUTPUT_MAX_BYTES_PER_STREAM.saturating_sub(marker.len());
        if retained.len() > retained_limit {
            retained.drain(..retained.len() - retained_limit);
        }
        let mut output = Vec::with_capacity(marker.len() + retained.len());
        output.extend_from_slice(&marker);
        output.extend_from_slice(&retained);
        output
    }
}

fn drain_command_stream<R: Read>(mut reader: R, stream_name: &str) -> std::io::Result<Vec<u8>> {
    let mut bounded = BoundedCommandStream::new();
    let mut buffer = [0_u8; COMMAND_OUTPUT_READ_BUFFER_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(bounded.finish(stream_name)),
            Ok(read) => bounded.extend(&buffer[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

fn join_command_stream(
    reader: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
    label: &str,
    stream_name: &str,
) -> Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| anyhow!("{label} {stream_name} reader thread panicked"))?
        .map_err(|error| anyhow!("{label} failed while reading {stream_name}: {error}"))
}

#[cfg(unix)]
fn signal_command_process_group(process_group_id: i32, signal: libc::c_int) -> Result<bool> {
    loop {
        let result = unsafe { libc::kill(-process_group_id, signal) };
        if result == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => return Ok(false),
            Some(libc::EINTR) => continue,
            _ => {
                return Err(anyhow!(
                    "unable to signal command process group {process_group_id}: {error}"
                ));
            }
        }
    }
}

#[cfg(unix)]
fn command_process_group_is_alive(process_group_id: i32) -> Result<bool> {
    signal_command_process_group(process_group_id, 0)
}

fn terminate_timed_out_command(child: &mut StdChild, process_group_id: u32) -> Result<()> {
    #[cfg(unix)]
    {
        let process_group_id = i32::try_from(process_group_id)
            .map_err(|_| anyhow!("command process group identifier is invalid"))?;
        let mut cleanup_error = signal_command_process_group(process_group_id, libc::SIGTERM).err();
        let graceful_started = Instant::now();

        loop {
            let group_is_alive = match command_process_group_is_alive(process_group_id) {
                Ok(alive) => alive,
                Err(error) => {
                    if cleanup_error.is_none() {
                        cleanup_error = Some(error);
                    }
                    true
                }
            };
            if !group_is_alive || graceful_started.elapsed() >= COMMAND_TERMINATION_GRACE_PERIOD {
                break;
            }
            let _ = child.try_wait();
            std::thread::sleep(COMMAND_TIMEOUT_POLL_INTERVAL);
        }

        if command_process_group_is_alive(process_group_id).unwrap_or(true) {
            if let Err(error) = signal_command_process_group(process_group_id, libc::SIGKILL) {
                if cleanup_error.is_none() {
                    cleanup_error = Some(error);
                }
                let _ = child.kill();
            }
        }
        if let Err(error) = child.wait() {
            if cleanup_error.is_none() {
                cleanup_error = Some(anyhow!("unable to reap timed-out command: {error}"));
            }
        }
        if let Some(error) = cleanup_error {
            return Err(error);
        }
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let _ = process_group_id;
        let kill_result = child.kill();
        let wait_result = child.wait();
        if let Err(error) = kill_result {
            if error.kind() != std::io::ErrorKind::InvalidInput {
                return Err(anyhow!("unable to terminate timed-out command: {error}"));
            }
        }
        wait_result
            .map(|_| ())
            .map_err(|error| anyhow!("unable to reap timed-out command: {error}"))
    }
}

fn run_std_command_with_timeout(
    mut command: StdCommand,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output> {
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let process_group_id = child.id();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = terminate_timed_out_command(&mut child, process_group_id);
            return Err(anyhow!("{label} did not provide a stdout pipe"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = terminate_timed_out_command(&mut child, process_group_id);
            return Err(anyhow!("{label} did not provide a stderr pipe"));
        }
    };
    let stdout_reader = std::thread::spawn(move || drain_command_stream(stdout, "stdout"));
    let stderr_reader = std::thread::spawn(move || drain_command_stream(stderr, "stderr"));
    let started = Instant::now();
    let mut status = None;

    loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(next_status) => status = next_status,
                Err(error) => {
                    let cleanup = terminate_timed_out_command(&mut child, process_group_id);
                    let stdout_result = join_command_stream(stdout_reader, label, "stdout");
                    let stderr_result = join_command_stream(stderr_reader, label, "stderr");
                    let mut details = Vec::new();
                    if let Err(cleanup_error) = cleanup {
                        details.push(format!("cleanup failed: {cleanup_error}"));
                    }
                    if let Err(stdout_error) = stdout_result {
                        details.push(stdout_error.to_string());
                    }
                    if let Err(stderr_error) = stderr_result {
                        details.push(stderr_error.to_string());
                    }
                    let suffix = if details.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", details.join("; "))
                    };
                    return Err(anyhow!(
                        "{label} failed while checking command status: {error}{suffix}"
                    ));
                }
            }
        }
        if status.is_some() && stdout_reader.is_finished() && stderr_reader.is_finished() {
            break;
        }
        if started.elapsed() >= timeout {
            let cleanup = terminate_timed_out_command(&mut child, process_group_id);
            let stdout_result = join_command_stream(stdout_reader, label, "stdout");
            let stderr_result = join_command_stream(stderr_reader, label, "stderr");
            let mut details = Vec::new();
            if let Err(cleanup_error) = cleanup {
                details.push(format!("cleanup failed: {cleanup_error}"));
            }
            if let Err(stdout_error) = stdout_result {
                details.push(stdout_error.to_string());
            }
            if let Err(stderr_error) = stderr_result {
                details.push(stderr_error.to_string());
            }
            let suffix = if details.is_empty() {
                String::new()
            } else {
                format!(" ({})", details.join("; "))
            };
            return Err(anyhow!(
                "{label} timed out after {}s{suffix}",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(COMMAND_TIMEOUT_POLL_INTERVAL);
    }

    let stdout = join_command_stream(stdout_reader, label, "stdout")?;
    let stderr = join_command_stream(stderr_reader, label, "stderr")?;
    Ok(std::process::Output {
        status: status.ok_or_else(|| anyhow!("{label} exited without a status"))?,
        stdout,
        stderr,
    })
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

fn sanitize_env_diagnostics_stderr(raw: &str) -> String {
    let mut result = raw
        .lines()
        .map(redact_env_line)
        .collect::<Vec<_>>()
        .join("\n");
    if raw.ends_with('\n') {
        result.push('\n');
    }
    result
}

#[derive(Debug, Deserialize)]
struct CodexJsonlEntry {
    #[serde(default)]
    timestamp: Option<DateTime<Utc>>,
    #[serde(default, rename = "type")]
    entry_type: Option<String>,
    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Debug, Clone)]
struct CodexSessionSummary {
    path: PathBuf,
    session_id: String,
    cwd: Option<String>,
    first_prompt: Option<String>,
    last_agent_message: Option<String>,
    message_count: u64,
    created_at: Option<DateTime<Utc>>,
    modified_at: Option<DateTime<Utc>>,
    git_branch: Option<String>,
    thread_source: Option<String>,
    parent_thread_id: Option<String>,
    forked_from_id: Option<String>,
}

fn canonicalize_path_or_original(path: &str) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

fn normalize_importable_project_path(path: &str) -> String {
    canonicalize_path_or_original(path)
}

fn resolve_terminal_workspace_context_path(path: &str) -> String {
    canonicalize_path_or_original(path)
}

fn trim_to_option(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_login_shell() -> String {
    env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

fn login_shell_probe(command: &str, label: &str) -> Result<String> {
    let mut shell_command = StdCommand::new(resolve_login_shell());
    shell_command.args(["-lic", command]);
    let output = run_std_command_with_timeout(shell_command, LOGIN_SHELL_PROBE_TIMEOUT, label)?;
    if !output.status.success() {
        return Err(anyhow!(
            "{label} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_marked_shell_value(output: &str, marker: &str) -> Option<String> {
    let start_marker = format!("\u{1e}{marker}=");
    let start = output.rfind(&start_marker)? + start_marker.len();
    let end = output[start..].find('\u{1e}')? + start;
    trim_to_option(Some(output[start..end].to_string()))
}

fn codex_home() -> Result<PathBuf> {
    if let Some(path) = env::var_os("CODEX_HOME").filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    static LOGIN_CODEX_HOME: OnceLock<PathBuf> = OnceLock::new();
    if let Some(path) = LOGIN_CODEX_HOME.get() {
        return Ok(path.clone());
    }
    if let Ok(output) = login_shell_probe(
        "printf '\\036ATCONTROLLER_CODEX_HOME=%s\\036' \"${CODEX_HOME:-$HOME/.codex}\"",
        "Codex home lookup",
    ) {
        if let Some(path) = parse_marked_shell_value(&output, "ATCONTROLLER_CODEX_HOME") {
            let path = PathBuf::from(path);
            let _ = LOGIN_CODEX_HOME.set(path.clone());
            return Ok(path);
        }
    }
    let home = dirs::home_dir().ok_or_else(|| anyhow!("Unable to resolve home directory"))?;
    let path = home.join(".codex");
    let _ = LOGIN_CODEX_HOME.set(path.clone());
    Ok(path)
}

fn codex_sessions_root() -> Result<PathBuf> {
    Ok(codex_home()?.join("sessions"))
}

#[derive(Default)]
struct CodexSessionPathIndex {
    root: PathBuf,
    paths_by_id: HashMap<String, PathBuf>,
    complete: bool,
}

fn codex_session_path_index() -> &'static Mutex<CodexSessionPathIndex> {
    static INDEX: OnceLock<Mutex<CodexSessionPathIndex>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(CodexSessionPathIndex::default()))
}

fn index_codex_session_paths(root: &Path, paths: &[PathBuf], replace: bool) {
    let Ok(mut index) = codex_session_path_index().lock() else {
        return;
    };
    if index.root != root || replace {
        index.root = root.to_path_buf();
        index.paths_by_id.clear();
        index.complete = false;
    }
    for path in paths {
        if let Some(session_id) = session_id_from_rollout_filename(path) {
            index.paths_by_id.insert(session_id, path.clone());
        }
    }
    if replace {
        index.complete = true;
    }
}

fn collect_codex_session_paths(directory: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    if !directory.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_codex_session_paths(&path, paths)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with("rollout-") && name.ends_with(".jsonl") {
            paths.push(path);
        }
    }
    Ok(())
}

fn codex_session_paths() -> Result<Vec<PathBuf>> {
    let root = codex_sessions_root()?;
    let mut paths = Vec::new();
    collect_codex_session_paths(&root, &mut paths)?;
    paths.sort();
    index_codex_session_paths(&root, &paths, true);
    Ok(paths)
}

fn codex_session_paths_near_root(root: &Path, timestamp: DateTime<Utc>) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut visited = HashSet::new();
    for offset in -1..=1 {
        let date = timestamp + ChronoDuration::days(offset);
        let directory = root
            .join(format!("{:04}", date.year()))
            .join(format!("{:02}", date.month()))
            .join(format!("{:02}", date.day()));
        if visited.insert(directory.clone()) {
            collect_codex_session_paths(&directory, &mut paths)?;
        }
    }
    paths.sort();
    paths.dedup();
    index_codex_session_paths(root, &paths, false);
    Ok(paths)
}

fn codex_session_paths_near(timestamp: DateTime<Utc>) -> Result<Vec<PathBuf>> {
    codex_session_paths_near_root(&codex_sessions_root()?, timestamp)
}

fn session_id_from_rollout_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let suffix_start = stem.len().checked_sub(36)?;
    let candidate = stem.get(suffix_start..)?;
    Uuid::parse_str(candidate)
        .ok()
        .map(|_| candidate.to_string())
}

fn value_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn parse_value_timestamp(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    value_string(value, key).and_then(|raw| {
        DateTime::parse_from_rfc3339(&raw)
            .ok()
            .map(|timestamp| timestamp.with_timezone(&Utc))
    })
}

fn concise_text(value: &str, limit: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(limit).collect())
}

fn is_user_visible_prompt(value: &str) -> bool {
    let trimmed = value.trim_start();
    !trimmed.is_empty()
        && !trimmed.starts_with("<environment_context>")
        && !trimmed.starts_with("<permissions instructions>")
        && !trimmed.starts_with("<collaboration_mode>")
        && !trimmed.starts_with("<skills_instructions>")
        && !trimmed.starts_with("<apps_instructions>")
        && !trimmed.starts_with("<plugins_instructions>")
}

fn read_jsonl_window(path: &Path, start: u64, length: u64) -> Result<Vec<(u64, String)>> {
    let file_len = fs::metadata(path)?.len();
    if start >= file_len || length == 0 {
        return Ok(Vec::new());
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let read_len = length.min(file_len - start);
    let mut bytes = Vec::with_capacity(read_len.min(usize::MAX as u64) as usize);
    file.take(read_len).read_to_end(&mut bytes)?;

    let mut local_start = 0usize;
    if start > 0 {
        let Some(first_newline) = bytes.iter().position(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };
        local_start = first_newline + 1;
    }
    let mut local_end = bytes.len();
    if start + read_len < file_len {
        let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(Vec::new());
        };
        local_end = last_newline + 1;
    }
    if local_start >= local_end {
        return Ok(Vec::new());
    }

    let mut lines = Vec::new();
    let mut cursor = local_start;
    while cursor < local_end {
        let relative_end = bytes[cursor..local_end]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| cursor + position + 1)
            .unwrap_or(local_end);
        let content_end = if bytes.get(relative_end.saturating_sub(1)) == Some(&b'\n') {
            relative_end - 1
        } else {
            relative_end
        };
        let line = String::from_utf8_lossy(&bytes[cursor..content_end]).to_string();
        let absolute_end = start + relative_end as u64;
        lines.push((absolute_end, line));
        cursor = relative_end;
    }
    Ok(lines)
}

fn read_bounded_jsonl_summary_lines(path: &Path) -> Result<Vec<(u64, String)>> {
    let file_len = fs::metadata(path)?.len();
    if file_len <= JSONL_SUMMARY_HEAD_BYTES + JSONL_SUMMARY_TAIL_BYTES {
        return read_jsonl_window(path, 0, file_len);
    }

    let mut lines = read_jsonl_window(path, 0, JSONL_SUMMARY_HEAD_BYTES)?;
    lines.extend(read_jsonl_window(
        path,
        file_len.saturating_sub(JSONL_SUMMARY_TAIL_BYTES),
        JSONL_SUMMARY_TAIL_BYTES,
    )?);
    Ok(lines)
}

fn load_codex_session_summary(path: &Path) -> Option<CodexSessionSummary> {
    let lines = read_bounded_jsonl_summary_lines(path).ok()?;
    let mut session_id = session_id_from_rollout_filename(path);
    let mut cwd = None;
    let mut first_prompt = None;
    let mut last_agent_message = None;
    let mut message_count = 0u64;
    let mut created_at = None;
    let mut git_branch = None;
    let mut thread_source = None;
    let mut parent_thread_id = None;
    let mut forked_from_id = None;

    for (_, line) in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<CodexJsonlEntry>(&line) else {
            continue;
        };
        let Some(payload) = entry.payload.as_ref() else {
            continue;
        };
        match entry.entry_type.as_deref() {
            Some("session_meta") => {
                session_id = trim_to_option(
                    value_string(payload, "id").or_else(|| value_string(payload, "session_id")),
                )
                .or(session_id);
                cwd = trim_to_option(value_string(payload, "cwd")).or(cwd);
                created_at = parse_value_timestamp(payload, "timestamp")
                    .or(entry.timestamp)
                    .or(created_at);
                git_branch = payload
                    .get("git")
                    .and_then(|git| value_string(git, "branch"))
                    .and_then(|value| trim_to_option(Some(value)))
                    .or(git_branch);
                thread_source =
                    trim_to_option(value_string(payload, "thread_source")).or(thread_source);
                parent_thread_id =
                    trim_to_option(value_string(payload, "parent_thread_id")).or(parent_thread_id);
                forked_from_id =
                    trim_to_option(value_string(payload, "forked_from_id")).or(forked_from_id);
            }
            Some("turn_context") => {
                cwd = trim_to_option(value_string(payload, "cwd")).or(cwd);
            }
            Some("event_msg") => match payload.get("type").and_then(Value::as_str) {
                Some("user_message") => {
                    message_count = message_count.saturating_add(1);
                    if first_prompt.is_none() {
                        if let Some(message) = value_string(payload, "message")
                            .filter(|message| is_user_visible_prompt(message))
                        {
                            first_prompt = concise_text(&message, 500);
                        }
                    }
                }
                Some("agent_message") => {
                    if let Some(message) = value_string(payload, "message") {
                        last_agent_message = concise_text(&message, 500);
                    }
                }
                Some("task_complete") => {
                    if let Some(message) = value_string(payload, "last_agent_message") {
                        last_agent_message = concise_text(&message, 500);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    let session_id = session_id.and_then(|value| trim_to_option(Some(value)))?;
    let modified_at = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(DateTime::<Utc>::from);

    Some(CodexSessionSummary {
        path: path.to_path_buf(),
        session_id,
        cwd,
        first_prompt,
        last_agent_message,
        message_count,
        created_at,
        modified_at,
        git_branch,
        thread_source,
        parent_thread_id,
        forked_from_id,
    })
}

fn read_codex_session_summary(path: &Path) -> Result<Option<CodexSessionSummary>> {
    Ok(cached_jsonl_metadata_value(
        session_summary_cache(),
        path.to_path_buf(),
        path,
        load_codex_session_summary,
    ))
}

fn session_is_top_level(summary: &CodexSessionSummary) -> bool {
    (match summary.thread_source.as_deref() {
        Some(source) => source.eq_ignore_ascii_case("user"),
        None => true,
    }) && summary.parent_thread_id.is_none()
}

fn importable_session(summary: &CodexSessionSummary) -> ImportableCodexSession {
    ImportableCodexSession {
        session_id: summary.session_id.clone(),
        summary: summary.last_agent_message.clone(),
        first_prompt: summary.first_prompt.clone(),
        message_count: summary.message_count,
        created_at: summary.created_at,
        modified_at: summary.modified_at,
        git_branch: summary.git_branch.clone(),
    }
}

fn session_sort_timestamp(session: &ImportableCodexSession) -> i64 {
    session
        .modified_at
        .or(session.created_at)
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or_default()
}

fn project_sort_timestamp(project: &ImportableCodexProject) -> i64 {
    project
        .sessions
        .iter()
        .map(session_sort_timestamp)
        .max()
        .unwrap_or_default()
}

fn codex_project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalWorkspaceMatch {
    path: PathBuf,
    id: String,
    name: String,
}

fn load_local_workspace_lookup() -> Result<Vec<LocalWorkspaceMatch>> {
    let mut workspaces = storage::load_workspaces()?
        .into_iter()
        .filter(|workspace| workspace.kind == WorkspaceKind::Local)
        .map(|workspace| LocalWorkspaceMatch {
            path: PathBuf::from(canonicalize_path_or_original(&workspace.path)),
            id: workspace.id,
            name: workspace.name,
        })
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| {
        right
            .path
            .components()
            .count()
            .cmp(&left.path.components().count())
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(workspaces)
}

fn owning_local_workspace<'a>(
    workspace_lookup: &'a [LocalWorkspaceMatch],
    session_cwd: &str,
) -> Option<&'a LocalWorkspaceMatch> {
    let session_path = PathBuf::from(canonicalize_path_or_original(session_cwd));
    workspace_lookup.iter().find(|workspace| {
        session_path == workspace.path || session_path.starts_with(&workspace.path)
    })
}

pub fn discover_importable_codex_sessions() -> Result<Vec<ImportableCodexProject>> {
    let workspace_lookup = load_local_workspace_lookup()?;
    let mut grouped: HashMap<String, Vec<ImportableCodexSession>> = HashMap::new();
    for path in codex_session_paths()? {
        let Some(summary) = read_codex_session_summary(&path)? else {
            continue;
        };
        if !session_is_top_level(&summary) {
            continue;
        }
        let Some(cwd) = summary
            .cwd
            .as_deref()
            .map(normalize_importable_project_path)
        else {
            continue;
        };
        grouped
            .entry(cwd)
            .or_default()
            .push(importable_session(&summary));
    }

    let mut projects = grouped
        .into_iter()
        .map(|(path, mut sessions)| {
            sessions.sort_by(|left, right| {
                session_sort_timestamp(right)
                    .cmp(&session_sort_timestamp(left))
                    .then_with(|| left.session_id.cmp(&right.session_id))
            });
            let workspace = owning_local_workspace(&workspace_lookup, &path);
            ImportableCodexProject {
                name: codex_project_name(&path),
                path: path.clone(),
                path_exists: Path::new(&path).is_dir(),
                workspace_id: workspace.map(|workspace| workspace.id.clone()),
                workspace_name: workspace.map(|workspace| workspace.name.clone()),
                sessions,
            }
        })
        .collect::<Vec<_>>();
    projects.sort_by(|left, right| {
        project_sort_timestamp(right)
            .cmp(&project_sort_timestamp(left))
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(projects)
}

fn recent_codex_thread_title(session: &ImportableCodexSession) -> String {
    let source = session
        .summary
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            session
                .first_prompt
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or("Codex thread");
    let normalized = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = normalized.chars().take(120).collect::<String>();
    if normalized.chars().count() > 120 {
        title.push('…');
    }
    if title.is_empty() {
        "Codex thread".to_string()
    } else {
        title
    }
}

pub fn list_recent_codex_threads() -> Result<Vec<RecentCodexThread>> {
    let known_session_ids = storage::known_codex_session_ids()?;
    let hidden_session_ids = storage::hidden_codex_session_ids()?;
    let mut recent = discover_importable_codex_sessions()?
        .into_iter()
        .filter_map(|project| {
            project
                .workspace_id
                .clone()
                .map(|workspace_id| (workspace_id, project))
        })
        .flat_map(|(workspace_id, project)| {
            project.sessions.into_iter().filter_map({
                let known_session_ids = &known_session_ids;
                let hidden_session_ids = &hidden_session_ids;
                move |session| {
                    if known_session_ids.contains(&session.session_id)
                        || hidden_session_ids.contains(&session.session_id)
                    {
                        return None;
                    }
                    let created_at = session
                        .created_at
                        .map(|timestamp| timestamp.timestamp())
                        .unwrap_or_default();
                    let updated_at = session
                        .modified_at
                        .or(session.created_at)
                        .map(|timestamp| timestamp.timestamp())
                        .unwrap_or(created_at);
                    Some(RecentCodexThread {
                        session_id: session.session_id.clone(),
                        workspace_id: workspace_id.clone(),
                        title: recent_codex_thread_title(&session),
                        created_at,
                        updated_at,
                        recency_at: Some(updated_at),
                    })
                }
            })
        })
        .collect::<Vec<_>>();
    recent.sort_by(|left, right| {
        right
            .recency_at
            .unwrap_or(right.updated_at)
            .cmp(&left.recency_at.unwrap_or(left.updated_at))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    let mut per_workspace_count = HashMap::<String, usize>::new();
    recent.retain(|thread| {
        let count = per_workspace_count
            .entry(thread.workspace_id.clone())
            .or_default();
        if *count >= RECENT_CODEX_THREADS_PER_WORKSPACE {
            return false;
        }
        *count += 1;
        true
    });
    Ok(recent)
}

fn find_codex_session_summary(session_id: &str) -> Result<Option<CodexSessionSummary>> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    let root = codex_sessions_root()?;
    let indexed_path = codex_session_path_index()
        .lock()
        .ok()
        .filter(|index| index.root == root)
        .and_then(|index| index.paths_by_id.get(normalized).cloned())
        .filter(|path| path.is_file());
    if let Some(path) = indexed_path {
        if let Some(summary) = read_codex_session_summary(&path)? {
            if summary.session_id == normalized {
                return Ok(Some(summary));
            }
        }
    }

    let needs_initial_index = codex_session_path_index()
        .lock()
        .map(|index| index.root != root || !index.complete)
        .unwrap_or(true);
    let candidate_paths = if needs_initial_index {
        codex_session_paths()?
    } else {
        codex_session_paths_near(Utc::now())?
    };
    for path in candidate_paths {
        if session_id_from_rollout_filename(&path).as_deref() == Some(normalized) {
            if let Some(summary) = read_codex_session_summary(&path)? {
                if summary.session_id == normalized {
                    return Ok(Some(summary));
                }
            }
        }
    }
    Ok(None)
}

fn codex_session_jsonl_path(_workspace_path: &str, session_id: &str) -> Result<PathBuf> {
    find_codex_session_summary(session_id)?
        .map(|summary| summary.path)
        .ok_or_else(|| anyhow!("No local Codex session was found with session ID {session_id}."))
}

fn paths_share_workspace(left: &str, right: &str) -> bool {
    let left = PathBuf::from(canonicalize_path_or_original(left));
    let right = PathBuf::from(canonicalize_path_or_original(right));
    left == right || left.starts_with(&right) || right.starts_with(&left)
}

pub fn validate_importable_codex_session(
    workspace_path: String,
    codex_session_id: String,
) -> Result<PathBuf> {
    let summary = find_codex_session_summary(&codex_session_id)?
        .ok_or_else(|| anyhow!("No local Codex session was found with that session ID."))?;
    if !session_is_top_level(&summary) {
        return Err(anyhow!(
            "That Codex session is not a top-level user session."
        ));
    }
    let session_cwd = summary
        .cwd
        .as_deref()
        .ok_or_else(|| anyhow!("The Codex session does not record a working directory."))?;
    let requested_workspace = PathBuf::from(canonicalize_path_or_original(&workspace_path));
    let workspace_lookup = load_local_workspace_lookup()?;
    let owner = owning_local_workspace(&workspace_lookup, session_cwd);
    let belongs_to_requested_workspace = owner
        .map(|workspace| workspace.path == requested_workspace)
        .unwrap_or_else(|| {
            let session_path = PathBuf::from(canonicalize_path_or_original(session_cwd));
            session_path == requested_workspace || session_path.starts_with(&requested_workspace)
        });
    if !belongs_to_requested_workspace {
        return Err(anyhow!(
            "This Codex session belongs to a different workspace."
        ));
    }
    Ok(summary.path)
}

pub fn get_importable_codex_session(
    workspace_path: String,
    codex_session_id: String,
) -> Result<Option<ImportableCodexSession>> {
    validate_importable_codex_session(workspace_path, codex_session_id.clone())?;
    Ok(find_codex_session_summary(&codex_session_id)?
        .as_ref()
        .map(importable_session))
}

pub fn known_fork_child_session_ids(source_codex_session_id: &str) -> Result<Vec<String>> {
    let mut session_ids = codex_session_paths()?
        .into_iter()
        .filter_map(|path| read_codex_session_summary(&path).ok().flatten())
        .filter(|summary| {
            session_is_top_level(summary)
                && summary.forked_from_id.as_deref() == Some(source_codex_session_id.trim())
        })
        .map(|summary| summary.session_id)
        .collect::<Vec<_>>();
    session_ids.sort();
    session_ids.dedup();
    Ok(session_ids)
}

pub fn resolve_thread_fork_candidate(
    source_codex_session_id: String,
    known_child_session_ids: Vec<String>,
    requested_after: Option<String>,
) -> Result<Option<String>> {
    let requested_after = requested_after.and_then(|value| {
        DateTime::parse_from_rfc3339(value.trim())
            .ok()
            .map(|timestamp| timestamp.with_timezone(&Utc))
    });
    let excluded = known_child_session_ids.into_iter().collect::<HashSet<_>>();
    let candidate_paths = match requested_after {
        Some(requested) => codex_session_paths_near(requested)?,
        None => codex_session_paths_near(Utc::now())?,
    };
    let mut candidates = candidate_paths
        .into_iter()
        .filter_map(|path| read_codex_session_summary(&path).ok().flatten())
        .filter(|summary| {
            session_is_top_level(summary)
                && summary.forked_from_id.as_deref() == Some(source_codex_session_id.trim())
                && !excluded.contains(&summary.session_id)
                && match requested_after {
                    Some(requested) => summary
                        .created_at
                        .or(summary.modified_at)
                        .is_some_and(|created| created >= requested),
                    None => true,
                }
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.created_at
            .or(left.modified_at)
            .cmp(&right.created_at.or(right.modified_at))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(candidates
        .into_iter()
        .next()
        .map(|summary| summary.session_id))
}

fn shell_escape_arg(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn shell_escape_remote_path(value: &str) -> String {
    if value == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(relative_path) = value.strip_prefix("~/") {
        return format!("\"$HOME\"/{}", shell_escape_arg(relative_path));
    }
    shell_escape_arg(value)
}

fn build_codex_shell_command(
    cli_path: &str,
    session_id: &str,
    session_mode: TerminalSessionMode,
    full_access_flag: bool,
    effective_codex_home: Option<&Path>,
) -> String {
    let mut parts = vec![
        "env".to_string(),
        "TERM=xterm-256color".to_string(),
        "COLORTERM=truecolor".to_string(),
        "CLICOLOR=1".to_string(),
        "CLICOLOR_FORCE=1".to_string(),
        "FORCE_COLOR=1".to_string(),
    ];
    if let Some(codex_home) = effective_codex_home {
        parts.push(format!(
            "CODEX_HOME={}",
            shell_escape_arg(codex_home.to_string_lossy().as_ref())
        ));
    }
    parts.push(shell_escape_arg(cli_path));
    parts.extend(
        codex_access_args(full_access_flag)
            .iter()
            .map(|arg| (*arg).to_string()),
    );
    match session_mode {
        TerminalSessionMode::Resumed => {
            parts.push("resume".to_string());
            parts.push(shell_escape_arg(session_id));
        }
        TerminalSessionMode::New => {}
        TerminalSessionMode::Forked => {
            parts.push("fork".to_string());
            parts.push(shell_escape_arg(session_id));
        }
    }
    parts.join(" ")
}

fn build_terminal_shell_command(
    workspace_kind: WorkspaceKind,
    rdev_ssh_command: Option<&str>,
    ssh_command: Option<&str>,
    remote_path: Option<&str>,
    codex_shell_command: &str,
) -> Result<(String, Option<String>)> {
    if workspace_kind == WorkspaceKind::Local {
        return Ok((codex_shell_command.to_string(), None));
    }

    let remote_command = match workspace_kind {
        WorkspaceKind::Rdev => {
            let command = rdev_ssh_command
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Missing rdev ssh command for remote workspace"))?;
            ensure_rdev_non_tmux(command)?
        }
        WorkspaceKind::Ssh => {
            let command = ssh_command
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Missing ssh command for remote workspace"))?;
            storage::canonicalize_ssh_command(command)?
        }
        WorkspaceKind::Local => unreachable!(),
    };
    let base_exec_codex_command = format!("exec {codex_shell_command}");

    if let Some(prefix) = remote_command.strip_suffix(storage::CODEX_COMMAND_PLACEHOLDER) {
        return Ok((format!("{prefix}{base_exec_codex_command}"), None));
    }

    let exec_codex_command = if workspace_kind == WorkspaceKind::Ssh {
        if let Some(path) = remote_path.map(str::trim).filter(|value| !value.is_empty()) {
            let path = storage::validate_remote_path(path)?;
            format!(
                "cd {} && exec {}",
                shell_escape_remote_path(&path),
                codex_shell_command
            )
        } else {
            base_exec_codex_command
        }
    } else {
        base_exec_codex_command
    };

    Ok((remote_command, Some(exec_codex_command)))
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
            Ok((
                Some(remote_connection_only(&ensure_rdev_non_tmux(
                    remote_command,
                )?)),
                None,
            ))
        }
        WorkspaceKind::Ssh => {
            let remote_command = ssh_command
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Missing ssh command for remote workspace"))?;
            let remote_command =
                remote_connection_only(&storage::canonicalize_ssh_command(remote_command)?);
            let post_connect_command =
                if let Some(value) = remote_path.map(str::trim).filter(|value| !value.is_empty()) {
                    let value = storage::validate_remote_path(value)?;
                    Some(format!(
                        "cd {} && exec {}",
                        shell_escape_remote_path(&value),
                        shell_escape_arg(shell_path)
                    ))
                } else {
                    None
                };
            Ok((Some(remote_command), post_connect_command))
        }
    }
}

fn resolve_codex_command_for_workspace(
    workspace_kind: WorkspaceKind,
    settings: &Settings,
) -> Result<String> {
    if workspace_kind == WorkspaceKind::Rdev || workspace_kind == WorkspaceKind::Ssh {
        return Ok("codex".to_string());
    }

    detect_codex_cli_path(settings)
        .ok_or_else(|| anyhow!("Codex CLI not found. Configure the CLI path in Settings."))
}

fn ensure_rdev_non_tmux(remote_command: &str) -> Result<String> {
    storage::canonicalize_rdev_ssh_command(remote_command, true)
}

fn remote_connection_only(remote_command: &str) -> String {
    remote_command
        .strip_suffix(storage::CODEX_COMMAND_PLACEHOLDER)
        .unwrap_or(remote_command)
        .trim_end()
        .to_string()
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
            || lower.contains("codex code")
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

    for marker in [" exec ", " env ", " codex ", "codex "] {
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
            for ctrl in chars.by_ref() {
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
            for ctrl in chars.by_ref() {
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

fn extract_codex_resume_session_id(text: &str) -> Option<String> {
    for marker in ["codex resume ", "resume "] {
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
    // commands such as `ssh host {CODEX_CMD}` still inspect startup auth prompts.
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexTurnCompletion {
    status: &'static str,
    has_meaningful_output: bool,
    completed_at_ms: i64,
}

fn classify_codex_turn_completion_entry(entry: &CodexJsonlEntry) -> Option<CodexTurnCompletion> {
    if entry.entry_type.as_deref() != Some("event_msg") {
        return None;
    }
    let payload = entry.payload.as_ref()?;
    let event_type = payload.get("type")?.as_str()?;
    let completed_at_ms = parse_value_timestamp(payload, "completed_at")
        .or(entry.timestamp)
        .map(|timestamp| timestamp.timestamp_millis())
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    match event_type {
        "task_complete" => Some(CodexTurnCompletion {
            status: "Succeeded",
            has_meaningful_output: value_string(payload, "last_agent_message")
                .is_some_and(|message| !message.trim().is_empty()),
            completed_at_ms,
        }),
        "turn_aborted" => Some(CodexTurnCompletion {
            status: "Failed",
            has_meaningful_output: false,
            completed_at_ms,
        }),
        _ => None,
    }
}

fn latest_codex_session_cwd_from_jsonl(session_path: &Path) -> Option<String> {
    let file_len = fs::metadata(session_path).ok()?.len();
    let lines = read_jsonl_window(
        session_path,
        file_len.saturating_sub(JSONL_LIVE_TAIL_BYTES),
        JSONL_LIVE_TAIL_BYTES,
    )
    .ok()?;
    for (_, line) in lines.into_iter().rev() {
        let Ok(entry) = serde_json::from_str::<CodexJsonlEntry>(&line) else {
            continue;
        };
        if !matches!(
            entry.entry_type.as_deref(),
            Some("session_meta" | "turn_context")
        ) {
            continue;
        }
        let Some(payload) = entry.payload.as_ref() else {
            continue;
        };
        if let Some(cwd) = trim_to_option(value_string(payload, "cwd")) {
            return Some(canonicalize_path_or_original(&cwd));
        }
    }
    read_codex_session_summary(session_path)
        .ok()
        .flatten()
        .and_then(|summary| summary.cwd)
        .map(|cwd| canonicalize_path_or_original(&cwd))
}

fn cached_latest_codex_session_cwd_from_jsonl(session_path: &Path) -> Option<String> {
    cached_jsonl_metadata_value(
        latest_cwd_cache(),
        session_path.to_path_buf(),
        session_path,
        latest_codex_session_cwd_from_jsonl,
    )
}

fn latest_codex_turn_completion_from_jsonl(
    session_path: &Path,
    codex_session_id: &str,
) -> Option<CodexTurnCompletionSummary> {
    let file_len = fs::metadata(session_path).ok()?.len();
    let lines = read_jsonl_window(
        session_path,
        file_len.saturating_sub(JSONL_LIVE_TAIL_BYTES),
        JSONL_LIVE_TAIL_BYTES,
    )
    .ok()?;
    let mut latest_completion = None;
    for (line_end_offset, line) in lines {
        let Ok(entry) = serde_json::from_str::<CodexJsonlEntry>(&line) else {
            continue;
        };
        let Some(completion) = classify_codex_turn_completion_entry(&entry) else {
            continue;
        };
        latest_completion = Some(CodexTurnCompletionSummary {
            codex_session_id: codex_session_id.to_string(),
            completion_index: line_end_offset.max(1),
            completed_at_ms: completion.completed_at_ms,
            status: completion.status.to_string(),
            has_meaningful_output: completion.has_meaningful_output,
        });
    }
    latest_completion
}

fn cached_latest_codex_turn_completion(
    session_path: &Path,
    codex_session_id: &str,
) -> Option<CodexTurnCompletionSummary> {
    cached_jsonl_metadata_value(
        latest_completion_cache(),
        (session_path.to_path_buf(), codex_session_id.to_string()),
        session_path,
        |path| latest_codex_turn_completion_from_jsonl(path, codex_session_id),
    )
}

#[derive(Default)]
struct CodexJsonlWatchCursor {
    offset: u64,
    file_id: Option<u64>,
    partial_line: Vec<u8>,
    skipping_oversized_line: bool,
}

impl CodexJsonlWatchCursor {
    fn at_end(path: &Path) -> Self {
        match fs::metadata(path) {
            Ok(metadata) => Self {
                offset: metadata.len(),
                file_id: Some(metadata.ino()),
                partial_line: Vec::new(),
                skipping_oversized_line: false,
            },
            Err(_) => Self::default(),
        }
    }
}

#[derive(Default)]
struct CodexJsonlWatchDelta {
    latest_cwd: Option<String>,
    completions: Vec<CodexTurnCompletionSummary>,
    recovered: bool,
    bytes_read: usize,
}

fn process_codex_jsonl_watch_line(
    line: &[u8],
    line_end_offset: u64,
    codex_session_id: &str,
    delta: &mut CodexJsonlWatchDelta,
) {
    let Ok(entry) = serde_json::from_slice::<CodexJsonlEntry>(line) else {
        return;
    };
    if matches!(
        entry.entry_type.as_deref(),
        Some("session_meta" | "turn_context")
    ) {
        if let Some(cwd) = entry
            .payload
            .as_ref()
            .and_then(|payload| trim_to_option(value_string(payload, "cwd")))
        {
            delta.latest_cwd = Some(canonicalize_path_or_original(&cwd));
        }
    }
    if let Some(completion) = classify_codex_turn_completion_entry(&entry) {
        delta.completions.push(CodexTurnCompletionSummary {
            codex_session_id: codex_session_id.to_string(),
            completion_index: line_end_offset.max(1),
            completed_at_ms: completion.completed_at_ms,
            status: completion.status.to_string(),
            has_meaningful_output: completion.has_meaningful_output,
        });
    }
}

fn read_incremental_codex_jsonl(
    path: &Path,
    codex_session_id: &str,
    cursor: &mut CodexJsonlWatchCursor,
) -> Result<CodexJsonlWatchDelta> {
    let metadata = fs::metadata(path)?;
    let current_file_id = metadata.ino();
    let mut delta = CodexJsonlWatchDelta::default();
    if cursor
        .file_id
        .is_some_and(|file_id| file_id != current_file_id)
        || metadata.len() < cursor.offset
    {
        cursor.offset = metadata.len().saturating_sub(JSONL_LIVE_TAIL_BYTES);
        cursor.partial_line.clear();
        cursor.skipping_oversized_line = cursor.offset > 0;
        delta.recovered = true;
    }
    cursor.file_id = Some(current_file_id);
    if cursor.offset >= metadata.len() {
        return Ok(delta);
    }

    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut buffer = [0_u8; JSONL_INCREMENTAL_CHUNK_BYTES];
    while delta.bytes_read < JSONL_INCREMENTAL_MAX_BYTES_PER_POLL {
        let remaining = JSONL_INCREMENTAL_MAX_BYTES_PER_POLL - delta.bytes_read;
        let read_capacity = remaining.min(buffer.len());
        let read = file.read(&mut buffer[..read_capacity])?;
        if read == 0 {
            break;
        }
        let chunk_start = cursor.offset;
        for (index, byte) in buffer[..read].iter().copied().enumerate() {
            if byte == b'\n' {
                let line_end_offset = chunk_start + index as u64 + 1;
                if !cursor.skipping_oversized_line && !cursor.partial_line.is_empty() {
                    process_codex_jsonl_watch_line(
                        &cursor.partial_line,
                        line_end_offset,
                        codex_session_id,
                        &mut delta,
                    );
                }
                cursor.partial_line.clear();
                cursor.skipping_oversized_line = false;
            } else if !cursor.skipping_oversized_line {
                if cursor.partial_line.len() < JSONL_INCREMENTAL_MAX_LINE_BYTES {
                    cursor.partial_line.push(byte);
                } else {
                    cursor.partial_line.clear();
                    cursor.skipping_oversized_line = true;
                }
            }
        }
        cursor.offset = cursor.offset.saturating_add(read as u64);
        delta.bytes_read += read;
    }
    Ok(delta)
}

fn discover_unclaimed_codex_session(
    owner_id: &str,
    sessions_root: &Path,
    started_at: DateTime<Utc>,
    current_cwd: &str,
    baseline_rollout_paths: &HashSet<PathBuf>,
    expected_fork_parent_id: Option<&str>,
) -> Option<CodexSessionSummary> {
    let earliest = started_at - ChronoDuration::seconds(5);
    let mut candidates = codex_session_paths_near_root(sessions_root, started_at)
        .ok()?
        .into_iter()
        .filter(|path| !baseline_rollout_paths.contains(path))
        .filter_map(|path| read_codex_session_summary(&path).ok().flatten())
        .filter(|summary| {
            session_is_top_level(summary)
                && summary
                    .created_at
                    .or(summary.modified_at)
                    .is_some_and(|created| created >= earliest)
                && summary
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| paths_share_workspace(cwd, current_cwd))
                && match expected_fork_parent_id {
                    Some(parent) => summary.forked_from_id.as_deref() == Some(parent),
                    None => summary.forked_from_id.is_none(),
                }
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.created_at
            .or(left.modified_at)
            .cmp(&right.created_at.or(right.modified_at))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    let mut claims = claimed_codex_session_ids().lock().ok()?;
    candidates
        .into_iter()
        .find(|summary| match claims.get(&summary.session_id) {
            Some(owner) => owner == owner_id,
            None => {
                claims.insert(summary.session_id.clone(), owner_id.to_string());
                true
            }
        })
}

fn discover_terminal_codex_session(session: &TerminalSession) -> Option<CodexSessionSummary> {
    let current_cwd = session
        .current_cwd
        .lock()
        .ok()
        .map(|value| value.clone())
        .unwrap_or_else(|| session.workspace_path.clone());
    discover_unclaimed_codex_session(
        &session.session_id,
        session.codex_sessions_root.as_deref()?,
        session.started_at,
        &current_cwd,
        &session.baseline_rollout_paths,
        session.expected_fork_parent_id.as_deref(),
    )
}

fn bind_discovered_codex_session(
    app: &AppHandle,
    session: &TerminalSession,
    thread_id: &str,
    summary: &CodexSessionSummary,
) {
    if let Ok(mut observed) = session.observed_codex_session_id.lock() {
        *observed = summary.session_id.clone();
    }
    if let Some(cwd) = summary.cwd.as_ref() {
        if let Ok(mut current_cwd) = session.current_cwd.lock() {
            *current_cwd = cwd.clone();
        }
    }
    if session.session_mode == Some(TerminalSessionMode::New) {
        if let Ok(Some(thread)) = storage::set_thread_codex_session_id_if_missing(
            &session.workspace_id,
            thread_id,
            &summary.session_id,
        ) {
            session
                .codex_session_id_confirmed
                .store(true, Ordering::Release);
            let _ = app.emit(THREAD_UPDATED_EVENT, thread);
        }
    }
}

fn spawn_codex_turn_completion_watcher(
    app: AppHandle,
    session: Arc<TerminalSession>,
    thread_id: String,
    initial_codex_session_id: String,
) {
    std::thread::spawn(move || {
        let mut observed_session_id = initial_codex_session_id.trim().to_string();
        let mut session_path = if observed_session_id.is_empty() {
            None
        } else {
            codex_session_jsonl_path(&session.workspace_path, &observed_session_id).ok()
        };
        let mut last_completion_index = session_path
            .as_ref()
            .and_then(|path| {
                cached_latest_codex_turn_completion(path, &observed_session_id)
                    .map(|summary| summary.completion_index)
            })
            .unwrap_or(0);
        let mut watch_cursor = session_path
            .as_deref()
            .map(CodexJsonlWatchCursor::at_end)
            .unwrap_or_default();
        let mut emitted_completion_count = 0_u64;

        while !session.killed.load(Ordering::Acquire) {
            let rebound_session_id = session
                .observed_codex_session_id
                .lock()
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            if rebound_session_id.as_deref() != Some(observed_session_id.as_str()) {
                if let Some(rebound_session_id) = rebound_session_id {
                    observed_session_id = rebound_session_id;
                    session_path =
                        codex_session_jsonl_path(&session.workspace_path, &observed_session_id)
                            .ok();
                    last_completion_index = session_path
                        .as_ref()
                        .and_then(|path| {
                            cached_latest_codex_turn_completion(path, &observed_session_id)
                                .map(|summary| summary.completion_index)
                        })
                        .unwrap_or(0);
                    watch_cursor = session_path
                        .as_deref()
                        .map(CodexJsonlWatchCursor::at_end)
                        .unwrap_or_default();
                }
            }

            if session_path.is_none() {
                if let Some(summary) = discover_terminal_codex_session(&session) {
                    observed_session_id = summary.session_id.clone();
                    session_path = Some(summary.path.clone());
                    bind_discovered_codex_session(&app, &session, &thread_id, &summary);
                    last_completion_index = 0;
                    watch_cursor = CodexJsonlWatchCursor::default();
                }
            }

            let Some(path) = session_path.as_ref() else {
                std::thread::sleep(CODEX_TURN_COMPLETION_POLL_INTERVAL);
                continue;
            };

            let Ok(delta) =
                read_incremental_codex_jsonl(path, &observed_session_id, &mut watch_cursor)
            else {
                std::thread::sleep(CODEX_TURN_COMPLETION_POLL_INTERVAL);
                continue;
            };
            if let Some(cwd) = delta.latest_cwd {
                if let Ok(mut current_cwd) = session.current_cwd.lock() {
                    *current_cwd = cwd;
                }
            }
            if delta.recovered {
                last_completion_index = delta
                    .completions
                    .last()
                    .map(|completion| completion.completion_index)
                    .unwrap_or(0);
            } else {
                let submitted_prompt_count = session.submitted_prompt_count.load(Ordering::Acquire);
                for completion in delta.completions {
                    if completion.completion_index <= last_completion_index {
                        continue;
                    }
                    last_completion_index = completion.completion_index;
                    if emitted_completion_count >= submitted_prompt_count {
                        continue;
                    }
                    emitted_completion_count = emitted_completion_count.saturating_add(1);
                    let current_cwd = session
                        .current_cwd
                        .lock()
                        .ok()
                        .map(|value| value.clone())
                        .filter(|value| !value.trim().is_empty());
                    let _ = app.emit(
                        TERMINAL_TURN_COMPLETED_EVENT,
                        TerminalTurnCompletedEvent {
                            session_id: session.session_id.clone(),
                            thread_id: Some(thread_id.clone()),
                            status: completion.status,
                            has_meaningful_output: completion.has_meaningful_output,
                            completed_at_ms: completion.completed_at_ms,
                            completion_index: Some(completion.completion_index),
                            current_cwd,
                        },
                    );
                }
            }

            std::thread::sleep(CODEX_TURN_COMPLETION_POLL_INTERVAL);
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
    CodexThread,
    WorkspaceShell,
}

struct TerminalSession {
    session_id: TerminalSessionId,
    workspace_id: String,
    workspace_path: String,
    current_cwd: Mutex<String>,
    observed_codex_session_id: Mutex<String>,
    kind: TerminalSessionKind,
    thread_id: Option<String>,
    session_mode: Option<TerminalSessionMode>,
    resume_session_id: Option<String>,
    expected_fork_parent_id: Option<String>,
    baseline_rollout_paths: HashSet<PathBuf>,
    codex_sessions_root: Option<PathBuf>,
    submitted_input_buffer: Mutex<String>,
    process_id: Option<u32>,
    started_at: chrono::DateTime<Utc>,
    command: Vec<String>,
    output_log_path: PathBuf,
    output_state: Arc<TerminalOutputState>,
    persistence_error: Arc<Mutex<Option<String>>>,
    submitted_prompt_count: AtomicU64,
    codex_session_id_confirmed: AtomicBool,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    killed: Arc<AtomicBool>,
    termination_requested: AtomicBool,
}

fn terminate_terminal_session_process(session: &TerminalSession) {
    session.termination_requested.store(true, Ordering::Release);
    session.killed.store(true, Ordering::Release);
    let process_group_id = session
        .master
        .lock()
        .ok()
        .and_then(|master| master.process_group_leader())
        .filter(|process_group_id| *process_group_id > 1);
    let signal_target = process_group_id
        .map(|process_group_id| -process_group_id)
        .or_else(|| session.process_id.map(|pid| pid as i32));
    let Some(signal_target) = signal_target else {
        if let Ok(mut child) = session.child.try_lock() {
            let _ = child.kill();
        }
        return;
    };
    let result = unsafe { libc::kill(signal_target, libc::SIGTERM) };
    if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return;
    }

    let started = Instant::now();
    while started.elapsed() < GRACEFUL_TERMINATION_TIMEOUT {
        let exists = unsafe { libc::kill(signal_target, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !exists {
            return;
        }
        std::thread::sleep(COMMAND_TIMEOUT_POLL_INTERVAL);
    }
    let kill_result = unsafe { libc::kill(signal_target, libc::SIGKILL) };
    if kill_result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        return;
    }
    if let Some(pid) = session.process_id {
        let _ = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }
    if let Ok(mut child) = session.child.try_lock() {
        let _ = child.kill();
    }
}

#[derive(Default)]
struct TerminalSessionBlocks {
    workspace_ids: HashSet<String>,
    thread_ids: HashSet<(String, String)>,
}

#[derive(Default)]
pub struct TerminalSessionManager {
    sessions: Mutex<HashMap<TerminalSessionId, Arc<TerminalSession>>>,
    blocked: Mutex<TerminalSessionBlocks>,
}

impl TerminalSessionManager {
    fn insert(&self, session: Arc<TerminalSession>) -> Result<()> {
        let blocked = self
            .blocked
            .lock()
            .map_err(|_| anyhow!("Terminal session lifecycle lock poisoned"))?;
        let thread_is_blocked = session.thread_id.as_ref().is_some_and(|thread_id| {
            blocked
                .thread_ids
                .contains(&(session.workspace_id.clone(), thread_id.clone()))
        });
        if blocked.workspace_ids.contains(&session.workspace_id) || thread_is_blocked {
            return Err(anyhow!(
                "Terminal session target was deleted while the session was starting"
            ));
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        sessions.insert(session.session_id.clone(), session);
        drop(sessions);
        drop(blocked);
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

    pub fn shutdown_for_thread_id(&self, workspace_id: &str, thread_id: &str) -> Result<()> {
        let sessions = self.remove_for_thread(workspace_id, thread_id)?;
        for session in sessions {
            terminate_terminal_session_process(&session);
        }
        Ok(())
    }

    pub fn shutdown_and_block_thread_id(&self, workspace_id: &str, thread_id: &str) -> Result<()> {
        let mut blocked = self
            .blocked
            .lock()
            .map_err(|_| anyhow!("Terminal session lifecycle lock poisoned"))?;
        blocked
            .thread_ids
            .insert((workspace_id.to_string(), thread_id.to_string()));
        let sessions = self.remove_for_thread(workspace_id, thread_id)?;
        drop(blocked);
        for session in sessions {
            terminate_terminal_session_process(&session);
        }
        Ok(())
    }

    pub fn shutdown_and_block_workspace_id(&self, workspace_id: &str) -> Result<()> {
        let mut blocked = self
            .blocked
            .lock()
            .map_err(|_| anyhow!("Terminal session lifecycle lock poisoned"))?;
        blocked.workspace_ids.insert(workspace_id.to_string());
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
        drop(blocked);

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
    pub terminal_sessions: TerminalSessionManager,
}

fn expand_home_path(path: &str) -> PathBuf {
    if let Some(relative) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(relative);
        }
    }
    PathBuf::from(path)
}

fn validate_codex_cli_path(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return false;
    }

    let shell = resolve_login_shell();
    let mut command = StdCommand::new(shell);
    command
        .args(["-lic", "exec \"$1\" --version", "atcontroller-codex-check"])
        .arg(path);
    let Ok(output) =
        run_std_command_with_timeout(command, CLI_VALIDATION_TIMEOUT, "Codex CLI validation")
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let version_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    version_output.contains("codex")
}

pub fn detect_codex_cli_path(settings: &Settings) -> Option<String> {
    if let Some(path) = &settings.codex_cli_path {
        let path = expand_home_path(path);
        return validate_codex_cli_path(&path).then(|| path.to_string_lossy().to_string());
    }

    let mut candidates = Vec::<PathBuf>::new();
    if let Ok(output) = login_shell_probe(
        "printf '\\036ATCONTROLLER_CODEX_CLI=%s\\036' \"$(command -v codex 2>/dev/null || true)\"",
        "Codex CLI lookup",
    ) {
        if let Some(path) = parse_marked_shell_value(&output, "ATCONTROLLER_CODEX_CLI") {
            candidates.push(PathBuf::from(path));
        }
    }
    candidates.extend([
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
    ]);
    if let Some(home) = dirs::home_dir().map(|dir| dir.to_string_lossy().to_string()) {
        candidates.push(PathBuf::from(format!("{home}/.volta/bin/codex")));
        candidates.push(PathBuf::from(format!("{home}/.npm-global/bin/codex")));
        candidates.push(PathBuf::from(format!("{home}/.local/bin/codex")));
    }

    let mut seen = HashSet::new();
    for path in candidates {
        if seen.insert(path.clone()) && validate_codex_cli_path(&path) {
            return Some(path.to_string_lossy().to_string());
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

fn record_terminal_persistence_error(target: &Mutex<Option<String>>, message: String) {
    if let Ok(mut error) = target.lock() {
        if error.is_none() {
            *error = Some(message);
        }
    }
}

fn terminal_persistence_error(target: &Mutex<Option<String>>) -> Option<String> {
    target
        .lock()
        .map(|error| error.clone())
        .unwrap_or_else(|_| Some("Terminal persistence state lock poisoned".to_string()))
}

fn append_persistence_error(target: &mut Option<String>, message: String) {
    match target {
        Some(existing) => {
            existing.push_str("; ");
            existing.push_str(&message);
        }
        None => *target = Some(message),
    }
}

fn terminal_reader_reached_end(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::BrokenPipe
    ) {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::EIO) {
        return true;
    }
    false
}

fn append_terminal_output(
    output_state: &TerminalOutputState,
    persistence_error: &Mutex<Option<String>>,
    chunk: &str,
) -> (u64, u64) {
    match output_state.append(chunk) {
        Ok(positions) => positions,
        Err(error) => {
            record_terminal_persistence_error(
                persistence_error,
                format!("Unable to track terminal output position: {error}"),
            );
            (0, 0)
        }
    }
}

fn output_log_truncation_marker_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default();
    path.with_file_name(format!("{file_name}.truncated"))
}

struct BoundedOutputLog {
    path: PathBuf,
    file: File,
    len: u64,
}

impl BoundedOutputLog {
    fn open(path: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)?;
        let len = file.metadata()?.len();
        let mut log = Self {
            path: path.to_path_buf(),
            file,
            len,
        };
        if len > TERMINAL_OUTPUT_LOG_MAX_BYTES {
            log.compact_with_append(&[])?;
        }
        Ok(log)
    }

    fn compact_with_append(&mut self, appended: &[u8]) -> std::io::Result<()> {
        self.file.flush()?;

        let appended_tail_len = appended
            .len()
            .min(TERMINAL_OUTPUT_LOG_COMPACT_BYTES as usize);
        let appended_tail = &appended[appended.len().saturating_sub(appended_tail_len)..];
        let retained_existing_len = TERMINAL_OUTPUT_LOG_COMPACT_BYTES
            .saturating_sub(appended_tail_len as u64)
            .min(self.len);
        let retained_start = self.len.saturating_sub(retained_existing_len);

        let marker_path = output_log_truncation_marker_path(&self.path);
        let marker = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(marker_path)?;
        marker.sync_all()?;

        let file_name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default();
        let temp_path = self
            .path
            .with_file_name(format!(".{file_name}.compact-{}", Uuid::new_v4()));
        let result = (|| -> std::io::Result<File> {
            let mut source = File::open(&self.path)?;
            source.seek(SeekFrom::Start(retained_start))?;

            let mut temp = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp_path)?;
            std::io::copy(&mut source.take(retained_existing_len), &mut temp)?;
            temp.write_all(appended_tail)?;
            temp.sync_all()?;
            fs::rename(&temp_path, &self.path)?;
            if let Some(parent) = self.path.parent() {
                if let Ok(directory) = File::open(parent) {
                    let _ = directory.sync_all();
                }
            }
            Ok(temp)
        })();
        let replacement = match result {
            Ok(replacement) => replacement,
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                return Err(error);
            }
        };

        self.file = replacement;
        self.len = retained_existing_len.saturating_add(appended_tail_len as u64);
        Ok(())
    }

    fn write_bounded(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        if self.len.saturating_add(bytes.len() as u64) > TERMINAL_OUTPUT_LOG_MAX_BYTES {
            return self.compact_with_append(bytes);
        }
        self.file.write_all(bytes)?;
        self.len = self.len.saturating_add(bytes.len() as u64);
        Ok(())
    }

    fn sync_data(&self) -> std::io::Result<()> {
        self.file.sync_data()
    }
}

#[derive(Debug)]
struct RuntimeHistoryDirectory {
    path: PathBuf,
    name: String,
    modified: SystemTime,
    active: bool,
}

fn runtime_history_directory_is_active(path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(path.join(RUNTIME_HISTORY_ACTIVE_MARKER)) else {
        return false;
    };
    let Ok(marker) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let Some(pid) = marker
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
    else {
        return false;
    };
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn mark_runtime_history_directory_active(path: &Path) -> Result<()> {
    storage::write_json_file(
        &path.join(RUNTIME_HISTORY_ACTIVE_MARKER),
        &serde_json::json!({
            "pid": std::process::id(),
            "startedAt": Utc::now(),
        }),
    )
}

fn clear_runtime_history_directory_active(path: &Path) {
    let _ = fs::remove_file(path.join(RUNTIME_HISTORY_ACTIVE_MARKER));
}

fn runtime_history_directories_to_prune(
    mut directories: Vec<RuntimeHistoryDirectory>,
    current_name: Option<&str>,
) -> Vec<PathBuf> {
    directories.sort_by(|left, right| {
        right
            .modified
            .cmp(&left.modified)
            .then_with(|| right.name.cmp(&left.name))
    });
    directories
        .into_iter()
        .enumerate()
        .filter(|(index, directory)| {
            *index >= RUNTIME_HISTORY_MAX_DIRECTORIES
                && !directory.active
                && current_name != Some(directory.name.as_str())
        })
        .map(|(_, directory)| directory.path)
        .collect()
}

fn prune_runtime_history(root: &Path, current_name: Option<&str>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    let mut directories = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if Uuid::parse_str(&name).is_err() {
            continue;
        }
        let path = entry.path();
        let metadata = entry.metadata()?;
        directories.push(RuntimeHistoryDirectory {
            name,
            active: runtime_history_directory_is_active(&path),
            path,
            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        });
    }
    for path in runtime_history_directories_to_prune(directories, current_name) {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

fn prune_thread_run_history(workspace_id: &str, thread_id: &str) -> Result<()> {
    let root = storage::runs_dir(workspace_id, thread_id)?;
    let current_name = storage::latest_thread_run_dir(workspace_id, thread_id)?.and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
    });
    prune_runtime_history(&root, current_name.as_deref())
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
    let text = String::from_utf8_lossy(&bytes).to_string();
    let was_compacted = output_log_truncation_marker_path(path).is_file();

    if start_offset > 0 {
        return Ok((text, true));
    }

    Ok((text, was_compacted))
}

fn snapshot_from_log_path(path: &Path, end_position: u64) -> Result<TerminalOutputSnapshot> {
    let (text, truncated) = read_log_snapshot(path)?;
    let text_len = terminal_position_len(&text);
    let effective_end_position = end_position.max(text_len);
    let start_position = effective_end_position.saturating_sub(text_len);
    Ok(TerminalOutputSnapshot {
        text,
        start_position,
        end_position: effective_end_position,
        truncated: truncated || start_position > 0,
    })
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
        truncated: truncated || start_position > 0,
    })
}

pub fn latest_codex_session_cwd(
    workspace_path: String,
    codex_session_id: String,
) -> Result<Option<String>> {
    let normalized_session_id = codex_session_id.trim();
    if normalized_session_id.is_empty() {
        return Ok(None);
    }

    let session_path = codex_session_jsonl_path(&workspace_path, normalized_session_id)?;
    let latest_cwd = cached_latest_codex_session_cwd_from_jsonl(&session_path);
    Ok(match latest_cwd {
        Some(cwd) if Path::new(&cwd).is_dir() => Some(cwd),
        Some(_) => Some(canonicalize_path_or_original(&workspace_path)),
        None => None,
    })
}

fn resolve_terminal_launch_cwd(
    workspace_kind: WorkspaceKind,
    workspace_path: &str,
    initial_cwd: Option<String>,
    session_mode: TerminalSessionMode,
    launch_session_id: &str,
) -> String {
    if workspace_kind != WorkspaceKind::Local {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .to_string_lossy()
            .to_string();
    }

    if session_mode == TerminalSessionMode::Forked {
        if let Ok(Some(source_cwd)) =
            latest_codex_session_cwd(workspace_path.to_string(), launch_session_id.to_string())
        {
            return source_cwd;
        }
    }

    initial_cwd
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| workspace_path.to_string())
}

pub fn latest_codex_turn_completion(
    workspace_path: String,
    codex_session_id: String,
) -> Result<Option<CodexTurnCompletionSummary>> {
    let normalized_session_id = codex_session_id.trim();
    if normalized_session_id.is_empty() {
        return Ok(None);
    }

    let session_path = codex_session_jsonl_path(&workspace_path, normalized_session_id)?;
    Ok(cached_latest_codex_turn_completion(
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

    let end_position = session.output_state.end_position()?;
    if session.output_log_path.is_file() {
        if let Ok(snapshot) = snapshot_from_log_path(&session.output_log_path, end_position) {
            if !snapshot.text.is_empty() || snapshot.truncated {
                return Ok(snapshot);
            }
        }
    }

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

    let source_codex_session_id = thread
        .codex_session_id
        .as_deref()
        .filter(|session_id| is_uuid_like(session_id))
        .map(ToString::to_string)
        .or_else(|| {
            session
                .resume_session_id
                .clone()
                .filter(|session_id| is_uuid_like(session_id))
        })
        .ok_or_else(|| anyhow!("Unable to resolve the source Codex session id for this thread"))?;
    let known_child_session_ids = known_fork_child_session_ids(&source_codex_session_id)?;
    let requested_at = Utc::now();

    Ok(PreparedNativeFork {
        source_codex_session_id,
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
    state
        .terminal_sessions
        .shutdown_for_thread_id(&workspace_id, &thread_id)?;
    prune_thread_run_history(&workspace_id, &thread_id)?;

    let mut thread = storage::read_thread_metadata(&workspace_id, &thread_id)?;
    let started_at = Utc::now();
    if thread.full_access != full_access_flag {
        thread.full_access = full_access_flag;
    }
    if thread
        .codex_session_id
        .as_deref()
        .is_some_and(|session_id| !is_uuid_like(session_id))
    {
        thread.codex_session_id = None;
    }
    if thread
        .pending_fork_source_codex_session_id
        .as_deref()
        .is_some_and(|session_id| !is_uuid_like(session_id))
    {
        thread.pending_fork_source_codex_session_id = None;
        thread.pending_fork_known_child_session_ids.clear();
        thread.pending_fork_requested_at = None;
        thread.pending_fork_launch_consumed = false;
    }
    if thread.pending_fork_launch_consumed
        && thread
            .pending_fork_source_codex_session_id
            .as_deref()
            .is_some_and(is_uuid_like)
        && match thread.codex_session_id.as_deref().map(str::trim) {
            Some(session_id) => {
                thread.pending_fork_source_codex_session_id.as_deref() == Some(session_id)
            }
            None => true,
        }
    {
        return Err(anyhow!(
            "Thread is waiting for fork resolution before it can be resumed"
        ));
    }
    let pending_fork_source_session_id = thread
        .pending_fork_source_codex_session_id
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

    let (launch_session_id, session_mode) =
        if let Some(source_codex_session_id) = pending_fork_source_session_id {
            thread.last_new_session_at = Some(started_at);
            thread.codex_session_id = None;
            (source_codex_session_id, TerminalSessionMode::Forked)
        } else if let Some(existing_session_id) = thread
            .codex_session_id
            .clone()
            .filter(|session_id| is_uuid_like(session_id))
        {
            thread.last_resume_at = Some(started_at);
            (existing_session_id, TerminalSessionMode::Resumed)
        } else {
            thread.last_new_session_at = Some(started_at);
            thread.codex_session_id = None;
            (String::new(), TerminalSessionMode::New)
        };
    let resume_session_id = if session_mode == TerminalSessionMode::Resumed {
        Some(launch_session_id.clone())
    } else {
        None
    };
    thread.updated_at = started_at;
    storage::write_thread_metadata(&thread)?;

    let settings = storage::load_settings()?;
    let codex_command = resolve_codex_command_for_workspace(workspace.kind, &settings)?;
    let effective_codex_home = if workspace.kind == WorkspaceKind::Local {
        Some(codex_home()?)
    } else {
        None
    };
    let local_codex_sessions_root = effective_codex_home
        .as_ref()
        .map(|path| path.join("sessions"));
    let baseline_rollout_paths = if workspace.kind == WorkspaceKind::Local
        && matches!(
            session_mode,
            TerminalSessionMode::New | TerminalSessionMode::Forked
        ) {
        codex_session_paths_near_root(
            local_codex_sessions_root
                .as_deref()
                .expect("local Codex sessions root should be resolved"),
            started_at,
        )
        .unwrap_or_default()
        .into_iter()
        .collect()
    } else {
        HashSet::new()
    };

    let cwd = resolve_terminal_launch_cwd(
        workspace.kind,
        &workspace_path,
        initial_cwd,
        session_mode,
        &launch_session_id,
    );
    let session_id = Uuid::new_v4().to_string();
    let run_dir = storage::runs_dir(&workspace_id, &thread_id)?.join(&session_id);
    fs::create_dir_all(&run_dir)?;

    let shell_path = resolve_login_shell();
    let codex_shell_command = build_codex_shell_command(
        &codex_command,
        &launch_session_id,
        session_mode,
        full_access_flag,
        effective_codex_home.as_deref(),
    );
    let (shell_command, post_connect_command) = build_terminal_shell_command(
        workspace.kind,
        workspace.rdev_ssh_command.as_deref(),
        workspace.ssh_command.as_deref(),
        workspace.remote_path.as_deref(),
        &codex_shell_command,
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
            "runtime": "codex",
            "sessionMode": session_mode.as_str(),
            "resumeSessionId": resume_session_id.clone(),
            "codexSessionId": thread.codex_session_id.clone(),
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
    let output_log = Arc::new(Mutex::new(BoundedOutputLog::open(&output_log_path)?));
    let output_state = Arc::new(TerminalOutputState::new());
    let persistence_error = Arc::new(Mutex::new(None));

    let session_killed = Arc::new(AtomicBool::new(false));
    let session = Arc::new(TerminalSession {
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        workspace_path: workspace_path.clone(),
        current_cwd: Mutex::new(cwd.clone()),
        observed_codex_session_id: Mutex::new(if session_mode == TerminalSessionMode::Resumed {
            launch_session_id.clone()
        } else {
            String::new()
        }),
        kind: TerminalSessionKind::CodexThread,
        thread_id: Some(thread_id.clone()),
        session_mode: Some(session_mode),
        resume_session_id: resume_session_id.clone(),
        expected_fork_parent_id: (session_mode == TerminalSessionMode::Forked)
            .then(|| launch_session_id.clone()),
        baseline_rollout_paths,
        codex_sessions_root: local_codex_sessions_root,
        submitted_input_buffer: Mutex::new(String::new()),
        process_id,
        started_at,
        command: command_manifest.clone(),
        output_log_path,
        output_state: output_state.clone(),
        persistence_error: persistence_error.clone(),
        submitted_prompt_count: AtomicU64::new(0),
        codex_session_id_confirmed: AtomicBool::new(session_mode == TerminalSessionMode::Resumed),
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
        killed: session_killed.clone(),
        termination_requested: AtomicBool::new(false),
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
    if let Err(error) = mark_runtime_history_directory_active(&run_dir) {
        let _ = state.terminal_sessions.remove(&session_id);
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
        spawn_codex_turn_completion_watcher(
            app.clone(),
            session.clone(),
            thread_id.clone(),
            if session_mode == TerminalSessionMode::Resumed {
                launch_session_id.clone()
            } else {
                String::new()
            },
        );
    }

    let data_session_id = session_id.clone();
    let data_thread_id = thread_id.clone();
    let data_workspace_id = workspace_id.clone();
    let data_output_log = output_log.clone();
    let data_output_state = output_state.clone();
    let data_persistence_error = persistence_error;
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
        let mut output_log_failed = false;
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) => {
                    if terminal_reader_reached_end(&error) {
                        break;
                    }
                    record_terminal_persistence_error(
                        &data_persistence_error,
                        format!("Terminal output reader failed: {error}"),
                    );
                    break;
                }
            };

            if !output_log_failed {
                let write_result = data_output_log
                    .lock()
                    .map_err(|_| "Terminal output log lock poisoned".to_string())
                    .and_then(|mut file| {
                        file.write_bounded(&buffer[..read]).map_err(|error| {
                            format!("Unable to write terminal output log: {error}")
                        })
                    });
                if let Err(error) = write_result {
                    record_terminal_persistence_error(&data_persistence_error, error);
                    output_log_failed = true;
                }
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
                    append_terminal_output(&data_output_state, &data_persistence_error, &chunk);
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
                append_terminal_output(&data_output_state, &data_persistence_error, &trailing);
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

        if !output_log_failed {
            let sync_result = data_output_log
                .lock()
                .map_err(|_| "Terminal output log lock poisoned".to_string())
                .and_then(|file| {
                    file.sync_data()
                        .map_err(|error| format!("Unable to sync terminal output log: {error}"))
                });
            if let Err(error) = sync_result {
                record_terminal_persistence_error(&data_persistence_error, error);
            }
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
        if let Err(error) = wait_session.output_state.wait_until_reader_done() {
            record_terminal_persistence_error(
                &wait_session.persistence_error,
                format!("Unable to confirm terminal output completion: {error}"),
            );
        }
        let mut persistence_error = terminal_persistence_error(&wait_session.persistence_error);
        let end_position = match wait_session.output_state.end_position() {
            Ok(position) => position,
            Err(error) => {
                append_persistence_error(
                    &mut persistence_error,
                    format!("Unable to read final terminal output position: {error}"),
                );
                0
            }
        };

        let ended_at = Utc::now();
        let duration_ms = (ended_at - wait_session.started_at).num_milliseconds();
        let thread_id = match wait_session.thread_id.as_deref() {
            Some(thread_id) => thread_id,
            None => return,
        };
        if !wait_session
            .codex_session_id_confirmed
            .load(Ordering::Acquire)
        {
            if let Some(summary) = discover_terminal_codex_session(&wait_session) {
                bind_discovered_codex_session(&app, &wait_session, thread_id, &summary);
            }
        }
        if wait_session.session_mode != Some(TerminalSessionMode::Forked)
            && !wait_session
                .codex_session_id_confirmed
                .load(Ordering::Acquire)
        {
            if let Ok((output_tail, _)) = read_log_snapshot(&wait_session.output_log_path) {
                let output = strip_ansi_sequences(&output_tail);
                if let Some(codex_session_id) = extract_codex_resume_session_id(&output) {
                    if let Ok(Some(thread)) = storage::set_thread_codex_session_id_if_missing(
                        &wait_session.workspace_id,
                        thread_id,
                        &codex_session_id,
                    ) {
                        let _ = app.emit(THREAD_UPDATED_EVENT, thread);
                    }
                }
            }
        }
        wait_session.killed.store(true, Ordering::Release);
        let _ = wait_state.terminal_sessions.remove(&wait_session_id);
        let run_folder = storage::runs_dir(&wait_session.workspace_id, thread_id)
            .unwrap_or_else(|_| PathBuf::from(""))
            .join(&wait_session_id);

        if let Err(error) = storage::write_thread_run_json_file(
            &wait_session.workspace_id,
            thread_id,
            &wait_session_id,
            "metadata.json",
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
                "persistenceError": persistence_error,
            }),
        ) {
            append_persistence_error(
                &mut persistence_error,
                format!("Unable to save terminal run metadata: {error}"),
            );
        }

        let status = if persistence_error.is_some() {
            ThreadRunStatus::Failed
        } else if wait_session.termination_requested.load(Ordering::Acquire)
            || signal.is_some()
            || matches!(code, Some(130 | 143))
        {
            ThreadRunStatus::Canceled
        } else if code == Some(0) {
            ThreadRunStatus::Succeeded
        } else {
            ThreadRunStatus::Failed
        };
        if let Err(error) = storage::set_thread_run_state(
            &wait_session.workspace_id,
            thread_id,
            status,
            None,
            Some(ended_at),
        ) {
            append_persistence_error(
                &mut persistence_error,
                format!("Unable to save terminal thread state: {error}"),
            );
        }

        let diff_workspace_path = wait_session
            .current_cwd
            .lock()
            .ok()
            .map(|cwd| cwd.clone())
            .filter(|cwd| !cwd.trim().is_empty())
            .unwrap_or_else(|| wait_session.workspace_path.clone());
        if let Ok(diff) = git_tools::capture_patch_diff(&diff_workspace_path) {
            let _ = storage::write_thread_run_file(
                &wait_session.workspace_id,
                thread_id,
                &wait_session_id,
                "patch.diff",
                diff.as_bytes(),
            );
        }

        let _ = storage::set_latest_thread_run_id(
            &wait_session.workspace_id,
            thread_id,
            &wait_session_id,
        );
        clear_runtime_history_directory_active(&run_folder);
        let _ = prune_thread_run_history(&wait_session.workspace_id, thread_id);

        let _ = app.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitEvent {
                session_id: wait_session_id,
                code,
                signal,
                persistence_error,
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
        current_cwd: Some(cwd),
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
    let workspace_history_root = storage::workspace_shell_sessions_dir(&workspace_id)?;
    prune_runtime_history(&workspace_history_root, None)?;

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
    let run_dir = workspace_history_root.join(&session_id);
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
    let output_log = Arc::new(Mutex::new(BoundedOutputLog::open(&output_log_path)?));
    let output_state = Arc::new(TerminalOutputState::new());
    let persistence_error = Arc::new(Mutex::new(None));

    let started_at = Utc::now();
    let session = Arc::new(TerminalSession {
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        workspace_path: workspace_path.clone(),
        current_cwd: Mutex::new(cwd.clone()),
        observed_codex_session_id: Mutex::new(String::new()),
        kind: TerminalSessionKind::WorkspaceShell,
        thread_id: None,
        session_mode: None,
        resume_session_id: None,
        expected_fork_parent_id: None,
        baseline_rollout_paths: HashSet::new(),
        codex_sessions_root: None,
        submitted_input_buffer: Mutex::new(String::new()),
        process_id,
        started_at,
        command: command_manifest.clone(),
        output_log_path: output_log_path.clone(),
        output_state: output_state.clone(),
        persistence_error: persistence_error.clone(),
        submitted_prompt_count: AtomicU64::new(0),
        codex_session_id_confirmed: AtomicBool::new(false),
        master: Arc::new(Mutex::new(pty_pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
        killed: Arc::new(AtomicBool::new(false)),
        termination_requested: AtomicBool::new(false),
    });
    state.terminal_sessions.insert(session.clone())?;
    if let Err(error) = mark_runtime_history_directory_active(&run_dir) {
        let _ = state.terminal_sessions.remove(&session_id);
        terminate_terminal_session_process(&session);
        return Err(error);
    }

    let data_session_id = session_id.clone();
    let data_workspace_id = workspace_id.clone();
    let data_output_log = output_log.clone();
    let data_output_state = output_state.clone();
    let data_persistence_error = persistence_error;
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
        let mut output_log_failed = false;
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) => {
                    if terminal_reader_reached_end(&error) {
                        break;
                    }
                    record_terminal_persistence_error(
                        &data_persistence_error,
                        format!("Terminal output reader failed: {error}"),
                    );
                    break;
                }
            };

            if !output_log_failed {
                let write_result = data_output_log
                    .lock()
                    .map_err(|_| "Terminal output log lock poisoned".to_string())
                    .and_then(|mut file| {
                        file.write_bounded(&buffer[..read]).map_err(|error| {
                            format!("Unable to write terminal output log: {error}")
                        })
                    });
                if let Err(error) = write_result {
                    record_terminal_persistence_error(&data_persistence_error, error);
                    output_log_failed = true;
                }
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
                    append_terminal_output(&data_output_state, &data_persistence_error, &chunk);
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
                append_terminal_output(&data_output_state, &data_persistence_error, &trailing);
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

        if !output_log_failed {
            let sync_result = data_output_log
                .lock()
                .map_err(|_| "Terminal output log lock poisoned".to_string())
                .and_then(|file| {
                    file.sync_data()
                        .map_err(|error| format!("Unable to sync terminal output log: {error}"))
                });
            if let Err(error) = sync_result {
                record_terminal_persistence_error(&data_persistence_error, error);
            }
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
        if let Err(error) = wait_session.output_state.wait_until_reader_done() {
            record_terminal_persistence_error(
                &wait_session.persistence_error,
                format!("Unable to confirm terminal output completion: {error}"),
            );
        }
        let mut persistence_error = terminal_persistence_error(&wait_session.persistence_error);
        let end_position = match wait_session.output_state.end_position() {
            Ok(position) => position,
            Err(error) => {
                append_persistence_error(
                    &mut persistence_error,
                    format!("Unable to read final terminal output position: {error}"),
                );
                0
            }
        };

        wait_session.killed.store(true, Ordering::Release);
        let _ = wait_state.terminal_sessions.remove(&wait_session_id);

        let ended_at = Utc::now();
        let duration_ms = (ended_at - wait_session.started_at).num_milliseconds();
        if let Err(error) = storage::write_workspace_shell_run_json_file(
            &wait_session.workspace_id,
            &wait_session_id,
            "metadata.json",
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
                "persistenceError": persistence_error,
            }),
        ) {
            append_persistence_error(
                &mut persistence_error,
                format!("Unable to save workspace shell metadata: {error}"),
            );
        }
        clear_runtime_history_directory_active(&run_dir);
        if let Some(history_root) = run_dir.parent() {
            let _ = prune_runtime_history(history_root, None);
        }

        let _ = app.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitEvent {
                session_id: wait_session_id,
                code,
                signal,
                persistence_error,
            },
        );
    });

    Ok(WorkspaceShellStartResponse { session_id })
}

pub fn terminal_write(
    _app: AppHandle,
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

    let submitted_prompt = if session.kind == TerminalSessionKind::CodexThread {
        let mut input_buffer = session
            .submitted_input_buffer
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        update_prompt_submit_buffer(&mut input_buffer, &data)
    } else {
        false
    };

    if session.kind == TerminalSessionKind::CodexThread && submitted_prompt {
        session
            .submitted_prompt_count
            .fetch_add(1, Ordering::AcqRel);
    }

    Ok(true)
}

pub fn terminal_rebind_codex_session(
    state: Arc<RunnerState>,
    session_id: String,
    codex_session_id: String,
) -> Result<bool> {
    let normalized_codex_session_id = codex_session_id.trim();
    if !is_uuid_like(normalized_codex_session_id) {
        return Err(anyhow!("Codex session id must be a UUID"));
    }

    let Some(session) = state.terminal_sessions.get(&session_id)? else {
        return Ok(false);
    };
    if session.kind != TerminalSessionKind::CodexThread {
        return Ok(false);
    }

    {
        let mut observed_codex_session_id = session
            .observed_codex_session_id
            .lock()
            .map_err(|_| anyhow!("Terminal session lock poisoned"))?;
        *observed_codex_session_id = normalized_codex_session_id.to_string();
    }

    if let Some(current_cwd) = latest_codex_session_cwd(
        session.workspace_path.clone(),
        normalized_codex_session_id.to_string(),
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

    terminate_terminal_session_process(&session);
    let _ = state.terminal_sessions.remove(&session_id);
    Ok(true)
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

    if let Ok(mut writer) = session.writer.lock() {
        if writer
            .write_all("\u{3}".as_bytes())
            .and_then(|_| writer.flush())
            .is_ok()
        {
            return Ok(true);
        }
    }

    let process_group_id = session
        .master
        .lock()
        .ok()
        .and_then(|master| master.process_group_leader())
        .filter(|process_group_id| *process_group_id > 1);
    let signal_target = process_group_id
        .map(|process_group_id| -process_group_id)
        .or_else(|| session.process_id.map(|pid| pid as i32))
        .ok_or_else(|| anyhow!("Terminal process group is unavailable"))?;
    let result = unsafe { libc::kill(signal_target, libc::SIGINT) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(true)
    } else {
        Err(anyhow!("Failed to interrupt terminal process group"))
    }
}

pub fn copy_terminal_env_diagnostics(workspace_path: String) -> Result<String> {
    let settings = storage::load_settings()?;
    let cli_path = detect_codex_cli_path(&settings)
        .ok_or_else(|| anyhow!("Codex CLI not found. Configure the CLI path in Settings."))?;
    let shell_path = resolve_login_shell();
    let shell_command = format!(
        "env; echo '---'; which codex; echo '---'; {} --version",
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
    let sanitized_stderr =
        sanitize_env_diagnostics_stderr(&String::from_utf8_lossy(&output.stderr));

    let mut diagnostics = String::new();
    diagnostics.push_str(&format!("shell={shell_path}\n"));
    diagnostics.push_str(&format!("workspace={workspace_path}\n"));
    diagnostics.push_str("=== stdout ===\n");
    diagnostics.push_str(&sanitized_stdout);
    diagnostics.push_str("\n=== stderr ===\n");
    diagnostics.push_str(&sanitized_stderr);

    let artifacts_root = storage::ensure_base_dirs()?.join("artifacts");
    fs::create_dir_all(&artifacts_root)?;
    fs::write(
        artifacts_root.join("env-diagnostics.txt"),
        diagnostics.as_bytes(),
    )?;

    Ok(diagnostics)
}

fn extract_mounted_volume_path(hdiutil_output: &str) -> Option<String> {
    hdiutil_output.lines().find_map(|line| {
        line.find("/Volumes/")
            .map(|index| line[index..].trim().to_string())
    })
}

pub fn installed_app_path() -> PathBuf {
    Path::new("/Applications").join("ATController.app")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PendingUpdatePhase {
    Staged,
    Installed,
    Healthy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingUpdateManifest {
    schema_version: u32,
    transaction_id: String,
    expected_version: String,
    phase: PendingUpdatePhase,
}

#[derive(Clone, Debug)]
pub struct InstalledAppUpdate {
    manifest_path: PathBuf,
    applications_dir: PathBuf,
    recovery_app: PathBuf,
    manifest: PendingUpdateManifest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppReplacementMethod {
    AtomicSwap,
    CheckedRenameFallback,
}

#[derive(Debug)]
struct AppReplacement {
    recovery_app: PathBuf,
    method: AppReplacementMethod,
}

#[derive(Debug)]
struct UpdateReplacementPaths {
    primary_recovery: PathBuf,
    fallback_recovery: PathBuf,
    rollback_scratch: PathBuf,
}

fn update_replacement_paths(
    applications_dir: &Path,
    transaction_id: &str,
) -> UpdateReplacementPaths {
    UpdateReplacementPaths {
        primary_recovery: applications_dir
            .join(format!(".ATController.recovery-{transaction_id}.app")),
        fallback_recovery: applications_dir.join(format!(
            ".ATController.recovery-fallback-{transaction_id}.app"
        )),
        rollback_scratch: applications_dir
            .join(format!(".ATController.rollback-{transaction_id}.app")),
    }
}

fn pending_update_manifest_path() -> Result<PathBuf> {
    Ok(storage::ensure_base_dirs()?
        .join("updates")
        .join("pending-app-update.json"))
}

fn validate_pending_update_manifest(manifest: &PendingUpdateManifest) -> Result<()> {
    if manifest.schema_version != UPDATE_MANIFEST_SCHEMA_VERSION {
        return Err(anyhow!(
            "Unsupported pending update manifest schema version"
        ));
    }
    Uuid::parse_str(&manifest.transaction_id)
        .map_err(|_| anyhow!("Pending update manifest has an invalid transaction identifier"))?;
    if numeric_version_parts(&manifest.expected_version).is_none() {
        return Err(anyhow!(
            "Pending update manifest has an invalid expected version"
        ));
    }
    Ok(())
}

fn load_pending_update_manifest(path: &Path) -> Result<Option<PendingUpdateManifest>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(anyhow!(
                "Unable to read pending update manifest at {}: {error}",
                path.display()
            ));
        }
    };
    let manifest: PendingUpdateManifest = serde_json::from_slice(&bytes).map_err(|error| {
        anyhow!(
            "Pending update manifest at {} is invalid: {error}",
            path.display()
        )
    })?;
    validate_pending_update_manifest(&manifest)?;
    Ok(Some(manifest))
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| anyhow!("Unable to synchronize {}: {error}", path.display()))
}

fn write_pending_update_manifest(path: &Path, manifest: &PendingUpdateManifest) -> Result<()> {
    validate_pending_update_manifest(manifest)?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Pending update manifest path has no parent directory"))?;
    fs::create_dir_all(parent)?;
    let temp_path = parent.join(format!(".pending-app-update-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(manifest)?;

    let write_result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp_path, path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result.map_err(|error| {
        anyhow!(
            "Unable to persist pending update manifest at {}: {error:#}",
            path.display()
        )
    })
}

fn remove_pending_update_manifest(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(anyhow!(
                "Unable to remove pending update manifest at {}: {error}",
                path.display()
            ));
        }
    }
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn update_path_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_owned_update_directory(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(anyhow!(
            "Refusing to remove unexpected update recovery object at {}",
            path.display()
        ));
    }
    fs::remove_dir_all(path)
        .map_err(|error| anyhow!("Unable to remove {}: {error}", path.display()))
}

#[cfg(target_os = "macos")]
fn atomic_swap_app_bundles(left: &Path, right: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let left = CString::new(left.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let right = CString::new(right.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            left.as_ptr(),
            libc::AT_FDCWD,
            right.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn atomic_swap_app_bundles(_left: &Path, _right: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "atomic app bundle exchange is only available on macOS",
    ))
}

fn install_staged_app_with_operations<Swap, Rename>(
    target_app: &Path,
    paths: &UpdateReplacementPaths,
    mut atomic_swap: Swap,
    mut rename: Rename,
) -> Result<AppReplacement>
where
    Swap: FnMut(&Path, &Path) -> std::io::Result<()>,
    Rename: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    if target_app.parent() != paths.primary_recovery.parent()
        || target_app.parent() != paths.fallback_recovery.parent()
    {
        return Err(anyhow!(
            "Update target and recovery paths must be on the same volume"
        ));
    }
    if update_path_exists(&paths.fallback_recovery)? {
        return Err(anyhow!(
            "Update fallback recovery path already exists at {}",
            paths.fallback_recovery.display()
        ));
    }

    match atomic_swap(target_app, &paths.primary_recovery) {
        Ok(()) => {
            return Ok(AppReplacement {
                recovery_app: paths.primary_recovery.clone(),
                method: AppReplacementMethod::AtomicSwap,
            });
        }
        Err(atomic_error) => {
            rename(target_app, &paths.fallback_recovery).map_err(|fallback_error| {
                anyhow!(
                    "Atomic app replacement was unavailable ({atomic_error}); unable to preserve \
                     the installed ATController.app for checked fallback: {fallback_error}"
                )
            })?;

            if let Err(activation_error) = rename(&paths.primary_recovery, target_app) {
                match rename(&paths.fallback_recovery, target_app) {
                    Ok(()) => {
                        return Err(anyhow!(
                            "Atomic app replacement was unavailable ({atomic_error}); fallback \
                             activation failed ({activation_error}), and the previous \
                             ATController.app was restored"
                        ));
                    }
                    Err(rollback_error) => {
                        return Err(anyhow!(
                            "Atomic app replacement was unavailable ({atomic_error}); fallback \
                             activation failed ({activation_error}), and restoring \
                             ATController.app failed ({rollback_error}). The previous signed app \
                             remains recoverable at {}",
                            paths.fallback_recovery.display()
                        ));
                    }
                }
            }
        }
    }

    Ok(AppReplacement {
        recovery_app: paths.fallback_recovery.clone(),
        method: AppReplacementMethod::CheckedRenameFallback,
    })
}

fn install_staged_app(target_app: &Path, paths: &UpdateReplacementPaths) -> Result<AppReplacement> {
    install_staged_app_with_operations(
        target_app,
        paths,
        atomic_swap_app_bundles,
        |from: &Path, to: &Path| fs::rename(from, to),
    )
}

fn restore_recovery_with_operations<Swap, Rename>(
    target_app: &Path,
    recovery_app: &Path,
    rollback_scratch: &Path,
    mut atomic_swap: Swap,
    mut rename: Rename,
) -> Result<PathBuf>
where
    Swap: FnMut(&Path, &Path) -> std::io::Result<()>,
    Rename: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    match atomic_swap(target_app, recovery_app) {
        Ok(()) => return Ok(recovery_app.to_path_buf()),
        Err(atomic_error) => {
            if update_path_exists(rollback_scratch)? {
                return Err(anyhow!(
                    "Rollback scratch path already exists at {}",
                    rollback_scratch.display()
                ));
            }
            rename(target_app, rollback_scratch).map_err(|displace_error| {
                anyhow!(
                    "Atomic rollback was unavailable ({atomic_error}); unable to preserve the \
                     failed update before fallback rollback: {displace_error}"
                )
            })?;
            if let Err(restore_error) = rename(recovery_app, target_app) {
                match rename(rollback_scratch, target_app) {
                    Ok(()) => {
                        return Err(anyhow!(
                            "Atomic rollback was unavailable ({atomic_error}); restoring the \
                             previous app failed ({restore_error}), but the failed update was \
                             returned to the installation path"
                        ));
                    }
                    Err(reinstate_error) => {
                        return Err(anyhow!(
                            "Atomic rollback was unavailable ({atomic_error}); restoring the \
                             previous app failed ({restore_error}), and reinstating the failed \
                             update also failed ({reinstate_error}). The previous signed app \
                             remains recoverable at {}",
                            recovery_app.display()
                        ));
                    }
                }
            }
        }
    }

    Ok(rollback_scratch.to_path_buf())
}

fn pending_update_matches(
    expected: &PendingUpdateManifest,
    actual: &PendingUpdateManifest,
) -> bool {
    expected.schema_version == actual.schema_version
        && expected.transaction_id == actual.transaction_id
        && expected.expected_version == actual.expected_version
}

fn mark_pending_update_healthy(
    manifest_path: &Path,
    expected: &PendingUpdateManifest,
) -> Result<()> {
    let mut current = load_pending_update_manifest(manifest_path)?
        .ok_or_else(|| anyhow!("Pending update manifest disappeared before health confirmation"))?;
    if !pending_update_matches(expected, &current) {
        return Err(anyhow!("Pending update changed before health confirmation"));
    }
    current.phase = PendingUpdatePhase::Healthy;
    write_pending_update_manifest(manifest_path, &current)
}

fn finalize_healthy_update(
    manifest_path: &Path,
    applications_dir: &Path,
    expected: &PendingUpdateManifest,
) -> Result<()> {
    let current = match load_pending_update_manifest(manifest_path)? {
        Some(current) => current,
        None => return Ok(()),
    };
    if !pending_update_matches(expected, &current) {
        return Err(anyhow!("Pending update changed before recovery cleanup"));
    }
    if current.phase != PendingUpdatePhase::Healthy {
        return Err(anyhow!(
            "Refusing to remove update recovery before launch health is confirmed"
        ));
    }

    let paths = update_replacement_paths(applications_dir, &current.transaction_id);
    remove_owned_update_directory(&paths.primary_recovery)?;
    remove_owned_update_directory(&paths.fallback_recovery)?;
    remove_owned_update_directory(&paths.rollback_scratch)?;
    sync_directory(applications_dir)?;
    remove_pending_update_manifest(manifest_path)
}

fn executable_is_inside_app(executable: &Path, app_bundle: &Path) -> bool {
    let Ok(executable) = fs::canonicalize(executable) else {
        return false;
    };
    let Ok(macos_dir) = fs::canonicalize(app_bundle.join("Contents").join("MacOS")) else {
        return false;
    };
    executable.starts_with(macos_dir)
}

pub fn schedule_pending_update_health_confirmation() -> Result<()> {
    let manifest_path = pending_update_manifest_path()?;
    let Some(manifest) = load_pending_update_manifest(&manifest_path)? else {
        return Ok(());
    };
    if manifest.expected_version != env!("CARGO_PKG_VERSION") {
        return Ok(());
    }
    let target_app = installed_app_path();
    let current_executable = env::current_exe()?;
    if !executable_is_inside_app(&current_executable, &target_app) {
        return Ok(());
    }
    let applications_dir = target_app
        .parent()
        .ok_or_else(|| anyhow!("Installed application path has no parent"))?
        .to_path_buf();

    std::thread::spawn(move || {
        if manifest.phase != PendingUpdatePhase::Healthy {
            std::thread::sleep(UPDATE_HEALTH_ACK_DELAY);
            if let Err(error) = mark_pending_update_healthy(&manifest_path, &manifest) {
                eprintln!("[updater] launch health confirmation failed: {error:#}");
                return;
            }
        }

        // Keep the prior signed bundle until the relaunched process has remained
        // alive beyond the initial health acknowledgement.
        std::thread::sleep(UPDATE_HEALTH_STABILITY_PERIOD);
        if let Err(error) = finalize_healthy_update(&manifest_path, &applications_dir, &manifest) {
            eprintln!(
                "[updater] recovery cleanup was deferred; the prior app remains recoverable: \
                 {error:#}"
            );
        }
    });
    Ok(())
}

pub fn wait_for_installed_update_health(
    update: &InstalledAppUpdate,
    timeout: Duration,
) -> Result<()> {
    let started = Instant::now();
    loop {
        let current = load_pending_update_manifest(&update.manifest_path)?
            .ok_or_else(|| anyhow!("Pending update manifest disappeared before health handoff"))?;
        if !pending_update_matches(&update.manifest, &current) {
            return Err(anyhow!(
                "Pending update changed before relaunch health was confirmed"
            ));
        }
        if current.phase == PendingUpdatePhase::Healthy {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err(anyhow!(
                "Relaunched ATController did not confirm startup health within {} seconds",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(UPDATE_HEALTH_POLL_INTERVAL);
    }
}

pub fn rollback_installed_update(update: &InstalledAppUpdate) -> Result<()> {
    let current = load_pending_update_manifest(&update.manifest_path)?
        .ok_or_else(|| anyhow!("Pending update manifest is missing; rollback was not attempted"))?;
    if !pending_update_matches(&update.manifest, &current) {
        return Err(anyhow!(
            "Pending update changed; rollback was not attempted"
        ));
    }
    if !update_path_exists(&update.recovery_app)? {
        return Err(anyhow!(
            "Previous ATController.app recovery bundle is missing at {}",
            update.recovery_app.display()
        ));
    }

    let paths = update_replacement_paths(&update.applications_dir, &update.manifest.transaction_id);
    let displaced_update = restore_recovery_with_operations(
        &installed_app_path(),
        &update.recovery_app,
        &paths.rollback_scratch,
        atomic_swap_app_bundles,
        |from: &Path, to: &Path| fs::rename(from, to),
    )?;
    sync_directory(&update.applications_dir)?;
    remove_owned_update_directory(&displaced_update)?;
    sync_directory(&update.applications_dir)?;
    remove_pending_update_manifest(&update.manifest_path)
}

struct UpdateTempDir {
    path: PathBuf,
}

impl Drop for UpdateTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct MountedUpdateVolume {
    path: PathBuf,
}

impl Drop for MountedUpdateVolume {
    fn drop(&mut self) {
        let _ = StdCommand::new("/usr/bin/hdiutil")
            .args(["detach", self.path.to_string_lossy().as_ref(), "-quiet"])
            .status();
    }
}

fn checked_update_command(
    command: StdCommand,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output> {
    let output = run_std_command_with_timeout(command, timeout, label)?;
    if output.status.success() {
        return Ok(output);
    }
    Err(anyhow!(
        "{label} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn read_bundle_plist_value(info_plist: &Path, key: &str) -> Result<String> {
    let mut command = StdCommand::new("/usr/libexec/PlistBuddy");
    command
        .args(["-c", &format!("Print :{key}")])
        .arg(info_plist);
    let output = checked_update_command(
        command,
        Duration::from_secs(15),
        &format!("{key} verification"),
    )?;
    trim_to_option(Some(String::from_utf8_lossy(&output.stdout).to_string()))
        .ok_or_else(|| anyhow!("{key} is missing from the app bundle"))
}

fn bundle_info_plist(app_bundle: &Path) -> PathBuf {
    app_bundle.join("Contents").join("Info.plist")
}

fn codesign_team_identifier(app_bundle: &Path) -> Result<String> {
    let mut command = StdCommand::new("/usr/bin/codesign");
    command.args(["--display", "--verbose=4"]).arg(app_bundle);
    let output = checked_update_command(
        command,
        Duration::from_secs(30),
        "ATController signing identity inspection",
    )?;
    let details = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    details
        .lines()
        .find_map(|line| line.trim().strip_prefix("TeamIdentifier="))
        .and_then(|value| trim_to_option(Some(value.to_string())))
        .filter(|value| value != "not set")
        .ok_or_else(|| anyhow!("ATController signature does not contain a TeamIdentifier"))
}

fn numeric_version_parts(version: &str) -> Option<Vec<u64>> {
    let normalized = version.trim();
    let normalized = normalized.strip_prefix('v').unwrap_or(normalized);
    let segments = normalized.split('.').collect::<Vec<_>>();
    if segments.len() != 3 {
        return None;
    }
    segments
        .into_iter()
        .map(|part| {
            if part.is_empty() || !part.chars().all(|character| character.is_ascii_digit()) {
                None
            } else {
                part.parse::<u64>().ok()
            }
        })
        .collect()
}

fn version_is_strictly_newer(candidate: &str, installed: &str) -> bool {
    let (Some(mut candidate), Some(mut installed)) = (
        numeric_version_parts(candidate),
        numeric_version_parts(installed),
    ) else {
        return false;
    };
    let width = candidate.len().max(installed.len());
    candidate.resize(width, 0);
    installed.resize(width, 0);
    candidate > installed
}

fn verify_update_app_bundle(app_bundle: &Path) -> Result<()> {
    if !app_bundle.is_dir() {
        return Err(anyhow!("Update does not contain ATController.app"));
    }
    let info_plist = bundle_info_plist(app_bundle);
    if !info_plist.is_file() {
        return Err(anyhow!("ATController.app is missing Contents/Info.plist"));
    }
    let bundle_identifier = read_bundle_plist_value(&info_plist, "CFBundleIdentifier")?;
    if bundle_identifier != "com.furyanf.atcontroller" {
        return Err(anyhow!(
            "ATController.app has unexpected bundle identifier: {bundle_identifier}"
        ));
    }
    let bundle_name = read_bundle_plist_value(&info_plist, "CFBundleName")?;
    if bundle_name != "ATController" {
        return Err(anyhow!(
            "Update has unexpected application name: {bundle_name}"
        ));
    }
    let display_name = read_bundle_plist_value(&info_plist, "CFBundleDisplayName")?;
    if display_name != "ATController" {
        return Err(anyhow!(
            "Update has unexpected display name: {display_name}"
        ));
    }
    let executable_name = read_bundle_plist_value(&info_plist, "CFBundleExecutable")?;
    let executable_path = app_bundle
        .join("Contents")
        .join("MacOS")
        .join(executable_name);
    let executable_metadata = fs::metadata(&executable_path)
        .map_err(|_| anyhow!("ATController.app is missing its declared executable"))?;
    if !executable_metadata.is_file() {
        return Err(anyhow!("ATController.app executable is not a regular file"));
    }
    #[cfg(unix)]
    if executable_metadata.permissions().mode() & 0o111 == 0 {
        return Err(anyhow!("ATController.app executable is not executable"));
    }

    let mut signature_command = StdCommand::new("/usr/bin/codesign");
    signature_command
        .args(["--verify", "--deep", "--strict", "--verbose=2"])
        .arg(app_bundle);
    checked_update_command(
        signature_command,
        Duration::from_secs(60),
        "ATController code signature verification",
    )?;

    let mut gatekeeper_command = StdCommand::new("/usr/sbin/spctl");
    gatekeeper_command
        .args(["--assess", "--type", "execute", "--verbose=4"])
        .arg(app_bundle);
    checked_update_command(
        gatekeeper_command,
        Duration::from_secs(60),
        "ATController Gatekeeper assessment",
    )?;
    Ok(())
}

fn verify_replaced_update_app(
    target_app: &Path,
    expected_team_identifier: &str,
    expected_version: &str,
) -> Result<()> {
    sync_directory(
        target_app
            .parent()
            .ok_or_else(|| anyhow!("Installed application path has no parent"))?,
    )?;
    verify_update_app_bundle(target_app)?;
    let installed_update_team_identifier = codesign_team_identifier(target_app)?;
    if installed_update_team_identifier != expected_team_identifier {
        return Err(anyhow!(
            "Installed update signing TeamIdentifier changed during replacement"
        ));
    }
    let installed_update_version =
        read_bundle_plist_value(&bundle_info_plist(target_app), "CFBundleShortVersionString")?;
    if installed_update_version != expected_version {
        return Err(anyhow!(
            "Installed ATController version does not match the verified update"
        ));
    }
    Ok(())
}

pub fn install_latest_update() -> Result<InstalledAppUpdate> {
    let dmg_asset_name = "ATController.dmg";
    let app_bundle_name = "ATController.app";
    let temp_path = env::temp_dir().join(format!("ATController-update-{}", Uuid::new_v4()));
    fs::create_dir(&temp_path)?;
    let _temp_guard = UpdateTempDir {
        path: temp_path.clone(),
    };
    let dmg_path = temp_path.join(dmg_asset_name);
    let dmg_path_string = dmg_path.to_string_lossy().to_string();
    let download_url = format!(
        "https://github.com/FuRyanf/ATController/releases/latest/download/{dmg_asset_name}"
    );

    let mut download_command = StdCommand::new("/usr/bin/curl");
    download_command.args([
        "--fail-with-body",
        "--show-error",
        "--silent",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--connect-timeout",
        "20",
        "--max-time",
        "300",
        "--max-filesize",
        MAX_UPDATE_DMG_BYTES_ARG,
        "--retry",
        "3",
        "--retry-all-errors",
        "--output",
        &dmg_path_string,
        &download_url,
    ]);
    checked_update_command(
        download_command,
        Duration::from_secs(330),
        &format!("{dmg_asset_name} download"),
    )?;
    let downloaded_size = fs::metadata(&dmg_path)?.len();
    if downloaded_size == 0 {
        return Err(anyhow!("Downloaded {dmg_asset_name} is empty"));
    }
    if downloaded_size > MAX_UPDATE_DMG_BYTES {
        return Err(anyhow!(
            "Downloaded {dmg_asset_name} exceeds the maximum allowed size"
        ));
    }

    let mut verify_dmg_command = StdCommand::new("/usr/bin/hdiutil");
    verify_dmg_command.args(["verify", &dmg_path_string]);
    checked_update_command(
        verify_dmg_command,
        Duration::from_secs(120),
        "DMG verification",
    )?;

    let mut attach_command = StdCommand::new("/usr/bin/hdiutil");
    attach_command.args([
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        &dmg_path_string,
    ]);
    let attach_output =
        checked_update_command(attach_command, Duration::from_secs(60), "DMG mount")?;

    let attach_stdout = String::from_utf8_lossy(&attach_output.stdout);
    let attach_stderr = String::from_utf8_lossy(&attach_output.stderr);
    let mount_path = extract_mounted_volume_path(&attach_stdout)
        .or_else(|| extract_mounted_volume_path(&attach_stderr))
        .ok_or_else(|| anyhow!("Unable to locate mounted DMG volume path"))?;
    let mount_path = PathBuf::from(mount_path);
    if !mount_path.starts_with("/Volumes") {
        return Err(anyhow!("DMG mounted at an unexpected location"));
    }
    let _mount_guard = MountedUpdateVolume {
        path: mount_path.clone(),
    };
    let canonical_mount = fs::canonicalize(&mount_path)?;
    let source_app = mount_path.join(app_bundle_name);
    let canonical_source_app = fs::canonicalize(&source_app)
        .map_err(|_| anyhow!("Mounted DMG does not contain {app_bundle_name}"))?;
    if !canonical_source_app.starts_with(&canonical_mount) {
        return Err(anyhow!(
            "{app_bundle_name} resolves outside the mounted DMG"
        ));
    }
    verify_update_app_bundle(&canonical_source_app)?;

    let target_app = installed_app_path();
    if !target_app.is_dir() {
        return Err(anyhow!(
            "ATController.app is not installed in /Applications; automatic update was not attempted"
        ));
    }
    verify_update_app_bundle(&target_app).map_err(|error| {
        anyhow!("Installed ATController.app is not a trusted update anchor: {error}")
    })?;
    let installed_team_identifier = codesign_team_identifier(&target_app)?;
    let update_team_identifier = codesign_team_identifier(&canonical_source_app)?;
    if installed_team_identifier != update_team_identifier {
        return Err(anyhow!(
            "Update signing TeamIdentifier does not match the installed ATController.app"
        ));
    }
    let installed_version = read_bundle_plist_value(
        &bundle_info_plist(&target_app),
        "CFBundleShortVersionString",
    )?;
    let update_version = read_bundle_plist_value(
        &bundle_info_plist(&canonical_source_app),
        "CFBundleShortVersionString",
    )?;
    if !version_is_strictly_newer(&update_version, &installed_version) {
        return Err(anyhow!(
            "Downloaded ATController version {update_version} is not newer than installed version {installed_version}"
        ));
    }
    let applications_dir = target_app
        .parent()
        .ok_or_else(|| anyhow!("Invalid /Applications target path"))?;
    let update_id = Uuid::new_v4();
    let transaction_id = update_id.to_string();
    let replacement_paths = update_replacement_paths(applications_dir, &transaction_id);
    let manifest_path = pending_update_manifest_path()?;
    if let Some(previous) = load_pending_update_manifest(&manifest_path)? {
        let previous_paths = update_replacement_paths(applications_dir, &previous.transaction_id);
        let recovery_exists = update_path_exists(&previous_paths.primary_recovery)?
            || update_path_exists(&previous_paths.fallback_recovery)?
            || update_path_exists(&previous_paths.rollback_scratch)?;
        if recovery_exists {
            return Err(anyhow!(
                "A previous ATController update still has recoverable state. Relaunch \
                 ATController before attempting another update"
            ));
        }
        remove_pending_update_manifest(&manifest_path)?;
    }
    for path in [
        &replacement_paths.primary_recovery,
        &replacement_paths.fallback_recovery,
        &replacement_paths.rollback_scratch,
    ] {
        if update_path_exists(path)? {
            return Err(anyhow!(
                "Update recovery path unexpectedly exists at {}",
                path.display()
            ));
        }
    }

    let mut copy_command = StdCommand::new("/usr/bin/ditto");
    copy_command
        .arg(&canonical_source_app)
        .arg(&replacement_paths.primary_recovery);
    if let Err(error) = checked_update_command(
        copy_command,
        Duration::from_secs(180),
        "ATController installation staging",
    ) {
        let _ = remove_owned_update_directory(&replacement_paths.primary_recovery);
        return Err(error);
    }
    if let Err(error) = verify_update_app_bundle(&replacement_paths.primary_recovery) {
        let _ = remove_owned_update_directory(&replacement_paths.primary_recovery);
        return Err(error);
    }
    if let Err(error) = sync_directory(applications_dir) {
        let _ = remove_owned_update_directory(&replacement_paths.primary_recovery);
        return Err(error);
    }

    let manifest = PendingUpdateManifest {
        schema_version: UPDATE_MANIFEST_SCHEMA_VERSION,
        transaction_id,
        expected_version: update_version.clone(),
        phase: PendingUpdatePhase::Staged,
    };
    if let Err(error) = write_pending_update_manifest(&manifest_path, &manifest) {
        let _ = remove_owned_update_directory(&replacement_paths.primary_recovery);
        return Err(error);
    }

    let replacement = install_staged_app(&target_app, &replacement_paths).map_err(|error| {
        anyhow!(
            "ATController.app replacement failed. Recovery state was retained for transaction \
             {}: {error:#}",
            manifest.transaction_id
        )
    })?;
    let update = InstalledAppUpdate {
        manifest_path: manifest_path.clone(),
        applications_dir: applications_dir.to_path_buf(),
        recovery_app: replacement.recovery_app,
        manifest: manifest.clone(),
    };

    let validate_installed_result =
        verify_replaced_update_app(&target_app, &installed_team_identifier, &update_version);
    if let Err(validation_error) = validate_installed_result {
        return match rollback_installed_update(&update) {
            Ok(()) => Err(anyhow!(
                "The installed update failed post-replacement verification and the previous \
                 ATController.app was restored: {validation_error:#}"
            )),
            Err(rollback_error) => Err(anyhow!(
                "The installed update failed post-replacement verification \
                 ({validation_error:#}), and automatic rollback failed ({rollback_error:#}). The \
                 previous signed app remains recoverable at {}",
                update.recovery_app.display()
            )),
        };
    }

    let persist_install_result = {
        let mut installed_manifest = manifest;
        installed_manifest.phase = PendingUpdatePhase::Installed;
        write_pending_update_manifest(&manifest_path, &installed_manifest)
    };
    if let Err(install_error) = persist_install_result {
        return match rollback_installed_update(&update) {
            Ok(()) => Err(anyhow!(
                "The update could not be durably recorded and the previous ATController.app was \
                 restored: {install_error:#}"
            )),
            Err(rollback_error) => Err(anyhow!(
                "The update could not be durably recorded ({install_error:#}), and automatic \
                 rollback failed ({rollback_error:#}). The previous signed app remains \
                 recoverable at {}",
                update.recovery_app.display()
            )),
        };
    }

    eprintln!(
        "[updater] installed with {:?}; recovery retained at {} pending launch health",
        replacement.method,
        update.recovery_app.display()
    );
    Ok(update)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    struct EnvironmentGuard {
        previous_codex_home: Option<OsString>,
        previous_app_support_root: Option<OsString>,
    }

    impl EnvironmentGuard {
        fn set(root: &Path) -> Self {
            let previous_codex_home = env::var_os("CODEX_HOME");
            let previous_app_support_root = env::var_os("ATCONTROLLER_APP_SUPPORT_ROOT");
            env::set_var("CODEX_HOME", root.join("codex-home"));
            env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", root.join("app-support"));
            Self {
                previous_codex_home,
                previous_app_support_root,
            }
        }
    }

    impl Drop for EnvironmentGuard {
        fn drop(&mut self) {
            match self.previous_codex_home.take() {
                Some(value) => env::set_var("CODEX_HOME", value),
                None => env::remove_var("CODEX_HOME"),
            }
            match self.previous_app_support_root.take() {
                Some(value) => env::set_var("ATCONTROLLER_APP_SUPPORT_ROOT", value),
                None => env::remove_var("ATCONTROLLER_APP_SUPPORT_ROOT"),
            }
        }
    }

    #[test]
    fn deepest_registered_workspace_owns_nested_session_path() {
        let lookup = vec![
            LocalWorkspaceMatch {
                path: PathBuf::from("/repo/packages/app"),
                id: "nested".to_string(),
                name: "app".to_string(),
            },
            LocalWorkspaceMatch {
                path: PathBuf::from("/repo"),
                id: "root".to_string(),
                name: "repo".to_string(),
            },
        ];

        assert_eq!(
            owning_local_workspace(&lookup, "/repo/packages/app/src")
                .map(|workspace| workspace.id.as_str()),
            Some("nested")
        );
        assert_eq!(
            owning_local_workspace(&lookup, "/repo/other").map(|workspace| workspace.id.as_str()),
            Some("root")
        );
        assert!(owning_local_workspace(&lookup, "/unrelated").is_none());
    }

    #[test]
    fn recent_codex_titles_are_single_line_and_bounded() {
        let session = ImportableCodexSession {
            session_id: Uuid::new_v4().to_string(),
            summary: Some(format!("first\nsecond {}", "x".repeat(140))),
            first_prompt: None,
            message_count: 1,
            created_at: None,
            modified_at: None,
            git_branch: None,
        };
        let title = recent_codex_thread_title(&session);
        assert!(!title.contains('\n'));
        assert!(title.ends_with('…'));
        assert!(title.chars().count() <= 121);
    }

    fn write_session(root: &Path, session_id: &str, entries: &[Value]) -> PathBuf {
        let directory = root
            .join("codex-home")
            .join("sessions")
            .join("2026")
            .join("07")
            .join("28");
        fs::create_dir_all(&directory).expect("session directory should be created");
        let path = directory.join(format!("rollout-2026-07-28T10-00-00-{session_id}.jsonl"));
        let raw = entries
            .iter()
            .map(|entry| serde_json::to_string(entry).expect("entry should serialize"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(&path, raw).expect("session fixture should be written");
        path
    }

    #[cfg(unix)]
    #[test]
    fn command_runner_drains_large_stdout_and_stderr_concurrently() {
        let bytes_per_stream = 256 * 1024;
        let script = format!(
            "(awk 'BEGIN {{ for (i = 0; i < {bytes_per_stream}; i++) printf \"O\" }}') & \
             (awk 'BEGIN {{ for (i = 0; i < {bytes_per_stream}; i++) printf \"E\" }}' >&2) & wait"
        );
        let mut command = StdCommand::new("/bin/sh");
        command.args(["-c", &script]);

        let output =
            run_std_command_with_timeout(command, Duration::from_secs(10), "large output fixture")
                .expect("large simultaneous output should not block pipe draining");

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), bytes_per_stream);
        assert_eq!(output.stderr.len(), bytes_per_stream);
        assert!(output.stdout.iter().all(|byte| *byte == b'O'));
        assert!(output.stderr.iter().all(|byte| *byte == b'E'));
    }

    #[cfg(unix)]
    #[test]
    fn command_runner_bounds_each_stream_and_marks_truncated_output() {
        let bytes_per_stream = COMMAND_OUTPUT_MAX_BYTES_PER_STREAM * 3;
        let script = format!(
            "(awk 'BEGIN {{ for (i = 0; i < {bytes_per_stream}; i++) printf \"O\" }}'; \
                printf 'STDOUT-END') & \
             (awk 'BEGIN {{ for (i = 0; i < {bytes_per_stream}; i++) printf \"E\" }}'; \
                printf 'STDERR-END' >&2) >&2 & wait"
        );
        let mut command = StdCommand::new("/bin/sh");
        command.args(["-c", &script]);

        let output = run_std_command_with_timeout(
            command,
            Duration::from_secs(15),
            "bounded output fixture",
        )
        .expect("oversized output should remain bounded");

        assert!(output.status.success());
        assert!(output.stdout.len() <= COMMAND_OUTPUT_MAX_BYTES_PER_STREAM);
        assert!(output.stderr.len() <= COMMAND_OUTPUT_MAX_BYTES_PER_STREAM);
        assert!(output
            .stdout
            .starts_with(b"[ATController: stdout truncated;"));
        assert!(output
            .stderr
            .starts_with(b"[ATController: stderr truncated;"));
        assert!(output.stdout.ends_with(b"STDOUT-END"));
        assert!(output.stderr.ends_with(b"STDERR-END"));
    }

    #[cfg(unix)]
    #[test]
    fn command_runner_timeout_terminates_descendants_and_reaps_the_child() {
        let root = env::temp_dir().join(format!(
            "atcontroller-command-timeout-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let terminated_marker = root.join("descendant-terminated");
        let descendant_pid_path = root.join("descendant-pid");
        let script = "\
            child_pid=; \
            trap 'wait \"$child_pid\" 2>/dev/null; exit 0' TERM; \
            (trap 'printf terminated > \"$1\"; exit 0' TERM; \
                while :; do :; done) & \
            child_pid=$!; \
            printf '%s' \"$child_pid\" > \"$2\"; \
            wait \"$child_pid\"";
        let mut command = StdCommand::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .arg("command-timeout-fixture")
            .arg(&terminated_marker)
            .arg(&descendant_pid_path);

        let error = run_std_command_with_timeout(
            command,
            Duration::from_millis(300),
            "timeout cleanup fixture",
        )
        .expect_err("the fixture should time out");
        assert!(error.to_string().contains("timed out"));
        assert_eq!(
            fs::read_to_string(&terminated_marker)
                .expect("the descendant should receive process-group termination"),
            "terminated"
        );

        let descendant_pid = fs::read_to_string(&descendant_pid_path)
            .expect("the fixture should record its descendant")
            .parse::<i32>()
            .expect("the descendant pid should be numeric");
        let mut descendant_exists = true;
        for _ in 0..50 {
            let result = unsafe { libc::kill(descendant_pid, 0) };
            if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                descendant_exists = false;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if descendant_exists {
            let _ = unsafe { libc::kill(descendant_pid, libc::SIGKILL) };
        }
        assert!(!descendant_exists, "the descendant process should be gone");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn access_modes_use_current_codex_flags() {
        assert_eq!(
            codex_access_args(true),
            &["--dangerously-bypass-approvals-and-sandbox"]
        );
        assert_eq!(
            codex_access_args(false),
            &[
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request"
            ]
        );
    }

    #[test]
    fn output_logs_compact_atomically_and_preserve_logical_cursors() {
        let root = env::temp_dir().join(format!(
            "atcontroller-bounded-output-log-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let path = root.join("output.log");
        let first = vec![b'a'; TERMINAL_OUTPUT_LOG_MAX_BYTES as usize - 1024];
        let second = vec![b'b'; 2048];
        let third = b"still-live";
        let logical_end = (first.len() + second.len() + third.len()) as u64;

        let mut log = BoundedOutputLog::open(&path).expect("bounded log should open");
        log.write_bounded(&first)
            .expect("initial output should append");
        log.write_bounded(&second)
            .expect("overflowing output should compact");
        log.write_bounded(third)
            .expect("active output should continue after compaction");
        log.sync_data().expect("bounded log should sync");
        drop(log);

        assert_eq!(
            fs::metadata(&path)
                .expect("log metadata should exist")
                .len(),
            TERMINAL_OUTPUT_LOG_COMPACT_BYTES + third.len() as u64
        );
        assert!(output_log_truncation_marker_path(&path).is_file());
        let retained = fs::read(&path).expect("compacted log should remain readable");
        assert!(retained.ends_with(&[second.as_slice(), third].concat()));
        assert!(fs::read_dir(&root)
            .expect("fixture directory should be readable")
            .all(|entry| !entry
                .expect("fixture entry should be readable")
                .file_name()
                .to_string_lossy()
                .contains(".compact-")));

        let snapshot =
            snapshot_from_log_path(&path, logical_end).expect("snapshot should remain readable");
        assert!(snapshot.truncated);
        assert_eq!(snapshot.end_position, logical_end);
        assert_eq!(
            snapshot.start_position,
            logical_end - terminal_position_len(&snapshot.text)
        );
        assert!(snapshot
            .text
            .ends_with(std::str::from_utf8(third).expect("ASCII fixture should decode as UTF-8")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_output_write_keeps_only_the_recent_tail() {
        let root = env::temp_dir().join(format!(
            "atcontroller-oversized-output-log-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let path = root.join("output.log");
        let oversized = vec![b'x'; TERMINAL_OUTPUT_LOG_MAX_BYTES as usize + 4096];
        let expected_tail =
            &oversized[oversized.len() - TERMINAL_OUTPUT_LOG_COMPACT_BYTES as usize..];

        let mut log = BoundedOutputLog::open(&path).expect("bounded log should open");
        log.write_bounded(&oversized)
            .expect("oversized output should compact without first growing the file");
        log.sync_data().expect("bounded log should sync");
        drop(log);

        assert_eq!(
            fs::metadata(&path)
                .expect("log metadata should exist")
                .len(),
            TERMINAL_OUTPUT_LOG_COMPACT_BYTES
        );
        assert_eq!(
            fs::read(&path).expect("bounded log should be readable"),
            expected_tail
        );
        assert!(read_log_snapshot(&path).expect("snapshot should load").1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_history_pruning_keeps_latest_current_and_active_directories() {
        let directories = (0_u64..35)
            .map(|index| RuntimeHistoryDirectory {
                path: PathBuf::from(format!("/history/run-{index:02}")),
                name: format!("run-{index:02}"),
                modified: SystemTime::UNIX_EPOCH + Duration::from_secs(index),
                active: index == 0,
            })
            .collect();

        let pruned = runtime_history_directories_to_prune(directories, Some("run-01"));

        assert_eq!(pruned, vec![PathBuf::from("/history/run-02")]);
    }

    #[test]
    fn live_pid_marker_protects_an_active_history_directory() {
        let root = env::temp_dir().join(format!(
            "atcontroller-active-history-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");

        mark_runtime_history_directory_active(&root)
            .expect("active marker should be written atomically");
        assert!(runtime_history_directory_is_active(&root));
        clear_runtime_history_directory_active(&root);
        assert!(!runtime_history_directory_is_active(&root));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_reader_recognizes_normal_pty_end_conditions() {
        let unexpected_eof = std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "PTY closed");
        assert!(terminal_reader_reached_end(&unexpected_eof));

        #[cfg(unix)]
        {
            let pty_eio = std::io::Error::from_raw_os_error(libc::EIO);
            assert!(terminal_reader_reached_end(&pty_eio));
        }

        let other_error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert!(!terminal_reader_reached_end(&other_error));
    }

    #[test]
    fn update_versions_require_a_strict_numeric_upgrade() {
        assert!(version_is_strictly_newer("0.0.22", "0.0.21"));
        assert!(version_is_strictly_newer("1.0.0", "0.9.99"));
        assert!(!version_is_strictly_newer("0.0.21", "0.0.21"));
        assert!(!version_is_strictly_newer("0.0.20", "0.0.21"));
        assert!(!version_is_strictly_newer("1.0", "0.9.99"));
        assert!(!version_is_strictly_newer("1.2.3.4", "1.2.3"));
        assert!(!version_is_strictly_newer("1.2.4-preview", "1.2.3"));
        assert!(!version_is_strictly_newer("1.2.4+build", "1.2.3"));
        assert!(!version_is_strictly_newer("vv1.2.4", "1.2.3"));
        assert!(!version_is_strictly_newer("preview", "0.0.21"));
    }

    fn create_update_fixture_bundle(path: &Path, label: &str) {
        fs::create_dir(path).expect("fixture app directory should be created");
        fs::write(path.join("identity.txt"), label)
            .expect("fixture app identity should be written");
    }

    fn update_fixture_identity(path: &Path) -> String {
        fs::read_to_string(path.join("identity.txt"))
            .expect("fixture app identity should be readable")
    }

    fn simulated_atomic_swap(left: &Path, right: &Path) -> std::io::Result<()> {
        let temporary = left
            .parent()
            .expect("fixture path should have a parent")
            .join(format!(".test-swap-{}", Uuid::new_v4()));
        fs::rename(left, &temporary)?;
        fs::rename(right, left)?;
        fs::rename(temporary, right)
    }

    #[test]
    fn update_install_atomically_exchanges_staged_and_installed_apps() {
        let root = env::temp_dir().join(format!(
            "atcontroller-atomic-update-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let target = root.join("ATController.app");
        let paths = update_replacement_paths(&root, &Uuid::new_v4().to_string());
        create_update_fixture_bundle(&target, "old");
        create_update_fixture_bundle(&paths.primary_recovery, "new");

        let replacement = install_staged_app_with_operations(
            &target,
            &paths,
            simulated_atomic_swap,
            |from: &Path, to: &Path| fs::rename(from, to),
        )
        .expect("atomic replacement should succeed");

        assert_eq!(replacement.method, AppReplacementMethod::AtomicSwap);
        assert_eq!(replacement.recovery_app, paths.primary_recovery);
        assert_eq!(update_fixture_identity(&target), "new");
        assert_eq!(update_fixture_identity(&replacement.recovery_app), "old");
        assert!(!paths.fallback_recovery.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn update_install_uses_checked_fallback_when_atomic_swap_is_unavailable() {
        let root = env::temp_dir().join(format!(
            "atcontroller-fallback-update-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let target = root.join("ATController.app");
        let paths = update_replacement_paths(&root, &Uuid::new_v4().to_string());
        create_update_fixture_bundle(&target, "old");
        create_update_fixture_bundle(&paths.primary_recovery, "new");

        let replacement = install_staged_app_with_operations(
            &target,
            &paths,
            |_left, _right| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "fixture has no atomic swap",
                ))
            },
            |from: &Path, to: &Path| fs::rename(from, to),
        )
        .expect("checked fallback replacement should succeed");

        assert_eq!(
            replacement.method,
            AppReplacementMethod::CheckedRenameFallback
        );
        assert_eq!(replacement.recovery_app, paths.fallback_recovery);
        assert_eq!(update_fixture_identity(&target), "new");
        assert_eq!(update_fixture_identity(&replacement.recovery_app), "old");
        assert!(!paths.primary_recovery.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_fallback_activation_restores_the_installed_app() {
        let root = env::temp_dir().join(format!(
            "atcontroller-fallback-restore-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let target = root.join("ATController.app");
        let paths = update_replacement_paths(&root, &Uuid::new_v4().to_string());
        create_update_fixture_bundle(&target, "old");
        create_update_fixture_bundle(&paths.primary_recovery, "new");
        let mut rename_count = 0_u8;

        let error = install_staged_app_with_operations(
            &target,
            &paths,
            |_left, _right| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "fixture has no atomic swap",
                ))
            },
            |from: &Path, to: &Path| {
                rename_count += 1;
                if rename_count == 2 {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "fixture activation failure",
                    ))
                } else {
                    fs::rename(from, to)
                }
            },
        )
        .expect_err("failed activation should be reported");

        assert!(format!("{error:#}").contains("previous ATController.app was restored"));
        assert_eq!(update_fixture_identity(&target), "old");
        assert_eq!(update_fixture_identity(&paths.primary_recovery), "new");
        assert!(!paths.fallback_recovery.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn checked_rollback_restores_or_reinstates_a_valid_target() {
        let root = env::temp_dir().join(format!(
            "atcontroller-checked-rollback-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let target = root.join("ATController.app");
        let recovery = root.join(".ATController.recovery.app");
        let scratch = root.join(".ATController.rollback.app");
        create_update_fixture_bundle(&target, "new");
        create_update_fixture_bundle(&recovery, "old");
        let mut rename_count = 0_u8;

        let error = restore_recovery_with_operations(
            &target,
            &recovery,
            &scratch,
            |_left, _right| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "fixture has no atomic swap",
                ))
            },
            |from: &Path, to: &Path| {
                rename_count += 1;
                if rename_count == 2 {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "fixture restore failure",
                    ))
                } else {
                    fs::rename(from, to)
                }
            },
        )
        .expect_err("failed rollback should be reported");

        assert!(format!("{error:#}").contains("failed update was returned"));
        assert_eq!(update_fixture_identity(&target), "new");
        assert_eq!(update_fixture_identity(&recovery), "old");
        assert!(!scratch.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_is_removed_only_after_health_confirmation() {
        let root = env::temp_dir().join(format!(
            "atcontroller-update-health-test-{}",
            Uuid::new_v4()
        ));
        let applications_dir = root.join("Applications");
        let update_state_dir = root.join("Application Support").join("updates");
        fs::create_dir_all(&applications_dir).expect("fixture applications directory should exist");
        fs::create_dir_all(&update_state_dir).expect("fixture update state directory should exist");
        let manifest_path = update_state_dir.join("pending-app-update.json");
        let manifest = PendingUpdateManifest {
            schema_version: UPDATE_MANIFEST_SCHEMA_VERSION,
            transaction_id: Uuid::new_v4().to_string(),
            expected_version: "1.2.3".to_string(),
            phase: PendingUpdatePhase::Installed,
        };
        let paths = update_replacement_paths(&applications_dir, &manifest.transaction_id);
        create_update_fixture_bundle(&paths.primary_recovery, "old");
        write_pending_update_manifest(&manifest_path, &manifest)
            .expect("pending update manifest should be written");

        let premature_cleanup =
            finalize_healthy_update(&manifest_path, &applications_dir, &manifest)
                .expect_err("recovery cleanup before health confirmation should fail");
        assert!(format!("{premature_cleanup:#}").contains("before launch health is confirmed"));
        assert!(paths.primary_recovery.exists());
        assert!(manifest_path.exists());

        mark_pending_update_healthy(&manifest_path, &manifest)
            .expect("health confirmation should be persisted");
        finalize_healthy_update(&manifest_path, &applications_dir, &manifest)
            .expect("healthy update recovery should be cleaned up");
        assert!(!paths.primary_recovery.exists());
        assert!(!manifest_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn diagnostics_redact_secrets_from_stdout_and_stderr() {
        let stdout = sanitize_env_diagnostics_stdout(
            "PATH=/usr/bin\nOPENAI_API_KEY=super-secret\n---\ncodex-cli 1.0\n",
        );
        let stderr = sanitize_env_diagnostics_stderr(
            "shell: export GITHUB_TOKEN=also-secret\nordinary warning\n",
        );
        assert!(stdout.contains("OPENAI_API_KEY=<redacted>"));
        assert!(!stdout.contains("super-secret"));
        assert!(stderr.contains("shell: export GITHUB_TOKEN=<redacted>"));
        assert!(!stderr.contains("also-secret"));
        assert!(stderr.contains("ordinary warning"));
    }

    #[test]
    fn shell_commands_use_codex_new_resume_and_fork_interfaces() {
        let session_id = "123e4567-e89b-12d3-a456-426614174000";
        let new_command = build_codex_shell_command(
            "/usr/local/bin/codex",
            "",
            TerminalSessionMode::New,
            false,
            Some(Path::new("/tmp/codex-home")),
        );
        assert!(new_command.contains("CODEX_HOME='/tmp/codex-home'"));
        assert!(new_command.contains(
            "'/usr/local/bin/codex' --sandbox workspace-write --ask-for-approval on-request"
        ));

        let resume_command = build_codex_shell_command(
            "/usr/local/bin/codex",
            session_id,
            TerminalSessionMode::Resumed,
            true,
            None,
        );
        assert!(resume_command.contains("--dangerously-bypass-approvals-and-sandbox resume"));
        assert!(resume_command.ends_with(&shell_escape_arg(session_id)));

        let fork_command = build_codex_shell_command(
            "/usr/local/bin/codex",
            session_id,
            TerminalSessionMode::Forked,
            true,
            None,
        );
        assert!(fork_command.contains("--dangerously-bypass-approvals-and-sandbox fork"));
        assert!(fork_command.ends_with(&shell_escape_arg(session_id)));
    }

    #[test]
    fn remote_terminal_commands_are_validated_before_reaching_the_login_shell() {
        let (ssh_command, post_connect) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh -p 2222 -J jump@example.com dev@remote-host"),
            Some("~/projects/example;literal"),
            "codex --sandbox workspace-write",
        )
        .expect("supported SSH command should be accepted");
        assert_eq!(
            shell_words::split(&ssh_command).expect("SSH command should remain canonical"),
            vec![
                "ssh",
                "-p",
                "2222",
                "-J",
                "jump@example.com",
                "dev@remote-host"
            ]
        );
        assert_eq!(
            post_connect.as_deref(),
            Some("cd \"$HOME\"/'projects/example;literal' && exec codex --sandbox workspace-write")
        );

        let (templated_command, templated_post_connect) = build_terminal_shell_command(
            WorkspaceKind::Ssh,
            None,
            Some("ssh dev@remote-host {CODEX_CMD}"),
            None,
            "codex --sandbox workspace-write",
        )
        .expect("final Codex placeholder should be accepted");
        assert_eq!(
            templated_command,
            "'ssh' 'dev@remote-host' exec codex --sandbox workspace-write"
        );
        assert!(templated_post_connect.is_none());

        for payload in [
            "ssh dev@remote-host & local-command",
            "ssh dev@remote-host; local-command",
            "ssh dev@remote-host $(local-command)",
            "ssh dev@remote-host > /tmp/output",
            "ssh dev@remote-host\nlocal-command",
        ] {
            assert!(
                build_terminal_shell_command(
                    WorkspaceKind::Ssh,
                    None,
                    Some(payload),
                    None,
                    "codex",
                )
                .is_err(),
                "previously saved unsafe command should fail closed: {payload}"
            );
            assert!(
                build_workspace_shell_command(
                    WorkspaceKind::Ssh,
                    "/bin/zsh",
                    None,
                    Some(payload),
                    None,
                )
                .is_err(),
                "unsafe workspace shell command should fail closed: {payload}"
            );
        }
    }

    #[test]
    fn rdev_launches_preserve_options_and_remove_template_from_plain_shells() {
        let command = "rdev ssh -p 8022 team/example-env {CODEX_CMD}";
        let (thread_command, post_connect) = build_terminal_shell_command(
            WorkspaceKind::Rdev,
            Some(command),
            None,
            None,
            "codex --sandbox workspace-write",
        )
        .expect("supported rdev command should be accepted");
        assert_eq!(
            shell_words::split(&thread_command).expect("rdev command should remain canonical"),
            vec![
                "rdev",
                "ssh",
                "-p",
                "8022",
                "team/example-env",
                "--non-tmux",
                "exec",
                "codex",
                "--sandbox",
                "workspace-write",
            ]
        );
        assert!(post_connect.is_none());

        let (shell_command, shell_post_connect) = build_workspace_shell_command(
            WorkspaceKind::Rdev,
            "/bin/zsh",
            Some(command),
            None,
            None,
        )
        .expect("supported rdev workspace shell should be accepted");
        assert_eq!(
            shell_words::split(shell_command.as_deref().expect("command should exist"))
                .expect("rdev command should parse"),
            vec![
                "rdev",
                "ssh",
                "-p",
                "8022",
                "team/example-env",
                "--non-tmux"
            ]
        );
        assert!(shell_post_connect.is_none());
    }

    #[test]
    fn reads_recursive_codex_session_metadata_and_completion() {
        let _lock = storage::test_env_lock()
            .lock()
            .expect("environment lock should not be poisoned");
        let root = env::temp_dir().join(format!(
            "atcontroller-codex-session-test-{}",
            Uuid::new_v4()
        ));
        let _guard = EnvironmentGuard::set(&root);
        let session_id = "123e4567-e89b-12d3-a456-426614174000";
        let workspace = root.join("workspace");
        let nested = workspace.join("nested");
        fs::create_dir_all(&nested).expect("workspace should exist");
        let path = write_session(
            &root,
            session_id,
            &[
                serde_json::json!({
                    "timestamp": "2026-07-28T17:00:00Z",
                    "type": "session_meta",
                    "payload": {
                        "id": session_id,
                        "timestamp": "2026-07-28T17:00:00Z",
                        "cwd": workspace,
                        "thread_source": "user",
                        "git": { "branch": "main" }
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-28T17:00:01Z",
                    "type": "event_msg",
                    "payload": { "type": "user_message", "message": "Ship the release" }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-28T17:00:02Z",
                    "type": "turn_context",
                    "payload": { "cwd": nested }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-28T17:00:03Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "task_complete",
                        "completed_at": "2026-07-28T17:00:03Z",
                        "last_agent_message": "Release is ready"
                    }
                }),
            ],
        );

        let summary = read_codex_session_summary(&path)
            .expect("summary should parse")
            .expect("summary should exist");
        assert_eq!(summary.session_id, session_id);
        assert_eq!(summary.first_prompt.as_deref(), Some("Ship the release"));
        assert_eq!(summary.git_branch.as_deref(), Some("main"));
        let expected_cwd = canonicalize_path_or_original(nested.to_string_lossy().as_ref());
        assert_eq!(
            latest_codex_session_cwd_from_jsonl(&path).as_deref(),
            Some(expected_cwd.as_str())
        );
        let completion = latest_codex_turn_completion_from_jsonl(&path, session_id)
            .expect("completion should parse");
        assert!(completion.completion_index > 0);
        assert_eq!(completion.status, "Succeeded");
        assert!(completion.has_meaningful_output);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_sparse_multi_gigabyte_sessions_from_bounded_windows() {
        let _lock = storage::test_env_lock()
            .lock()
            .expect("environment lock should not be poisoned");
        let root = env::temp_dir().join(format!(
            "atcontroller-codex-large-session-test-{}",
            Uuid::new_v4()
        ));
        let _guard = EnvironmentGuard::set(&root);
        let session_id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("workspace should exist");
        let session_directory = root
            .join("codex-home")
            .join("sessions")
            .join("2026")
            .join("07")
            .join("28");
        fs::create_dir_all(&session_directory).expect("session directory should exist");
        let path =
            session_directory.join(format!("rollout-2026-07-28T10-00-00-{session_id}.jsonl"));
        let mut file = File::create(&path).expect("session fixture should be created");
        let head = [
            serde_json::json!({
                "timestamp": "2026-07-28T17:00:00Z",
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "cwd": workspace,
                    "thread_source": "user"
                }
            }),
            serde_json::json!({
                "timestamp": "2026-07-28T17:00:01Z",
                "type": "event_msg",
                "payload": { "type": "user_message", "message": "Bound the parser" }
            }),
        ]
        .into_iter()
        .map(|entry| serde_json::to_string(&entry).expect("entry should serialize"))
        .collect::<Vec<_>>()
        .join("\n");
        file.write_all(format!("{head}\n").as_bytes())
            .expect("session head should be written");
        let sparse_tail_offset = 3_u64 * 1024 * 1024 * 1024;
        file.seek(SeekFrom::Start(sparse_tail_offset))
            .expect("sparse seek should succeed");
        let tail = serde_json::json!({
            "timestamp": "2026-07-28T17:05:00Z",
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "last_agent_message": "Bounded parsing succeeded"
            }
        });
        file.write_all(
            format!(
                "\n{}\n",
                serde_json::to_string(&tail).expect("tail should serialize")
            )
            .as_bytes(),
        )
        .expect("session tail should be written");
        drop(file);

        let summary = read_codex_session_summary(&path)
            .expect("summary should parse")
            .expect("summary should exist");
        assert_eq!(summary.first_prompt.as_deref(), Some("Bound the parser"));
        assert_eq!(
            summary.last_agent_message.as_deref(),
            Some("Bounded parsing succeeded")
        );
        let completion = latest_codex_turn_completion_from_jsonl(&path, session_id)
            .expect("completion should parse");
        assert!(completion.completion_index > sparse_tail_offset);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incremental_jsonl_watch_reads_only_appended_lines() {
        let root = env::temp_dir().join(format!(
            "atcontroller-codex-incremental-watch-test-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture directory should exist");
        let path =
            root.join("rollout-2026-07-28T10-00-00-dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl");
        let mut file = File::create(&path).expect("fixture should be created");
        file.seek(SeekFrom::Start(32 * 1024 * 1024 - 1))
            .expect("sparse seek should succeed");
        file.write_all(b"\n")
            .expect("sparse fixture should end at a line boundary");
        drop(file);

        let mut cursor = CodexJsonlWatchCursor::at_end(&path);
        let initial_offset = cursor.offset;
        let cwd = root.join("nested");
        fs::create_dir_all(&cwd).expect("cwd should exist");
        let appended = [
            serde_json::json!({
                "timestamp": "2026-07-28T17:00:02Z",
                "type": "turn_context",
                "payload": { "cwd": cwd }
            }),
            serde_json::json!({
                "timestamp": "2026-07-28T17:00:03Z",
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "last_agent_message": "Incremental read complete"
                }
            }),
        ]
        .into_iter()
        .map(|entry| serde_json::to_string(&entry).expect("entry should serialize"))
        .collect::<Vec<_>>()
        .join("\n")
            + "\n";
        OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("fixture should reopen")
            .write_all(appended.as_bytes())
            .expect("delta should append");

        let delta = read_incremental_codex_jsonl(
            &path,
            "dddddddd-dddd-dddd-dddd-dddddddddddd",
            &mut cursor,
        )
        .expect("incremental read should succeed");
        assert_eq!(delta.bytes_read, appended.len());
        assert_eq!(cursor.offset, initial_offset + appended.len() as u64);
        let expected_cwd = canonicalize_path_or_original(cwd.to_string_lossy().as_ref());
        assert_eq!(delta.latest_cwd.as_deref(), Some(expected_cwd.as_str()));
        assert_eq!(delta.completions.len(), 1);
        assert!(delta.completions[0].completion_index > initial_offset);

        let idle_delta = read_incremental_codex_jsonl(
            &path,
            "dddddddd-dddd-dddd-dddd-dddddddddddd",
            &mut cursor,
        )
        .expect("idle read should succeed");
        assert_eq!(idle_delta.bytes_read, 0);
        assert!(idle_delta.completions.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fork_discovery_excludes_subagent_sessions() {
        let _lock = storage::test_env_lock()
            .lock()
            .expect("environment lock should not be poisoned");
        let root = env::temp_dir().join(format!("atcontroller-codex-fork-test-{}", Uuid::new_v4()));
        let _guard = EnvironmentGuard::set(&root);
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("workspace should exist");
        let parent_id = "123e4567-e89b-12d3-a456-426614174000";
        let user_child_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let subagent_child_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        write_session(
            &root,
            user_child_id,
            &[serde_json::json!({
                "timestamp": "2026-07-28T17:00:00Z",
                "type": "session_meta",
                "payload": {
                    "id": user_child_id,
                    "timestamp": "2026-07-28T17:00:00Z",
                    "cwd": workspace,
                    "thread_source": "user",
                    "forked_from_id": parent_id
                }
            })],
        );
        write_session(
            &root,
            subagent_child_id,
            &[serde_json::json!({
                "timestamp": "2026-07-28T17:00:01Z",
                "type": "session_meta",
                "payload": {
                    "id": subagent_child_id,
                    "timestamp": "2026-07-28T17:00:01Z",
                    "cwd": workspace,
                    "thread_source": "subagent",
                    "parent_thread_id": parent_id,
                    "forked_from_id": parent_id
                }
            })],
        );

        assert_eq!(
            known_fork_child_session_ids(parent_id).expect("children should resolve"),
            vec![user_child_id.to_string()]
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_recent_index_falls_back_to_full_lookup_for_old_sessions() {
        let _lock = storage::test_env_lock()
            .lock()
            .expect("environment lock should not be poisoned");
        let root = env::temp_dir().join(format!(
            "atcontroller-codex-old-session-index-test-{}",
            Uuid::new_v4()
        ));
        let _guard = EnvironmentGuard::set(&root);
        let session_id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("workspace should exist");
        let old_directory = root
            .join("codex-home")
            .join("sessions")
            .join("2020")
            .join("01")
            .join("02");
        fs::create_dir_all(&old_directory).expect("old session directory should exist");
        let path = old_directory.join(format!("rollout-2020-01-02T10-00-00-{session_id}.jsonl"));
        fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::to_string(&serde_json::json!({
                    "timestamp": "2020-01-02T18:00:00Z",
                    "type": "session_meta",
                    "payload": {
                        "id": session_id,
                        "cwd": workspace,
                        "thread_source": "user"
                    }
                }))
                .expect("entry should serialize")
            ),
        )
        .expect("old session should be written");

        codex_session_paths_near(Utc::now()).expect("partial index should initialize");
        let summary = find_codex_session_summary(session_id)
            .expect("lookup should succeed")
            .expect("old session should be found after a full fallback");
        assert_eq!(summary.path, path);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn aborted_turns_are_reported_as_failed() {
        let entry: CodexJsonlEntry = serde_json::from_value(serde_json::json!({
            "timestamp": "2026-07-28T17:00:03Z",
            "type": "event_msg",
            "payload": { "type": "turn_aborted", "reason": "interrupted" }
        }))
        .expect("entry should deserialize");
        let completion =
            classify_codex_turn_completion_entry(&entry).expect("completion should classify");
        assert_eq!(completion.status, "Failed");
        assert!(!completion.has_meaningful_output);
    }

    #[test]
    fn extracts_resume_hint_from_terminal_output() {
        assert_eq!(
            extract_codex_resume_session_id(
                "To continue this session, run: codex resume 123e4567-e89b-12d3-a456-426614174000"
            )
            .as_deref(),
            Some("123e4567-e89b-12d3-a456-426614174000")
        );
    }
}
