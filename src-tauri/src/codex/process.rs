use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::process::{Child, Command};

use crate::storage;

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);
const PROTOCOL_GENERATION_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone)]
pub struct CodexProcessSpec {
    pub binary_path: String,
    pub version: String,
    pub login_path: Option<String>,
}

pub async fn discover() -> Result<CodexProcessSpec> {
    tokio::task::spawn_blocking(discover_blocking)
        .await
        .context("Codex discovery task failed")?
}

pub async fn generate_protocol_snapshot() -> Result<String> {
    let spec = discover().await?;
    let data_root = storage::ensure_base_dirs()?;
    let destination = data_root.join("generated-codex-protocol");
    let temporary = data_root.join(format!(
        ".generated-codex-protocol-{}",
        uuid::Uuid::new_v4()
    ));
    let ts_output = temporary.join("typescript");
    let schema_output = temporary.join("schema");
    std::fs::create_dir_all(&ts_output)?;
    std::fs::create_dir_all(&schema_output)?;

    let result = async {
        run_generator(
            &spec,
            vec![
                OsString::from("app-server"),
                OsString::from("generate-ts"),
                OsString::from("--out"),
                ts_output.into_os_string(),
            ],
        )
        .await?;
        run_generator(
            &spec,
            vec![
                OsString::from("app-server"),
                OsString::from("generate-json-schema"),
                OsString::from("--out"),
                schema_output.into_os_string(),
            ],
        )
        .await?;
        let version = serde_json::json!({
            "codexVersion": spec.version,
            "generatedAt": chrono::Utc::now(),
            "binary": spec.binary_path
        });
        std::fs::write(
            temporary.join("version.json"),
            serde_json::to_vec_pretty(&version)?,
        )?;
        if destination.exists() {
            std::fs::rename(
                &destination,
                data_root.join(format!(
                    "generated-codex-protocol.previous-{}",
                    uuid::Uuid::new_v4()
                )),
            )?;
        }
        std::fs::rename(&temporary, &destination)?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(error);
    }
    Ok(destination.to_string_lossy().to_string())
}

