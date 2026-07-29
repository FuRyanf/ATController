use std::io::{self, Read};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Result};

use crate::models::{GitBranchEntry, GitInfo, GitPullForNewThreadResult, GitWorkspaceStatus};

const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_NETWORK_PULL_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(20);
const GIT_PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const GIT_CAPTURE_LIMIT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
struct CapturedStream {
    bytes: Vec<u8>,
    total_bytes: u64,
    truncated: bool,
}

#[derive(Debug)]
struct CommandOutput {
    status: ExitStatus,
    stdout: CapturedStream,
    stderr: CapturedStream,
}

#[derive(Debug, Clone, Copy)]
enum CapturedStreamKind {
    Stdout,
    Stderr,
}

type CaptureMessage = (CapturedStreamKind, io::Result<CapturedStream>);

struct CaptureCollector {
    receiver: Receiver<CaptureMessage>,
    stdout: Option<io::Result<CapturedStream>>,
    stderr: Option<io::Result<CapturedStream>>,
}

impl CaptureCollector {
    fn new(receiver: Receiver<CaptureMessage>) -> Self {
        Self {
            receiver,
            stdout: None,
            stderr: None,
        }
    }

    fn is_complete(&self) -> bool {
        self.stdout.is_some() && self.stderr.is_some()
    }

    fn collect_for(&mut self, timeout: Duration) -> Result<bool> {
        let deadline = Instant::now() + timeout;
        while !self.is_complete() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            match self.receiver.recv_timeout(remaining) {
                Ok((CapturedStreamKind::Stdout, result)) => self.stdout = Some(result),
                Ok((CapturedStreamKind::Stderr, result)) => self.stderr = Some(result),
                Err(RecvTimeoutError::Timeout) => return Ok(false),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(anyhow!("Git output reader stopped unexpectedly"));
                }
            }
        }
        Ok(true)
    }

    fn finish(mut self) -> Result<(CapturedStream, CapturedStream)> {
        if !self.collect_for(GIT_PIPE_DRAIN_TIMEOUT)? {
            return Err(anyhow!("Timed out while draining Git command output"));
        }
        let stdout = self
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Git stdout reader did not finish"))??;
        let stderr = self
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Git stderr reader did not finish"))??;
        Ok((stdout, stderr))
    }
}

#[derive(Debug, Clone)]
struct GitWorktreeEntry {
    path: PathBuf,
    branch: Option<String>,
}

fn drain_bounded<R: Read>(mut reader: R) -> io::Result<CapturedStream> {
    let mut bytes = Vec::with_capacity(GIT_CAPTURE_LIMIT_BYTES.min(64 * 1024));
    let mut total_bytes = 0u64;
    let mut buffer = [0u8; 16 * 1024];

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(read as u64);
        let remaining = GIT_CAPTURE_LIMIT_BYTES.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
    }

    Ok(CapturedStream {
        truncated: total_bytes > bytes.len() as u64,
        bytes,
        total_bytes,
    })
}

