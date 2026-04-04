use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Result};

use crate::models::{
    GitBranchEntry, GitDiffSummary, GitInfo, GitPullForNewThreadResult, GitWorkspaceStatus,
};

const GIT_TIMEOUT: Duration = Duration::from_secs(8);
const GIT_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Clone)]
struct GitWorktreeEntry {
    path: PathBuf,
    branch: Option<String>,
}

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
    label: &str,
) -> Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
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
        std::thread::sleep(GIT_WAIT_POLL_INTERVAL);
    }
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
    let output = run_command_with_timeout(command, GIT_TIMEOUT, "git command")?;

    if !output.status.success() {
        return Ok(String::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_checked(workspace_path: &str, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = run_command_with_timeout(command, GIT_TIMEOUT, "git command")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("git {:?} failed", args)
        } else {
            stderr
        };
        return Err(anyhow!(message));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git_success(workspace_path: &str, args: &[&str]) -> Result<bool> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(workspace_path)
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = run_command_with_timeout(command, GIT_TIMEOUT, "git command")?;
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

    let markers = ["MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"];
    Ok(markers
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

pub fn resolve_worktree_root_path(workspace_path: &str) -> Result<Option<String>> {
    if !is_git_repo(workspace_path)? {
        return Ok(None);
    }
    Ok(Some(canonicalize_path_or_original(
        &resolve_current_worktree_root(workspace_path)?,
    )))
}

pub fn resolve_main_repo_root_path(workspace_path: &str) -> Result<Option<String>> {
    if !is_git_repo(workspace_path)? {
        return Ok(None);
    }

    let worktrees = list_worktrees(workspace_path)?;
    if let Some(main_entry) = worktrees.first() {
        return Ok(Some(canonicalize_path_or_original(&main_entry.path)));
    }

    Ok(Some(canonicalize_path_or_original(
        &resolve_current_worktree_root(workspace_path)?,
    )))
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

pub fn get_git_diff_summary(workspace_path: &str) -> Result<GitDiffSummary> {
    let stat = run_git(workspace_path, &["diff", "--stat"])?;
    let mut diff_excerpt = run_git(workspace_path, &["diff"])?;
    let max = 15_000;
    if diff_excerpt.len() > max {
        diff_excerpt.truncate(max);
        diff_excerpt.push_str("\n...\n(diff truncated)");
    }

    Ok(GitDiffSummary { stat, diff_excerpt })
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

pub fn create_and_checkout_branch(workspace_path: &str, branch_name: &str) -> Result<()> {
    let normalized = validate_branch_name(branch_name)?;
    run_git_checked(
        workspace_path,
        &["check-ref-format", "--branch", normalized],
    )?;
    run_git_checked(workspace_path, &["checkout", "-b", normalized]).map(|_| ())
}

pub fn auto_pull_on_master(workspace_path: &str) -> Result<bool> {
    if !is_git_repo(workspace_path)? {
        return Ok(false);
    }

    let branch = run_git(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch != "master" {
        return Ok(false);
    }

    let upstream = run_git(
        workspace_path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )?;
    if upstream.trim().is_empty() {
        return Ok(false);
    }

    run_git_checked(workspace_path, &["pull", "--ff-only"])?;
    Ok(true)
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

    let branch = run_git_checked(workspace_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch != "master" {
        if let Err(error) = run_git_checked(workspace_path, &["checkout", "master"]) {
            return Ok(GitPullForNewThreadResult {
                outcome: "failed".to_string(),
                message: format!("Git checkout failed: {error}"),
            });
        }
    }

    if !has_upstream(workspace_path)? {
        return Ok(GitPullForNewThreadResult {
            outcome: "skipped".to_string(),
            message: "Skipped git pull: master has no upstream tracking branch.".to_string(),
        });
    }

    let before_pull_commit = short_head_commit(workspace_path)?;

    if let Err(error) = run_git_checked(workspace_path, &["pull", "--ff-only"]) {
        return Ok(GitPullForNewThreadResult {
            outcome: "failed".to_string(),
            message: format!("Git pull failed: {error}"),
        });
    }

    let after_pull_commit = short_head_commit(workspace_path)?;
    let message = match after_pull_commit {
        Some(commit) => {
            if before_pull_commit.as_deref() == Some(commit.as_str()) {
                format!("Master already up to date at commit {commit}.")
            } else {
                format!("Checked out master and pulled latest changes to commit {commit}.")
            }
        }
        None => "Checked out master and pulled latest changes.".to_string(),
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
    use std::path::Path;
    use std::process::Command;

    fn git(workdir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(workdir)
            .status()
            .expect("git command should execute");
        assert!(status.success(), "git {:?} failed", args);
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
    fn skips_auto_pull_when_not_on_master() {
        let temp_repo =
            std::env::temp_dir().join(format!("atcontroller-git-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_repo).expect("failed to create temp repo");

        git(&temp_repo, &["init"]);
        git(&temp_repo, &["config", "user.email", "test@example.com"]);
        git(&temp_repo, &["config", "user.name", "ATController Test"]);
        fs::write(temp_repo.join("README.md"), "initial\n").expect("failed to write file");
        git(&temp_repo, &["add", "README.md"]);
        git(&temp_repo, &["commit", "-m", "initial"]);
        git(&temp_repo, &["checkout", "-b", "feature/test"]);

        let pulled = auto_pull_on_master(temp_repo.to_string_lossy().as_ref())
            .expect("auto pull should not fail on non-master branch");
        assert!(!pulled);

        let _ = fs::remove_dir_all(temp_repo);
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