async fn run_generator(spec: &CodexProcessSpec, args: Vec<OsString>) -> Result<()> {
    let mut command = Command::new(&spec.binary_path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = &spec.login_path {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(PROTOCOL_GENERATION_TIMEOUT, command.output())
        .await
        .context("Codex protocol generation timed out")??;
    if !output.status.success() {
        return Err(anyhow!(
            "Codex protocol generation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn discover_blocking() -> Result<CodexProcessSpec> {
    let settings = storage::load_settings()?;
    let binary_path = discover_binary(settings.codex_cli_path.as_deref())
        .ok_or_else(|| anyhow!("Codex CLI not found. Configure its path in Settings."))?;
    let login_path = execution_path(&binary_path);
    let version = run_direct_probe(&binary_path, &["--version"], login_path.as_deref())?;
    let help = run_direct_probe(
        &binary_path,
        &["app-server", "--help"],
        login_path.as_deref(),
    )
    .context("The installed Codex CLI does not support app-server")?;
    if !help.contains("--stdio") {
        return Err(anyhow!(
            "The installed Codex CLI is too old: `codex app-server --stdio` is required."
        ));
    }
    Ok(CodexProcessSpec {
        binary_path,
        version: version.trim().to_string(),
        login_path,
    })
}

fn discover_binary(configured: Option<&str>) -> Option<String> {
    let mut candidates = Vec::<PathBuf>::new();
    if let Some(configured) = configured.filter(|value| !value.trim().is_empty()) {
        candidates.push(expand_home(configured.trim()));
    }
    if let Some(configured) = env::var_os("CODEX_CLI_PATH").filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(configured));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|root| root.join("codex")));
    }
    candidates.extend([
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
    ]);
    if let Some(home) = dirs::home_dir() {
        candidates.extend([
            home.join(".volta/bin/codex"),
            home.join(".npm-global/bin/codex"),
            home.join(".local/bin/codex"),
        ]);
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        if seen.insert(candidate.clone()) && is_executable_file(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    discover_from_login_shell()
        .map(PathBuf::from)
        .filter(|path| is_executable_file(path))
        .map(|path| path.to_string_lossy().to_string())
}

pub(crate) fn run_direct_probe(
    binary: &str,
    args: &[&str],
    login_path: Option<&str>,
) -> Result<String> {
    let mut command = StdCommand::new(binary);
    command.args(args);
    if let Some(path) = login_path {
        command.env("PATH", path);
    }
    command.stdin(Stdio::null());
    let output = run_with_timeout(command, DISCOVERY_TIMEOUT)?;
    if !output.status.success() {
        return Err(anyhow!(
            "{} failed: {}",
            binary,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

fn run_with_timeout(mut command: StdCommand, timeout: Duration) -> Result<std::process::Output> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map_err(Into::into);
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("Codex discovery command timed out"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn discover_from_login_shell() -> Option<String> {
    let shell = env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let output = StdCommand::new(shell)
        .args([
            "-lic",
            "printf '\\036ATCONTROLLER_CODEX_CLI=%s\\036' \"$(command -v codex 2>/dev/null || true)\"",
        ])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let raw = String::from_utf8_lossy(&output.stdout);
    parse_marked_value(&raw, "ATCONTROLLER_CODEX_CLI")
}

fn execution_path(binary: &str) -> Option<String> {
    let mut paths = Vec::<PathBuf>::new();
    if let Some(parent) = Path::new(binary).parent() {
        paths.push(parent.to_path_buf());
    }
    if let Some(current) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current));
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ]);
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    env::join_paths(paths)
        .ok()
        .and_then(|value| value.into_string().ok())
}

fn expand_home(path: &str) -> PathBuf {
    path.strip_prefix("~/")
        .and_then(|relative| dirs::home_dir().map(|home| home.join(relative)))
        .unwrap_or_else(|| PathBuf::from(path))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn parse_marked_value(output: &str, marker: &str) -> Option<String> {
    let prefix = format!("\u{1e}{marker}=");
    let start = output.rfind(&prefix)? + prefix.len();
    let end = output[start..].find('\u{1e}')? + start;
    let value = output[start..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub fn spawn(spec: &CodexProcessSpec) -> Result<Child> {
    let mut command = Command::new(&spec.binary_path);
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = &spec.login_path {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    command
        .spawn()
        .with_context(|| format!("Unable to launch {} app-server --stdio", spec.binary_path))
}

pub fn validate_workspace_path(requested: &str) -> Result<String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err(anyhow!("Workspace path cannot be empty"));
    }
    let canonical = std::fs::canonicalize(requested)
        .with_context(|| format!("Unable to resolve workspace path {requested}"))?;
    if !canonical.is_dir() {
        return Err(anyhow!("Workspace path is not a directory"));
    }
    let known = storage::load_workspaces()?
        .into_iter()
        .filter_map(|workspace| std::fs::canonicalize(workspace.path).ok())
        .collect::<HashSet<PathBuf>>();
    if !known.contains(&canonical) {
        return Err(anyhow!(
            "The requested path is not a registered local ATController workspace"
        ));
    }
    Ok(canonical.to_string_lossy().to_string())
}

pub fn validate_attachment_path(
    workspace_path: &str,
    requested: &str,
    allow_outside_workspace: bool,
) -> Result<String> {
    let workspace = Path::new(workspace_path);
    let canonical = std::fs::canonicalize(requested)
        .with_context(|| format!("Unable to resolve attachment {requested}"))?;
    if !canonical.is_file() {
        return Err(anyhow!("Attachment is not a regular file"));
    }
    if !canonical.starts_with(workspace) && !allow_outside_workspace {
        return Err(anyhow!(
            "This attachment is outside the active workspace and was not explicitly attached for this turn."
        ));
    }
    Ok(canonical.to_string_lossy().to_string())
}

#[cfg(unix)]
pub fn signal_process_group(pid: u32, signal: libc::c_int) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    let result = unsafe { libc::kill(-pid, signal) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
pub fn signal_process_group(_pid: u32, _signal: libc::c_int) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::parse_marked_value;

    #[test]
    fn login_shell_noise_does_not_pollute_marked_path() {
        let output = "shell warning\n\u{1e}ATCONTROLLER_CODEX_CLI=/usr/local/bin/codex\u{1e}\n";
        assert_eq!(
            parse_marked_value(output, "ATCONTROLLER_CODEX_CLI").as_deref(),
            Some("/usr/local/bin/codex")
        );
    }
}
