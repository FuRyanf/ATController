use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::storage;

pub const OUTPUT_EVENT: &str = "atcontroller://project-terminal-output";
pub const EXIT_EVENT: &str = "atcontroller://project-terminal-exit";

const OUTPUT_QUEUE_CAPACITY: usize = 128;
const OUTPUT_CHUNK_BYTES: usize = 32 * 1024;
const OUTPUT_EVENT_BATCH_BYTES: usize = 128 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTerminalSessionInfo {
    pub id: String,
    pub workspace_id: String,
    pub cwd: String,
    pub shell: String,
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTerminalOutput {
    session_id: String,
    workspace_id: String,
    data_base64: String,
    byte_length: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTerminalExit {
    session_id: String,
    workspace_id: String,
    exit_code: Option<u32>,
    signal: Option<String>,
    error: Option<String>,
}

enum TerminalFrame {
    Output(Vec<u8>),
    Exit {
        exit_code: Option<u32>,
        signal: Option<String>,
        error: Option<String>,
    },
}

type TerminalExitState = (Option<u32>, Option<String>, Option<String>);

fn collect_queued_output(
    mut bytes: Vec<u8>,
    frames: &mpsc::Receiver<TerminalFrame>,
    exit: &mut Option<TerminalExitState>,
) -> Vec<u8> {
    while bytes.len() < OUTPUT_EVENT_BATCH_BYTES {
        match frames.try_recv() {
            Ok(TerminalFrame::Output(next)) => bytes.extend_from_slice(&next),
            Ok(TerminalFrame::Exit {
                exit_code,
                signal,
                error,
            }) => *exit = Some((exit_code, signal, error)),
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
        }
    }
    bytes
}

struct ProjectTerminalSession {
    info: ProjectTerminalSessionInfo,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    process_group_id: Option<i32>,
}

impl ProjectTerminalSession {
    fn write(&self, data: &str) -> Result<()> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(anyhow!(
                "Project Terminal input exceeds the 64 KiB per-message limit"
            ));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| anyhow!("Project Terminal writer lock poisoned"))?;
        writer
            .write_all(data.as_bytes())
            .context("Unable to write to Project Terminal")?;
        writer.flush().context("Unable to flush Project Terminal")
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let size = validated_size(cols, rows)?;
        self.master
            .lock()
            .map_err(|_| anyhow!("Project Terminal PTY lock poisoned"))?
            .resize(size)
            .context("Unable to resize Project Terminal")
    }

    #[cfg(unix)]
    fn signal_group(&self, signal: libc::c_int) -> bool {
        let Some(process_group_id) = self.process_group_id.filter(|id| *id > 1) else {
            return false;
        };
        let result = unsafe { libc::kill(-process_group_id, signal) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(not(unix))]
    fn signal_group(&self, _signal: i32) -> bool {
        false
    }

    fn terminate(&self) {
        #[cfg(unix)]
        self.signal_group(libc::SIGHUP);
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }

    fn force_terminate(&self) {
        #[cfg(unix)]
        {
            if self.signal_group(0) {
                self.signal_group(libc::SIGKILL);
            }
        }
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

#[derive(Clone, Default)]
pub struct ProjectTerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<ProjectTerminalSession>>>>,
}

impl ProjectTerminalManager {
    pub fn start(
        &self,
        app: AppHandle,
        workspace_id: &str,
        requested_cwd: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<ProjectTerminalSessionInfo> {
        let workspace = storage::load_workspaces()?
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| anyhow!("Project not found"))?;
        if !workspace.is_available {
            return Err(anyhow!("Project folder is unavailable"));
        }
        let cwd = resolve_terminal_cwd(&workspace.path, requested_cwd)?;
        let size = validated_size(cols, rows)?;

        let existing = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Project Terminal session lock poisoned"))?
            .values()
            .find(|session| session.info.workspace_id == workspace.id)
            .cloned();
        if let Some(existing) = existing {
            if Path::new(&existing.info.cwd) == cwd {
                existing.resize(cols, rows)?;
                return Ok(existing.info.clone());
            }
            self.stop(&existing.info.id)?;
        }

        let shell = resolved_shell();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .context("Unable to allocate a Project Terminal PTY")?;
        let mut command = CommandBuilder::new(&shell);
        command.arg("-l");
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "ATController");
        command.env("ATCONTROLLER_PROJECT_TERMINAL", "1");

        let mut child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("Unable to start {shell} for Project Terminal"))?;
        let process_id = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("Unable to read Project Terminal output")?;
        let writer = pair
            .master
            .take_writer()
            .context("Unable to open Project Terminal input")?;
        #[cfg(unix)]
        let process_group_id = pair.master.process_group_leader();
        #[cfg(not(unix))]
        let process_group_id = None;

        let info = ProjectTerminalSessionInfo {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace.id,
            cwd: cwd.to_string_lossy().to_string(),
            shell,
            process_id,
        };
        let session = Arc::new(ProjectTerminalSession {
            info: info.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            process_group_id,
        });
        drop(pair.slave);
        self.sessions
            .lock()
            .map_err(|_| anyhow!("Project Terminal session lock poisoned"))?
            .insert(info.id.clone(), session.clone());

        let (frames_tx, frames_rx) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
        let output_tx = frames_tx.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("project-terminal-reader-{}", &info.id[..8]))
            .spawn(move || {
                let mut buffer = vec![0_u8; OUTPUT_CHUNK_BYTES];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(length) => {
                            if output_tx
                                .send(TerminalFrame::Output(buffer[..length].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            })
        {
            self.sessions
                .lock()
                .map(|mut sessions| sessions.remove(&info.id))
                .ok();
            session.force_terminate();
            return Err(anyhow!(error).context("Unable to start Project Terminal reader"));
        }

        let exit_tx = frames_tx;
        if let Err(error) = std::thread::Builder::new()
            .name(format!("project-terminal-wait-{}", &info.id[..8]))
            .spawn(move || {
                let frame = match child.wait() {
                    Ok(status) => TerminalFrame::Exit {
                        exit_code: Some(status.exit_code()),
                        signal: status.signal().map(str::to_string),
                        error: None,
                    },
                    Err(error) => TerminalFrame::Exit {
                        exit_code: None,
                        signal: None,
                        error: Some(error.to_string()),
                    },
                };
                let _ = exit_tx.send(frame);
            })
        {
            self.sessions
                .lock()
                .map(|mut sessions| sessions.remove(&info.id))
                .ok();
            session.force_terminate();
            return Err(anyhow!(error).context("Unable to supervise Project Terminal process"));
        }

        let sessions = self.sessions.clone();
        let emit_info = info.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("project-terminal-events-{}", &info.id[..8]))
            .spawn(move || {
                let mut exit = None;
                while let Ok(frame) = frames_rx.recv() {
                    match frame {
                        TerminalFrame::Output(bytes) => {
                            // PTYs commonly yield many tiny reads during a
                            // command burst. Drain only frames already waiting
                            // in the bounded queue to reduce native-to-webview
                            // event traffic without adding presentation delay.
                            let bytes = collect_queued_output(bytes, &frames_rx, &mut exit);
                            let payload = ProjectTerminalOutput {
                                session_id: emit_info.id.clone(),
                                workspace_id: emit_info.workspace_id.clone(),
                                data_base64: base64::engine::general_purpose::STANDARD
                                    .encode(&bytes),
                                byte_length: bytes.len(),
                            };
                            let _ = app.emit(OUTPUT_EVENT, payload);
                        }
                        TerminalFrame::Exit {
                            exit_code,
                            signal,
                            error,
                        } => {
                            exit = Some((exit_code, signal, error));
                        }
                    }
                }
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.remove(&emit_info.id);
                }
                let (exit_code, signal, error) = exit.unwrap_or_else(|| {
                    (
                        None,
                        None,
                        Some("Project Terminal event stream closed unexpectedly".to_string()),
                    )
                });
                let _ = app.emit(
                    EXIT_EVENT,
                    ProjectTerminalExit {
                        session_id: emit_info.id,
                        workspace_id: emit_info.workspace_id,
                        exit_code,
                        signal,
                        error,
                    },
                );
            })
        {
            self.sessions
                .lock()
                .map(|mut sessions| sessions.remove(&info.id))
                .ok();
            session.force_terminate();
            return Err(anyhow!(error).context("Unable to start Project Terminal event bridge"));
        }

        Ok(info)
    }

    pub fn list(&self) -> Result<Vec<ProjectTerminalSessionInfo>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Project Terminal session lock poisoned"))?
            .values()
            .map(|session| session.info.clone())
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
        Ok(sessions)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        self.session(session_id)?.write(data)
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        self.session(session_id)?.resize(cols, rows)
    }

    pub fn stop(&self, session_id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("Project Terminal session lock poisoned"))?
            .remove(session_id)
            .ok_or_else(|| anyhow!("Project Terminal session not found"))?;
        session.terminate();
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in &sessions {
            session.terminate();
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        for session in &sessions {
            session.force_terminate();
        }
    }

    fn session(&self, session_id: &str) -> Result<Arc<ProjectTerminalSession>> {
        if session_id.trim().is_empty()
            || session_id.len() > 128
            || session_id.chars().any(char::is_control)
        {
            return Err(anyhow!("Invalid Project Terminal session identifier"));
        }
        self.sessions
            .lock()
            .map_err(|_| anyhow!("Project Terminal session lock poisoned"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow!("Project Terminal session not found"))
    }
}

