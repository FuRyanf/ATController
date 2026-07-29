use std::process::{Command, Stdio};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use super::{process, CodexRuntime};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCommandRequest {
    pub thread_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub service_tier: Option<String>,
    #[serde(default)]
    pub full_access: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexResumeCommand {
    pub command: String,
    pub binary_path: String,
    pub arguments: Vec<String>,
    pub working_directory: String,
    pub full_access: bool,
}

impl CodexRuntime {
    pub async fn build_resume_command(
        self: &std::sync::Arc<Self>,
        request: ResumeCommandRequest,
    ) -> Result<CodexResumeCommand> {
        validate_token(&request.thread_id, "thread identifier", 256)?;
        if let Some(model) = request.model.as_deref() {
            validate_token(model, "model", 160)?;
        }
        if let Some(effort) = request.reasoning_effort.as_deref() {
            validate_token(effort, "reasoning effort", 64)?;
        }
        if let Some(tier) = request.service_tier.as_deref() {
            validate_token(tier, "service tier", 64)?;
        }
        let workspace = process::validate_workspace_path(&request.workspace_path)?;
        let spec = process::discover().await?;
        let binary = spec.binary_path.clone();
        let help = tokio::task::spawn_blocking(move || {
            process::run_direct_probe(&binary, &["resume", "--help"], spec.login_path.as_deref())
        })
        .await
        .context("Codex resume capability probe failed")??;
        require_help(&help, "Usage: codex resume", "session resume")?;
        require_help(&help, "--cd", "workspace selection")?;
        if request.full_access {
            require_help(
                &help,
                "--dangerously-bypass-approvals-and-sandbox",
                "Full Access resume",
            )?;
        }
        if request.model.is_some() {
            require_help(&help, "--model", "model override")?;
        }
        if request.reasoning_effort.is_some() || request.service_tier.is_some() {
            require_help(&help, "--config", "configuration override")?;
        }

        let arguments = build_arguments(&request, &workspace);
        let mut display = shell_quote(&spec.binary_path);
        for argument in &arguments {
            display.push(' ');
            display.push_str(&shell_quote(argument));
        }
        Ok(CodexResumeCommand {
            command: display,
            binary_path: spec.binary_path,
            arguments,
            working_directory: workspace,
            full_access: request.full_access,
        })
    }

    pub async fn open_resume_in_terminal(
        self: &std::sync::Arc<Self>,
        request: ResumeCommandRequest,
        execute: bool,
    ) -> Result<CodexResumeCommand> {
        let command = self.build_resume_command(request).await?;
        open_in_terminal(command.clone(), execute).await?;
        Ok(command)
    }
}

async fn open_in_terminal(command: CodexResumeCommand, execute: bool) -> Result<()> {
    tokio::task::spawn_blocking(move || open_in_terminal_blocking(command, execute))
        .await
        .context("Terminal handoff task failed")?
}

fn open_in_terminal_blocking(command: CodexResumeCommand, execute: bool) -> Result<()> {
    if !execute {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if std::path::Path::new(&shell)
            .file_name()
            .and_then(|name| name.to_str())
            != Some("zsh")
        {
            return Err(anyhow!(
                "Insert-for-review requires zsh. Choose Execute immediately in ATController Settings for this shell."
            ));
        }
    }
    let script = r#"
on run argv
  set targetDirectory to item 1 of argv
  set resumeCommand to item 2 of argv
  set executeNow to item 3 of argv
  tell application "Terminal"
    activate
    if executeNow is "true" then
      do script "cd -- " & quoted form of targetDirectory & " && " & resumeCommand
    else
      do script "cd -- " & quoted form of targetDirectory & " && print -z -- " & quoted form of resumeCommand
    end if
  end tell
end run
"#;
    let status = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            script,
            "--",
            &command.working_directory,
            &command.command,
            if execute { "true" } else { "false" },
        ])
        .stdin(Stdio::null())
        .status()
        .context("Unable to launch Terminal")?;
    if !status.success() {
        return Err(anyhow!("Terminal rejected the Codex resume handoff"));
    }
    Ok(())
}

fn build_arguments(request: &ResumeCommandRequest, workspace: &str) -> Vec<String> {
    let mut arguments = vec!["resume".to_string()];
    if request.full_access {
        arguments.push("--dangerously-bypass-approvals-and-sandbox".to_string());
    }
    if let Some(model) = request.model.as_ref() {
        arguments.extend(["--model".to_string(), model.clone()]);
    }
    if let Some(effort) = request.reasoning_effort.as_ref() {
        arguments.extend([
            "--config".to_string(),
            format!("model_reasoning_effort={}", toml_string(effort)),
        ]);
    }
    if let Some(tier) = request.service_tier.as_ref() {
        arguments.extend([
            "--config".to_string(),
            format!("service_tier={}", toml_string(tier)),
        ]);
    }
    arguments.extend([
        "--cd".to_string(),
        workspace.to_string(),
        request.thread_id.clone(),
    ]);
    arguments
}

fn require_help(help: &str, needle: &str, capability: &str) -> Result<()> {
    if !help.contains(needle) {
        return Err(anyhow!(
            "The installed Codex CLI does not support the required {capability} capability"
        ));
    }
    Ok(())
}

fn validate_token(value: &str, label: &str, max_len: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max_len || value.chars().any(char::is_control) {
        return Err(anyhow!("Invalid {label}"));
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@%_+=:,./-".contains(&byte))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn toml_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

#[cfg(test)]
mod tests {
    use super::{build_arguments, shell_quote, toml_string, ResumeCommandRequest};

    #[test]
    fn resume_arguments_are_shell_escaped() {
        assert_eq!(shell_quote("/tmp/Project One"), "'/tmp/Project One'");
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
        assert_eq!(shell_quote("thread-id"), "thread-id");
    }

    #[test]
    fn config_values_are_toml_strings() {
        assert_eq!(toml_string("high"), "\"high\"");
        assert_eq!(toml_string("a\"b"), "\"a\\\"b\"");
    }

    #[test]
    fn default_resume_only_includes_canonical_thread_and_workspace() {
        let arguments = build_arguments(
            &ResumeCommandRequest {
                thread_id: "thread-123".to_string(),
                workspace_path: "/ignored".to_string(),
                model: None,
                reasoning_effort: None,
                service_tier: None,
                full_access: false,
            },
            "/tmp/Project With Spaces",
        );
        assert_eq!(
            arguments,
            ["resume", "--cd", "/tmp/Project With Spaces", "thread-123"]
        );
    }

    #[test]
    fn explicit_resume_overrides_preserve_cli_order() {
        let arguments = build_arguments(
            &ResumeCommandRequest {
                thread_id: "thread-123".to_string(),
                workspace_path: "/ignored".to_string(),
                model: Some("runtime-model".to_string()),
                reasoning_effort: Some("ultra".to_string()),
                service_tier: Some("fast".to_string()),
                full_access: true,
            },
            "/tmp/project",
        );
        assert_eq!(
            arguments,
            [
                "resume",
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "runtime-model",
                "--config",
                "model_reasoning_effort=\"ultra\"",
                "--config",
                "service_tier=\"fast\"",
                "--cd",
                "/tmp/project",
                "thread-123"
            ]
        );
    }
}