fn spawn_capture_reader<R>(
    reader: R,
    kind: CapturedStreamKind,
    sender: mpsc::Sender<CaptureMessage>,
) where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let _ = sender.send((kind, drain_bounded(reader)));
    });
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn kill_process_group(process_id: u32) {
    if let Ok(process_id) = i32::try_from(process_id) {
        // The command is spawned as its own process-group leader. Killing the
        // group also terminates Git transports that inherited the output pipes.
        unsafe {
            libc::kill(-process_id, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_process_id: u32) {}

fn terminate_and_reap(child: &mut std::process::Child) -> io::Result<()> {
    kill_process_group(child.id());
    let _ = child.kill();
    child.wait().map(|_| ())
}

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
    label: &str,
) -> Result<CommandOutput> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("{label} did not expose stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("{label} did not expose stderr"))?;
    let (sender, receiver) = mpsc::channel();
    spawn_capture_reader(stdout, CapturedStreamKind::Stdout, sender.clone());
    spawn_capture_reader(stderr, CapturedStreamKind::Stderr, sender);
    let mut captures = CaptureCollector::new(receiver);
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !captures.collect_for(GIT_PIPE_DRAIN_TIMEOUT)? {
                    return Err(anyhow!(
                        "{label} exited, but its output pipes did not close promptly"
                    ));
                }
                let (stdout, stderr) = captures.finish()?;
                return Ok(CommandOutput {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {}
            Err(error) => {
                let cleanup_error = terminate_and_reap(&mut child).err();
                let _ = captures.collect_for(GIT_PIPE_DRAIN_TIMEOUT);
                return Err(match cleanup_error {
                    Some(cleanup_error) => anyhow!(
                        "{label} wait failed: {error}; process cleanup also failed: {cleanup_error}"
                    ),
                    None => anyhow!("{label} wait failed: {error}"),
                });
            }
        }
        if started.elapsed() >= timeout {
            let cleanup_error = terminate_and_reap(&mut child).err();
            let _ = captures.collect_for(GIT_PIPE_DRAIN_TIMEOUT);
            let timeout_ms = timeout.as_millis();
            return Err(match cleanup_error {
                Some(cleanup_error) => anyhow!(
                    "{label} timed out after {timeout_ms}ms; process cleanup failed: {cleanup_error}"
                ),
                None => anyhow!("{label} timed out after {timeout_ms}ms"),
            });
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        std::thread::sleep(GIT_WAIT_POLL_INTERVAL.min(remaining));
    }
}

fn complete_stdout(output: &CommandOutput, args: &[&str]) -> Result<String> {
    if output.stdout.truncated {
        return Err(anyhow!(
            "git {:?} produced {} bytes of stdout, exceeding the {} byte capture limit",
            args,
            output.stdout.total_bytes,
            GIT_CAPTURE_LIMIT_BYTES
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout.bytes)
        .trim()
        .to_string())
}

fn validate_branch_name(branch_name: &str) -> Result<&str> {
    let normalized = branch_name.trim();
    if normalized.is_empty() {
        return Err(anyhow!("Branch name cannot be empty"));
    }
    if normalized.starts_with('-') {
        return Err(anyhow!("Branch name cannot start with '-'"));
    }
    if normalized.contains('\0') {
        return Err(anyhow!("Branch name cannot contain NUL bytes"));
    }
    Ok(normalized)
}

fn run_git(workspace_path: &str, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = run_command_with_timeout(command, GIT_LOCAL_TIMEOUT, "git command")?;

    if !output.status.success() {
        return Ok(String::new());
    }

    complete_stdout(&output, args)
}

fn run_git_checked(workspace_path: &str, args: &[&str]) -> Result<String> {
    run_git_checked_with_timeout(workspace_path, args, GIT_LOCAL_TIMEOUT)
}

fn run_git_checked_with_timeout(
    workspace_path: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = run_command_with_timeout(command, timeout, "git command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr.bytes)
            .trim()
            .to_string();
        let truncation_note = output.stderr.truncated.then(|| {
            format!(
                " (stderr truncated after {} of {} bytes)",
                output.stderr.bytes.len(),
                output.stderr.total_bytes
            )
        });
        let message = if stderr.is_empty() {
            format!("git {:?} failed", args)
        } else {
            format!("{stderr}{}", truncation_note.as_deref().unwrap_or_default())
        };
        return Err(anyhow!(message));
    }

    complete_stdout(&output, args)
}

fn run_git_success(workspace_path: &str, args: &[&str]) -> Result<bool> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = run_command_with_timeout(command, GIT_LOCAL_TIMEOUT, "git command")?;
    Ok(output.status.success())
}

fn is_git_repo(workspace_path: &str) -> Result<bool> {
    let is_repo = run_git(workspace_path, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(is_repo.trim() == "true")
}

fn resolve_git_dir(workspace_path: &str) -> Result<Option<PathBuf>> {
    let git_dir_raw = run_git_checked(workspace_path, &["rev-parse", "--git-dir"])?;
    if git_dir_raw.trim().is_empty() {
        return Ok(None);
    }

    let git_dir = PathBuf::from(git_dir_raw.trim());
    if git_dir.is_absolute() {
        return Ok(Some(git_dir));
    }
    Ok(Some(PathBuf::from(workspace_path).join(git_dir)))
}

fn has_repository_operation_in_progress(workspace_path: &str) -> Result<bool> {
    let Some(git_dir) = resolve_git_dir(workspace_path)? else {
        return Ok(false);
    };

    let head_markers = [
        "MERGE_HEAD",
        "REBASE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
    ];
    if head_markers
        .iter()
        .any(|marker| fs::metadata(git_dir.join(marker)).is_ok())
    {
        return Ok(true);
    }

    let rebase_markers = [
        "rebase-merge/head-name",
        "rebase-merge/onto",
        "rebase-merge/msgnum",
        "rebase-apply/head-name",
        "rebase-apply/onto",
        "rebase-apply/rebasing",
        "rebase-apply/applying",
    ];
    Ok(rebase_markers
        .iter()
        .any(|marker| fs::metadata(git_dir.join(marker)).is_ok()))
}

fn has_tracked_workspace_changes(workspace_path: &str) -> Result<bool> {
    let unstaged_clean = run_git_success(workspace_path, &["diff", "--quiet"])?;
    let staged_clean = run_git_success(workspace_path, &["diff", "--cached", "--quiet"])?;
    Ok(!(unstaged_clean && staged_clean))
}

fn has_upstream(workspace_path: &str) -> Result<bool> {
    let upstream = run_git(
        workspace_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )?;
    Ok(!upstream.trim().is_empty())
}

fn local_branch_exists(workspace_path: &str, branch_name: &str) -> Result<bool> {
    let ref_name = format!("refs/heads/{branch_name}");
    run_git_success(
        workspace_path,
        &["show-ref", "--verify", "--quiet", &ref_name],
    )
}

fn remote_tracking_branch_exists(workspace_path: &str, remote_branch: &str) -> Result<bool> {
    let ref_name = format!("refs/remotes/{remote_branch}");
    run_git_success(
        workspace_path,
        &["show-ref", "--verify", "--quiet", &ref_name],
    )
}

fn branch_from_remote_head(remote_head: &str, remote_name: &str) -> Option<String> {
    let trimmed = remote_head.trim();
    if trimmed.is_empty() {
        return None;
    }

    let remote_prefix = format!("{remote_name}/");
    trimmed
        .strip_prefix(&remote_prefix)
        .filter(|branch| !branch.trim().is_empty())
        .map(|branch| branch.to_string())
}

fn origin_default_branch(workspace_path: &str) -> Result<Option<String>> {
    let remote_head = run_git(
        workspace_path,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )?;
    let Some(branch) = branch_from_remote_head(&remote_head, "origin") else {
        return Ok(None);
    };

    let normalized = validate_branch_name(&branch)?;
    run_git_checked(
        workspace_path,
        &["check-ref-format", "--branch", normalized],
    )?;
    Ok(Some(normalized.to_string()))
}

fn default_pull_branch(workspace_path: &str) -> Result<Option<String>> {
    if let Some(branch) = origin_default_branch(workspace_path)? {
        return Ok(Some(branch));
    }

    for branch in ["master", "main"] {
        let remote_branch = format!("origin/{branch}");
        if local_branch_exists(workspace_path, branch)?
            || remote_tracking_branch_exists(workspace_path, &remote_branch)?
        {
            return Ok(Some(branch.to_string()));
        }
    }

    Ok(None)
}

fn checkout_pull_branch(workspace_path: &str, branch_name: &str) -> Result<()> {
    let normalized = validate_branch_name(branch_name)?;
    run_git_checked(
        workspace_path,
        &["check-ref-format", "--branch", normalized],
    )?;

    let current_branch = run_git_checked(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if current_branch == normalized {
        return Ok(());
    }

    if let Err(error) = run_git_checked(workspace_path, &["checkout", normalized]) {
        if local_branch_exists(workspace_path, normalized)? {
            return Err(error);
        }

        let remote_branch = format!("origin/{normalized}");
        if remote_tracking_branch_exists(workspace_path, &remote_branch)? {
            run_git_checked(
                workspace_path,
                &["checkout", "--track", "-b", normalized, &remote_branch],
            )
            .map(|_| ())
        } else {
            Err(error)
        }
    } else {
        Ok(())
    }
}

fn normalize_path_for_compare(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn paths_match(left: &Path, right: &Path) -> bool {
    normalize_path_for_compare(left) == normalize_path_for_compare(right)
}

fn short_branch_name(branch_ref: &str) -> &str {
    branch_ref
        .trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(branch_ref.trim())
}

fn list_worktrees(workspace_path: &str) -> Result<Vec<GitWorktreeEntry>> {
    let output = run_git(workspace_path, &["worktree", "list", "--porcelain"])?;
    if output.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let mut current_path: Option<PathBuf> = None;
    let mut current_branch: Option<String> = None;

    let push_current = |entries: &mut Vec<GitWorktreeEntry>,
                        current_path: &mut Option<PathBuf>,
                        current_branch: &mut Option<String>| {
        if let Some(path) = current_path.take() {
            entries.push(GitWorktreeEntry {
                path,
                branch: current_branch.take(),
            });
        } else {
            current_branch.take();
        }
    };

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            push_current(&mut entries, &mut current_path, &mut current_branch);
            continue;
        }

        if let Some(path) = trimmed.strip_prefix("worktree ") {
            push_current(&mut entries, &mut current_path, &mut current_branch);
            current_path = Some(PathBuf::from(path.trim()));
            continue;
        }

        if let Some(branch) = trimmed.strip_prefix("branch ") {
            current_branch = Some(short_branch_name(branch).to_string());
        }
    }

    push_current(&mut entries, &mut current_path, &mut current_branch);

    Ok(entries)
}

fn resolve_current_worktree_root(workspace_path: &str) -> Result<PathBuf> {
    let top_level = run_git_checked(workspace_path, &["rev-parse", "--show-toplevel"])?;
    if top_level.trim().is_empty() {
        return Ok(PathBuf::from(workspace_path));
    }
    Ok(PathBuf::from(top_level.trim()))
}

fn canonicalize_path_or_original(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn derive_linked_worktree_label(entry: &GitWorktreeEntry) -> Option<String> {
    let basename = entry
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let branch = entry
        .branch
        .as_deref()
        .map(short_branch_name)
        .map(str::to_string);

    match (basename, branch) {
        (Some(base), Some(branch_name)) if base != branch_name => Some(base),
        (Some(base), _) => Some(base),
        (None, Some(branch_name)) => Some(branch_name),
        (None, None) => None,
    }
}

fn short_head_commit(workspace_path: &str) -> Result<Option<String>> {
    let commit = run_git(workspace_path, &["rev-parse", "--short", "HEAD"])?;
    if commit.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(commit.trim().to_string()))
}

pub fn get_git_info(workspace_path: &str) -> Result<Option<GitInfo>> {
    if !is_git_repo(workspace_path)? {
        return Ok(None);
    }

    let mut branch = run_git(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() {
        return Ok(None);
    }

    let short_hash = run_git(workspace_path, &["rev-parse", "--short", "HEAD"])?;
    if branch == "HEAD" && !short_hash.is_empty() {
        branch = format!("(detached at {short_hash})");
    }
    let status = run_git(workspace_path, &["status", "--porcelain"])?;
    let is_dirty = !status.trim().is_empty();
    let ahead_behind = run_git(
        workspace_path,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )?;
    let (ahead, behind) = parse_ahead_behind(&ahead_behind);
    let current_worktree_root = resolve_current_worktree_root(workspace_path)?;
    let worktrees = list_worktrees(workspace_path)?;
    let (is_main_worktree, worktree_label, worktree_path) = worktrees
        .iter()
        .enumerate()
        .find(|(_, entry)| paths_match(&entry.path, &current_worktree_root))
        .map(|(index, entry)| {
            if index == 0 {
                (true, None, None)
            } else {
                (
                    false,
                    derive_linked_worktree_label(entry),
                    Some(canonicalize_path_or_original(&entry.path)),
                )
            }
        })
        .unwrap_or((true, None, None));

    Ok(Some(GitInfo {
        branch,
        short_hash,
        is_dirty,
        ahead,
        behind,
        is_main_worktree,
        worktree_label,
        worktree_path,
    }))
}

pub fn capture_patch_diff(workspace_path: &str) -> Result<String> {
    run_git(workspace_path, &["diff"])
}

pub fn list_branches(workspace_path: &str) -> Result<Vec<GitBranchEntry>> {
    if !is_git_repo(workspace_path)? {
        return Ok(Vec::new());
    }

    let current_branch = run_git(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let refs = run_git(
        workspace_path,
        &[
            "for-each-ref",
            "refs/heads/",
            "--format=%(refname:short)\t%(committerdate:unix)",
            "--sort=-committerdate",
        ],
    )?;

    let mut branches = Vec::new();
    for line in refs.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, '\t');
        let name = parts.next().unwrap_or_default().trim().to_string();
        if name.is_empty() {
            continue;
        }
        let last_commit_unix = parts
            .next()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(0);
        branches.push(GitBranchEntry {
            is_current: name == current_branch,
            name,
            last_commit_unix,
        });
    }

    Ok(branches)
}

pub fn workspace_status(workspace_path: &str) -> Result<GitWorkspaceStatus> {
    if !is_git_repo(workspace_path)? {
        return Ok(GitWorkspaceStatus {
            is_dirty: false,
            uncommitted_files: 0,
            insertions: 0,
            deletions: 0,
        });
    }

    let status = run_git(workspace_path, &["status", "--porcelain"])?;
    let uncommitted_files = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as u32;

    let numstat = run_git(workspace_path, &["diff", "--numstat"])?;
    let mut insertions = 0u32;
    let mut deletions = 0u32;

    for line in numstat.lines() {
        let mut fields = line.split_whitespace();
        let Some(ins) = fields.next() else {
            continue;
        };
        let Some(del) = fields.next() else {
            continue;
        };
        if let Ok(value) = ins.parse::<u32>() {
            insertions = insertions.saturating_add(value);
        }
        if let Ok(value) = del.parse::<u32>() {
            deletions = deletions.saturating_add(value);
        }
    }

    Ok(GitWorkspaceStatus {
        is_dirty: uncommitted_files > 0,
        uncommitted_files,
        insertions,
        deletions,
    })
}

pub fn checkout_branch(workspace_path: &str, branch_name: &str) -> Result<()> {
    let normalized = validate_branch_name(branch_name)?;
    run_git_checked(
        workspace_path,
        &["check-ref-format", "--branch", normalized],
    )?;
    run_git_checked(workspace_path, &["checkout", normalized]).map(|_| ())
}

pub fn git_pull_master_for_new_thread(workspace_path: &str) -> Result<GitPullForNewThreadResult> {
    if !is_git_repo(workspace_path)? {
        return Ok(GitPullForNewThreadResult {
            outcome: "skipped".to_string(),
            message: "Skipped git pull: this project is not a git repository.".to_string(),
        });
    }

    if has_repository_operation_in_progress(workspace_path)? {
        return Ok(GitPullForNewThreadResult {
            outcome: "skipped".to_string(),
            message: "Skipped git pull: repository is in merge/rebase state.".to_string(),
        });
    }

    if has_tracked_workspace_changes(workspace_path)? {
        return Ok(GitPullForNewThreadResult {
            outcome: "skipped".to_string(),
            message: "Skipped git pull: tracked files have local changes. Commit, stash, or discard them first."
                .to_string(),
        });
    }

    let Some(pull_branch) = default_pull_branch(workspace_path)? else {
        return Ok(GitPullForNewThreadResult {
            outcome: "skipped".to_string(),
            message: "Skipped git pull: no default branch found to pull.".to_string(),
        });
    };

    if let Err(error) = checkout_pull_branch(workspace_path, &pull_branch) {
        return Ok(GitPullForNewThreadResult {
            outcome: "failed".to_string(),
            message: format!("Git checkout failed: {error}"),
        });
    }

    if !has_upstream(workspace_path)? {
        return Ok(GitPullForNewThreadResult {
            outcome: "skipped".to_string(),
            message: format!("Skipped git pull: {pull_branch} has no upstream tracking branch."),
        });
    }

    let before_pull_commit = short_head_commit(workspace_path)?;

    if let Err(error) = run_git_checked_with_timeout(
        workspace_path,
        &["pull", "--ff-only"],
        GIT_NETWORK_PULL_TIMEOUT,
    ) {
        return Ok(GitPullForNewThreadResult {
            outcome: "failed".to_string(),
            message: format!("Git pull failed: {error}"),
        });
    }

    let after_pull_commit = short_head_commit(workspace_path)?;
    let message = match after_pull_commit {
        Some(commit) => {
            if before_pull_commit.as_deref() == Some(commit.as_str()) {
                format!("{pull_branch} already up to date at commit {commit}.")
            } else {
                format!("Checked out {pull_branch} and pulled latest changes to commit {commit}.")
            }
        }
        None => format!("Checked out {pull_branch} and pulled latest changes."),
    };

    Ok(GitPullForNewThreadResult {
        outcome: "pulled".to_string(),
        message,
    })
}

fn parse_ahead_behind(input: &str) -> (u32, u32) {
    let mut parts = input.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    (ahead, behind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::Path;
    use std::process::Command;

    const SUBPROCESS_STDOUT_BYTES: &str = "ATCONTROLLER_TEST_STDOUT_BYTES";
    const SUBPROCESS_STDERR_BYTES: &str = "ATCONTROLLER_TEST_STDERR_BYTES";
    const SUBPROCESS_SLEEP_MS: &str = "ATCONTROLLER_TEST_SLEEP_MS";

    fn write_repeated<W: Write>(writer: &mut W, byte: u8, total: usize) {
        let chunk = vec![byte; 16 * 1024];
        let mut remaining = total;
        while remaining > 0 {
            let write_len = remaining.min(chunk.len());
            writer
                .write_all(&chunk[..write_len])
                .expect("subprocess fixture output should be writable");
            remaining -= write_len;
        }
        writer
            .flush()
            .expect("subprocess fixture output should flush");
    }

    fn subprocess_fixture_command(
        stdout_bytes: usize,
        stderr_bytes: usize,
        sleep: Duration,
    ) -> Command {
        let mut command =
            Command::new(std::env::current_exe().expect("test executable should resolve"));
        command
            .args([
                "--exact",
                "git_tools::tests::subprocess_output_fixture",
                "--nocapture",
            ])
            .env(SUBPROCESS_STDOUT_BYTES, stdout_bytes.to_string())
            .env(SUBPROCESS_STDERR_BYTES, stderr_bytes.to_string())
            .env(SUBPROCESS_SLEEP_MS, sleep.as_millis().to_string());
        command
    }

    #[test]
    fn subprocess_output_fixture() {
        let Some(stdout_bytes) = std::env::var(SUBPROCESS_STDOUT_BYTES)
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
        else {
            return;
        };
        let stderr_bytes = std::env::var(SUBPROCESS_STDERR_BYTES)
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_default();
        let sleep_ms = std::env::var(SUBPROCESS_SLEEP_MS)
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_default();

        write_repeated(&mut std::io::stdout().lock(), b'O', stdout_bytes);
        write_repeated(&mut std::io::stderr().lock(), b'E', stderr_bytes);
        std::thread::sleep(Duration::from_millis(sleep_ms));
    }

    #[test]
    fn concurrently_drains_output_larger_than_pipe_buffers() {
        let stream_bytes = 512 * 1024;
        let output = run_command_with_timeout(
            subprocess_fixture_command(stream_bytes, stream_bytes, Duration::ZERO),
            Duration::from_secs(5),
            "large-output fixture",
        )
        .expect("large concurrent output should not deadlock");

        assert!(output.status.success());
        assert!(!output.stdout.truncated);
        assert!(!output.stderr.truncated);
        assert!(output.stdout.total_bytes >= stream_bytes as u64);
        assert!(output.stderr.total_bytes >= stream_bytes as u64);
    }

    #[test]
    fn drains_all_output_while_bounding_captured_memory() {
        let emitted_bytes = GIT_CAPTURE_LIMIT_BYTES + 128 * 1024;
        let output = run_command_with_timeout(
            subprocess_fixture_command(emitted_bytes, 0, Duration::ZERO),
            Duration::from_secs(5),
            "bounded-output fixture",
        )
        .expect("bounded output capture should still drain the child");

        assert!(output.status.success());
        assert!(output.stdout.truncated);
        assert_eq!(output.stdout.bytes.len(), GIT_CAPTURE_LIMIT_BYTES);
        assert!(output.stdout.total_bytes >= emitted_bytes as u64);
    }

    #[test]
    fn timeout_terminates_and_reaps_the_command() {
        let started = Instant::now();
        let error = run_command_with_timeout(
            subprocess_fixture_command(0, 0, Duration::from_secs(10)),
            Duration::from_millis(100),
            "timeout fixture",
        )
        .expect_err("sleeping command should time out");

        assert!(error.to_string().contains("timed out after 100ms"));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timed out process should be terminated promptly"
        );
    }

    fn git(workdir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(workdir)
            .status()
            .expect("git command should execute");
        assert!(status.success(), "git {:?} failed", args);
    }

    fn configure_test_author(workdir: &Path) {
        git(workdir, &["config", "user.email", "test@example.com"]);
        git(workdir, &["config", "user.name", "ATController Test"]);
    }

    #[test]
    fn detects_git_branch_and_dirty_state() {
        let temp_repo =
            std::env::temp_dir().join(format!("atcontroller-git-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_repo).expect("failed to create temp repo");

        git(&temp_repo, &["init"]);
        git(&temp_repo, &["config", "user.email", "test@example.com"]);
        git(&temp_repo, &["config", "user.name", "ATController Test"]);

        fs::write(temp_repo.join("README.md"), "initial\n").expect("failed to write file");
        git(&temp_repo, &["add", "README.md"]);
        git(&temp_repo, &["commit", "-m", "initial"]);

        let clean = get_git_info(temp_repo.to_string_lossy().as_ref())
            .expect("git info should resolve")
            .expect("repo should be detected");
        assert!(!clean.branch.is_empty());
        assert!(!clean.short_hash.is_empty());
        assert!(!clean.is_dirty);
        assert_eq!(clean.ahead, 0);
        assert_eq!(clean.behind, 0);
        assert!(clean.is_main_worktree);
        assert_eq!(clean.worktree_label, None);

        fs::write(temp_repo.join("README.md"), "changed\n").expect("failed to update file");
        let dirty = get_git_info(temp_repo.to_string_lossy().as_ref())
            .expect("git info should resolve after modification")
            .expect("repo should still be detected");
        assert!(dirty.is_dirty);

        let _ = fs::remove_dir_all(temp_repo);
    }

    #[test]
    fn tracked_workspace_change_detection_ignores_untracked_files() {
        let temp_repo =
            std::env::temp_dir().join(format!("atcontroller-git-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_repo).expect("failed to create temp repo");

        git(&temp_repo, &["init"]);
        git(&temp_repo, &["config", "user.email", "test@example.com"]);
        git(&temp_repo, &["config", "user.name", "ATController Test"]);

        fs::write(temp_repo.join("README.md"), "initial\n").expect("failed to write file");
        git(&temp_repo, &["add", "README.md"]);
        git(&temp_repo, &["commit", "-m", "initial"]);

        fs::write(temp_repo.join("UNTRACKED.md"), "scratch\n")
            .expect("failed to write untracked file");
        let only_untracked_dirty =
            has_tracked_workspace_changes(temp_repo.to_string_lossy().as_ref())
                .expect("tracked change check should succeed");
        assert!(!only_untracked_dirty);

        fs::write(temp_repo.join("README.md"), "changed\n").expect("failed to modify tracked file");
        let tracked_dirty = has_tracked_workspace_changes(temp_repo.to_string_lossy().as_ref())
            .expect("tracked change check should succeed after tracked modification");
        assert!(tracked_dirty);

        let _ = fs::remove_dir_all(temp_repo);
    }

    #[test]
    fn repository_operation_detection_ignores_empty_stale_rebase_directories() {
        let temp_repo =
            std::env::temp_dir().join(format!("atcontroller-git-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_repo).expect("failed to create temp repo");

        git(&temp_repo, &["init"]);
        let git_dir = resolve_git_dir(temp_repo.to_string_lossy().as_ref())
            .expect("git dir should resolve")
            .expect("git dir should exist");

        fs::create_dir_all(git_dir.join("rebase-merge"))
            .expect("failed to create stale rebase dir");
        assert!(
            !has_repository_operation_in_progress(temp_repo.to_string_lossy().as_ref())
                .expect("operation state should resolve")
        );

        fs::write(
            git_dir.join("rebase-merge").join("head-name"),
            "refs/heads/main\n",
        )
        .expect("failed to write active rebase marker");
        assert!(
            has_repository_operation_in_progress(temp_repo.to_string_lossy().as_ref())
                .expect("operation state should resolve")
        );

        let _ = fs::remove_dir_all(temp_repo);
    }

    #[test]
    fn parses_ahead_behind_counts() {
        assert_eq!(parse_ahead_behind("3\t2"), (3, 2));
        assert_eq!(parse_ahead_behind(""), (0, 0));
        assert_eq!(parse_ahead_behind("bad input"), (0, 0));
    }

    #[test]
    fn rejects_unsafe_branch_names() {
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("   ").is_err());
        assert!(validate_branch_name("-main").is_err());
        assert!(validate_branch_name("feature/test").is_ok());
    }

    #[test]
    fn git_pull_for_new_thread_uses_origin_default_branch_when_it_is_main() {
        let temp_root = std::env::temp_dir().join(format!(
            "atcontroller-git-pull-test-{}",
            uuid::Uuid::new_v4()
        ));
        let seed_repo = temp_root.join("seed");
        let origin_repo = temp_root.join("origin.git");
        let workspace_repo = temp_root.join("workspace");
        fs::create_dir_all(&seed_repo).expect("failed to create seed repo");

        git(&seed_repo, &["init"]);
        configure_test_author(&seed_repo);
        fs::write(seed_repo.join("README.md"), "initial\n").expect("failed to write seed file");
        git(&seed_repo, &["add", "README.md"]);
        git(&seed_repo, &["commit", "-m", "initial"]);
        git(&seed_repo, &["branch", "-M", "main"]);

        fs::create_dir_all(&origin_repo).expect("failed to create origin repo");
        git(&origin_repo, &["init", "--bare"]);
        git(&origin_repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let origin_path = origin_repo.to_string_lossy().to_string();
        git(&seed_repo, &["remote", "add", "origin", &origin_path]);
        git(&seed_repo, &["push", "-u", "origin", "main"]);

        git(
            &temp_root,
            &[
                "clone",
                &origin_path,
                workspace_repo.to_string_lossy().as_ref(),
            ],
        );
        configure_test_author(&workspace_repo);
        git(&workspace_repo, &["checkout", "-b", "feature/test"]);

        fs::write(seed_repo.join("README.md"), "updated\n").expect("failed to update seed file");
        git(&seed_repo, &["add", "README.md"]);
        git(&seed_repo, &["commit", "-m", "update main"]);
        git(&seed_repo, &["push", "origin", "main"]);

        let result = git_pull_master_for_new_thread(workspace_repo.to_string_lossy().as_ref())
            .expect("git pull pre-step should run");

        assert_eq!(result.outcome, "pulled");
        assert!(
            result.message.contains("main"),
            "message should name the pulled default branch: {}",
            result.message
        );
        assert_eq!(
            run_git_checked(
                workspace_repo.to_string_lossy().as_ref(),
                &["rev-parse", "--abbrev-ref", "HEAD"]
            )
            .expect("branch should resolve"),
            "main"
        );
        assert_eq!(
            fs::read_to_string(workspace_repo.join("README.md"))
                .expect("workspace README should be readable"),
            "updated\n"
        );

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn detects_linked_worktree_context() {
        let temp_root =
            std::env::temp_dir().join(format!("atcontroller-git-test-{}", uuid::Uuid::new_v4()));
        let temp_repo = temp_root.join("main");
        let linked_worktree = temp_root.join("feature-auth");
        fs::create_dir_all(&temp_repo).expect("failed to create temp repo");

        git(&temp_repo, &["init"]);
        git(&temp_repo, &["config", "user.email", "test@example.com"]);
        git(&temp_repo, &["config", "user.name", "ATController Test"]);

        fs::write(temp_repo.join("README.md"), "initial\n").expect("failed to write file");
        git(&temp_repo, &["add", "README.md"]);
        git(&temp_repo, &["commit", "-m", "initial"]);
        git(&temp_repo, &["branch", "feature/auth"]);
        git(
            &temp_repo,
            &[
                "worktree",
                "add",
                linked_worktree.to_string_lossy().as_ref(),
                "feature/auth",
            ],
        );

        let linked = get_git_info(linked_worktree.to_string_lossy().as_ref())
            .expect("git info should resolve for linked worktree")
            .expect("linked worktree should be detected");
        assert!(!linked.is_main_worktree);
        assert_eq!(linked.worktree_label.as_deref(), Some("feature-auth"));
        assert_eq!(linked.branch, "feature/auth");

        fs::create_dir_all(linked_worktree.join("nested")).expect("failed to create nested path");
        let nested = get_git_info(linked_worktree.join("nested").to_string_lossy().as_ref())
            .expect("git info should resolve from nested linked directory")
            .expect("nested path should still be a git repo");
        assert!(!nested.is_main_worktree);
        assert_eq!(nested.worktree_label.as_deref(), Some("feature-auth"));

        let _ = fs::remove_dir_all(temp_root);
    }
}