fn validated_size(cols: u16, rows: u16) -> Result<PtySize> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(anyhow!(
            "Project Terminal size must be {MIN_COLS}-{MAX_COLS} columns by {MIN_ROWS}-{MAX_ROWS} rows"
        ));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn resolve_terminal_cwd(workspace_path: &str, requested_cwd: Option<&str>) -> Result<PathBuf> {
    let workspace = std::fs::canonicalize(workspace_path)
        .with_context(|| format!("Unable to resolve project path {workspace_path}"))?;
    if !workspace.is_dir() {
        return Err(anyhow!("Project path is not a directory"));
    }
    let requested = requested_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(workspace_path);
    let cwd = std::fs::canonicalize(requested)
        .with_context(|| format!("Unable to resolve Project Terminal directory {requested}"))?;
    if !cwd.is_dir() || !cwd.starts_with(&workspace) {
        return Err(anyhow!(
            "Project Terminal directory must be inside the selected project"
        ));
    }
    Ok(cwd)
}

fn resolved_shell() -> String {
    let configured = std::env::var("SHELL")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    configured
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::mpsc;

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    use super::{collect_queued_output, resolve_terminal_cwd, validated_size, TerminalFrame};

    #[test]
    fn queued_terminal_output_is_batched_without_losing_exit_state() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(TerminalFrame::Output(b"second".to_vec()))
            .expect("queue second output");
        sender
            .send(TerminalFrame::Exit {
                exit_code: Some(0),
                signal: None,
                error: None,
            })
            .expect("queue exit");
        sender
            .send(TerminalFrame::Output(b"third".to_vec()))
            .expect("queue trailing output");

        let mut exit = None;
        let output = collect_queued_output(b"first".to_vec(), &receiver, &mut exit);

        assert_eq!(output, b"firstsecondthird");
        assert_eq!(exit, Some((Some(0), None, None)));
    }

    #[test]
    fn terminal_size_is_bounded() {
        assert!(validated_size(80, 24).is_ok());
        assert!(validated_size(1, 24).is_err());
        assert!(validated_size(80, 301).is_err());
    }

    #[test]
    fn terminal_cwd_must_remain_inside_the_project() {
        let root = std::env::temp_dir().join(format!(
            "atcontroller-terminal-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let child = project.join("nested");
        let outside = root.join("outside");
        std::fs::create_dir_all(&child).expect("nested project directory");
        std::fs::create_dir_all(&outside).expect("outside directory");
        assert_eq!(
            resolve_terminal_cwd(project.to_str().unwrap(), Some(child.to_str().unwrap()))
                .expect("nested cwd"),
            std::fs::canonicalize(&child).expect("canonical child")
        );
        assert!(
            resolve_terminal_cwd(project.to_str().unwrap(), Some(outside.to_str().unwrap()))
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_project_terminal_pty_round_trips_output() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("native PTY");
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("printf ATCONTROLLER_PROJECT_TERMINAL_OK");
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn shell in PTY");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("PTY reader");
        let mut output = String::new();
        reader.read_to_string(&mut output).expect("read PTY output");
        let status = child.wait().expect("wait for PTY child");

        assert_eq!(status.exit_code(), 0);
        assert!(output.contains("ATCONTROLLER_PROJECT_TERMINAL_OK"));
    }
}
