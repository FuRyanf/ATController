pub mod diagnostics;
mod process;
mod protocol;
mod resume;
mod rpc;
mod threads;
mod transport;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use std::{future::Future, pin::Pin};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

pub use diagnostics::{CodexDiagnostics, ConnectionState};
pub use protocol::{
    CodexEvent, CodexLoginSession, CodexRuntimeCatalog, CodexSkill, CodexThread, CodexThreadPage,
    CodexThreadSession, CodexTurn, ComposerInput, ServerRequestResponse, ThreadPreferences,
};
pub use resume::{CodexResumeCommand, ResumeCommandRequest};
use rpc::{RequestOptions, RpcConnection, RpcError, WireEvent};

const MAX_AUTOMATIC_RESTARTS: u32 = 2;

pub const EVENT_CODEX: &str = "codex:event";
pub const EVENT_RUNTIME_STATE: &str = "codex:runtime-state";

pub struct CodexRuntime {
    app: OnceLock<AppHandle>,
    connection: Mutex<Option<Arc<RpcConnection>>>,
    start_lock: Mutex<()>,
    diagnostics: Arc<diagnostics::DiagnosticsState>,
    generation: AtomicU64,
    event_sequence: AtomicU64,
    restart_attempts: AtomicU32,
    shutting_down: AtomicBool,
}

impl Default for CodexRuntime {
    fn default() -> Self {
        Self {
            app: OnceLock::new(),
            connection: Mutex::new(None),
            start_lock: Mutex::new(()),
            diagnostics: Arc::new(diagnostics::DiagnosticsState::default()),
            generation: AtomicU64::new(0),
            event_sequence: AtomicU64::new(1),
            restart_attempts: AtomicU32::new(0),
            shutting_down: AtomicBool::new(false),
        }
    }
}

impl CodexRuntime {
    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub fn diagnostics(&self) -> CodexDiagnostics {
        self.diagnostics.snapshot()
    }

    pub fn report_frontend_error(&self, message: &str) {
        self.diagnostics
            .push_protocol_error(&format!("Frontend: {message}"));
    }

    pub fn start_in_background(runtime: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = runtime.ensure_connection().await {
                runtime
                    .diagnostics
                    .push_protocol_error(&format!("Codex startup failed: {error:#}"));
            }
        });
    }

    pub fn ensure_connection(
        self: &Arc<Self>,
    ) -> Pin<Box<dyn Future<Output = Result<Arc<RpcConnection>>> + Send + '_>> {
        Box::pin(async move {
            if self.shutting_down.load(Ordering::Acquire) {
                return Err(anyhow!("ATController is shutting down"));
            }
            if let Some(connection) = self.ready_connection().await {
                return Ok(connection);
            }
            let _start_guard = self.start_lock.lock().await;
            if let Some(connection) = self.ready_connection().await {
                return Ok(connection);
            }

            self.set_state(ConnectionState::Starting);
            let spec = match process::discover().await {
                Ok(spec) => spec,
                Err(error) => {
                    self.set_state(ConnectionState::Failed);
                    return Err(error);
                }
            };
            self.diagnostics
                .set_discovery(spec.binary_path.clone(), spec.version.clone(), true);
            self.set_state(ConnectionState::Initializing);

            let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let weak_runtime = Arc::downgrade(self);
            let event_callback = Arc::new(move |wire_event| {
                if let Some(runtime) = weak_runtime.upgrade() {
                    runtime.handle_wire_event(wire_event);
                }
            });
            let weak_runtime = Arc::downgrade(self);
            let exit_callback = Arc::new(move |exit| {
                if let Some(runtime) = weak_runtime.upgrade() {
                    tauri::async_runtime::spawn(async move {
                        runtime.handle_exit(generation, exit).await;
                    });
                }
            });

            let connection = match RpcConnection::spawn(
                &spec,
                self.diagnostics.clone(),
                event_callback,
                exit_callback,
            )
            .await
            {
                Ok(connection) => connection,
                Err(error) => {
                    self.set_state(ConnectionState::Failed);
                    return Err(error);
                }
            };
            *self.connection.lock().await = Some(connection.clone());
            self.set_state(ConnectionState::Ready);
            let weak_runtime = Arc::downgrade(self);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(runtime) = weak_runtime.upgrade() else {
                    return;
                };
                if runtime.generation.load(Ordering::Acquire) == generation
                    && runtime.ready_connection().await.is_some()
                {
                    runtime.restart_attempts.store(0, Ordering::Release);
                    runtime.diagnostics.set_restart_attempts(0);
                }
            });
            Ok(connection)
        })
    }

    async fn ready_connection(&self) -> Option<Arc<RpcConnection>> {
        self.connection
            .lock()
            .await
            .as_ref()
            .filter(|connection| connection.is_ready())
            .cloned()
    }

    pub(crate) async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        options: RequestOptions,
    ) -> Result<Value> {
        let connection = self.ensure_connection().await?;
        match connection.request(method, params.clone(), options).await {
            Ok(result) => Ok(result),
            Err(error)
                if options.idempotent
                    && error.code.is_none()
                    && !self.shutting_down.load(Ordering::Acquire) =>
            {
                let stale_connection = {
                    let mut current = self.connection.lock().await;
                    if current
                        .as_ref()
                        .is_some_and(|candidate| candidate.pid() == connection.pid())
                    {
                        current.take()
                    } else {
                        None
                    }
                };
                if let Some(stale_connection) = stale_connection {
                    self.generation.fetch_add(1, Ordering::AcqRel);
                    stale_connection.shutdown().await;
                }
                let replacement = self.ensure_connection().await?;
                replacement
                    .request(method, params, options)
                    .await
                    .map_err(rpc_error)
            }
            Err(error) => Err(rpc_error(error)),
        }
    }

    pub async fn respond_to_server_request(
        self: &Arc<Self>,
        response: ServerRequestResponse,
    ) -> Result<()> {
        self.ensure_connection()
            .await?
            .respond_to_server_request(response)
            .await
    }

    pub async fn restart(self: &Arc<Self>) -> Result<CodexDiagnostics> {
        self.set_state(ConnectionState::Restarting);
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(connection) = self.connection.lock().await.take() {
            connection.shutdown().await;
        }
        self.restart_attempts.store(0, Ordering::Release);
        self.ensure_connection().await?;
        Ok(self.diagnostics())
    }

    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        self.set_state(ConnectionState::Stopping);
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(connection) = self.connection.lock().await.take() {
            connection.shutdown().await;
        }
        self.set_state(ConnectionState::Stopped);
    }

    pub async fn self_test(self: &Arc<Self>) -> Result<Value> {
        let connection = self.ensure_connection().await?;
        let models = connection
            .request(
                "model/list",
                json!({ "limit": 1, "includeHidden": false }),
                RequestOptions::idempotent(Duration::from_secs(20)),
            )
            .await
            .map_err(rpc_error)?;
        let account = connection
            .request(
                "account/read",
                json!({ "refreshToken": false }),
                RequestOptions::idempotent(Duration::from_secs(20)),
            )
            .await
            .map_err(rpc_error)?;
        Ok(json!({
            "ok": true,
            "transport": "stdio",
            "initialized": true,
            "modelCount": models.get("data").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "signedIn": account.get("account").is_some_and(|value| !value.is_null())
        }))
    }

    pub async fn regenerate_protocol_snapshot(self: &Arc<Self>) -> Result<String> {
        process::generate_protocol_snapshot().await
    }

    pub async fn runtime_catalog(self: &Arc<Self>) -> Result<CodexRuntimeCatalog> {
        let connection = self.ensure_connection().await?;
        let options = RequestOptions::idempotent(Duration::from_secs(30));
        let (models, account, profiles, config) = tokio::try_join!(
            async {
                connection
                    .request(
                        "model/list",
                        json!({ "limit": 100, "includeHidden": false }),
                        options,
                    )
                    .await
                    .map_err(rpc_error)
            },
            async {
                connection
                    .request("account/read", json!({ "refreshToken": false }), options)
                    .await
                    .map_err(rpc_error)
            },
            async {
                connection
                    .request("permissionProfile/list", json!({ "limit": 100 }), options)
                    .await
                    .map_err(rpc_error)
            },
            async {
                connection
                    .request("config/read", json!({ "includeLayers": false }), options)
                    .await
                    .map_err(rpc_error)
            }
        )?;
        let limits = connection
            .request("account/rateLimits/read", json!({}), options)
            .await
            .unwrap_or_else(|_| json!({}));
        let catalog = protocol::normalize_catalog(&models, &account, &limits, &profiles, &config)?;
        self.diagnostics.set_account(
            catalog
                .account
                .authentication_mode
                .clone()
                .or_else(|| Some("signedOut".to_string())),
            catalog.account.plan_type.clone(),
        );
        Ok(catalog)
    }

    pub async fn start_chatgpt_login(self: &Arc<Self>) -> Result<CodexLoginSession> {
        let result = self
            .request(
                "account/login/start",
                json!({
                    "type": "chatgpt",
                    "codexStreamlinedLogin": true,
                    "useHostedLoginSuccessPage": true,
                    "appBrand": "codex"
                }),
                RequestOptions {
                    timeout: Duration::from_secs(30),
                    idempotent: false,
                },
            )
            .await?;
        if result.get("type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(anyhow!(
                "The installed Codex runtime did not offer ChatGPT authentication"
            ));
        }
        let login_id = result
            .get("loginId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("Codex login response is missing loginId"))?;
        let authorization_url = result
            .get("authUrl")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("https://"))
            .ok_or_else(|| anyhow!("Codex login response is missing a secure authorization URL"))?;
        Ok(CodexLoginSession {
            login_id: login_id.to_string(),
            authorization_url: authorization_url.to_string(),
        })
    }

    pub async fn list_skills(
        self: &Arc<Self>,
        workspace_path: String,
        force_reload: bool,
    ) -> Result<Vec<CodexSkill>> {
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        let result = self
            .request(
                "skills/list",
                json!({ "cwds": [workspace_path], "forceReload": force_reload }),
                RequestOptions::idempotent(Duration::from_secs(30)),
            )
            .await?;
        Ok(protocol::normalize_skills(&result))
    }

    fn handle_wire_event(&self, wire_event: WireEvent) {
        let sequence = self.event_sequence.fetch_add(1, Ordering::Relaxed);
        let event = match wire_event {
            WireEvent::Notification { method, params } => {
                let event = protocol::normalize_notification(sequence, &method, &params);
                self.update_context_from_event(&event);
                event
            }
            WireEvent::ServerRequest { id, method, params } => {
                let event = protocol::normalize_server_request(sequence, id, &method, &params);
                self.update_context_from_event(&event);
                event
            }
        };
        if let Some(app) = self.app.get() {
            if let Err(error) = app.emit(EVENT_CODEX, &event) {
                self.diagnostics
                    .push_protocol_error(&format!("Unable to emit Codex event: {error}"));
            }
        }
    }

    fn update_context_from_event(&self, event: &CodexEvent) {
        self.diagnostics.set_context(
            None,
            event.thread_id.clone(),
            event.turn_id.clone().or_else(|| {
                event
                    .turn
                    .as_ref()
                    .filter(|turn| turn.status == "inProgress")
                    .map(|turn| turn.id.clone())
            }),
        );
        if event.kind == "turnCompleted" {
            self.diagnostics
                .set_context(None, event.thread_id.clone(), None);
        }
        if event.kind == "threadSettingsUpdated" {
            if let Some(settings) = event.data.as_ref() {
                self.diagnostics.set_effective_settings(
                    settings
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    settings
                        .get("effort")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    settings
                        .pointer("/activePermissionProfile/id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    settings.get("approvalPolicy").map(protocol::value_label),
                    settings
                        .pointer("/sandboxPolicy/type")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                );
            }
        }
    }

    async fn handle_exit(self: Arc<Self>, generation: u64, exit: diagnostics::ProcessExitInfo) {
        if generation != self.generation.load(Ordering::Acquire) {
            return;
        }
        self.diagnostics.note_exit(exit.clone());
        self.connection.lock().await.take();
        if self.shutting_down.load(Ordering::Acquire) {
            self.set_state(ConnectionState::Stopped);
            return;
        }
        self.set_state(ConnectionState::Degraded);
        let attempt = self.restart_attempts.fetch_add(1, Ordering::AcqRel) + 1;
        self.diagnostics.set_restart_attempts(attempt);
        if attempt > MAX_AUTOMATIC_RESTARTS {
            self.set_state(ConnectionState::Failed);
            return;
        }
        self.set_state(ConnectionState::Restarting);
        tokio::time::sleep(Duration::from_millis(350 * u64::from(attempt))).await;
        if let Err(error) = self.ensure_connection().await {
            self.diagnostics.push_protocol_error(&format!(
                "Codex automatic restart {attempt} failed: {error:#}"
            ));
            if attempt >= MAX_AUTOMATIC_RESTARTS {
                self.set_state(ConnectionState::Failed);
            }
        }
    }

    fn set_state(&self, state: ConnectionState) {
        self.diagnostics.set_state(state);
        if let Some(app) = self.app.get() {
            let _ = app.emit(EVENT_RUNTIME_STATE, self.diagnostics());
        }
    }
}

fn rpc_error(error: RpcError) -> anyhow::Error {
    anyhow!(error.to_string())
}

#[cfg(test)]
mod contract_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{json, Value};

    use super::diagnostics::DiagnosticsState;
    use super::protocol::ServerRequestResponse;
    use super::rpc::{RequestOptions, RpcConnection, WireEvent};
    use super::{process, ConnectionState};

    #[tokio::test]
    #[ignore = "requires the locally installed, authenticated Codex app-server"]
    async fn real_app_server_contract() {
        if std::env::var_os("ATCONTROLLER_RUN_CODEX_CONTRACT").is_none() {
            eprintln!("skipped: set ATCONTROLLER_RUN_CODEX_CONTRACT=1");
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "ATController contract workspace with spaces {}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("temporary contract workspace should exist");
        let git_status = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .expect("git should launch");
        assert!(
            git_status.success(),
            "temporary Git repository should initialize"
        );

        let Ok(spec) = process::discover().await else {
            eprintln!("skipped: an app-server-capable Codex CLI is unavailable");
            let _ = std::fs::remove_dir_all(&root);
            return;
        };
        let diagnostics = Arc::new(DiagnosticsState::default());
        diagnostics.set_state(ConnectionState::Initializing);
        let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<WireEvent>(256);
        let connection = RpcConnection::spawn(
            &spec,
            diagnostics,
            Arc::new(move |event| {
                let _ = events_tx.try_send(event);
            }),
            Arc::new(|exit| eprintln!("contract app-server exit: {}", exit.summary)),
        )
        .await
        .expect("initialize handshake should succeed");
        let pid = connection.pid();
        let idempotent = RequestOptions::idempotent(Duration::from_secs(30));

        let models = connection
            .request(
                "model/list",
                json!({"limit":100,"includeHidden":false}),
                idempotent,
            )
            .await
            .expect("model/list should succeed");
        assert!(
            models
                .get("data")
                .and_then(Value::as_array)
                .is_some_and(|models| !models.is_empty()),
            "model catalog should not be empty"
        );
        let account = connection
            .request("account/read", json!({"refreshToken":false}), idempotent)
            .await
            .expect("account/read should succeed");
        if account.get("account").is_none_or(Value::is_null) {
            eprintln!("skipped remaining contract: Codex is not authenticated");
            connection.shutdown().await;
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let started = connection
            .request(
                "thread/start",
                json!({
                    "cwd": root.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                    "serviceName": "ATController-contract",
                    "threadSource": "atcontroller"
                }),
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await
            .expect("thread/start should succeed");
        let thread_id = started["thread"]["id"]
            .as_str()
            .expect("thread id should be present")
            .to_string();

        connection
            .request(
                "thread/name/set",
                json!({"threadId":thread_id,"name":"ATController contract test"}),
                RequestOptions::default(),
            )
            .await
            .expect("thread/name/set should succeed");
        let turn = connection
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{
                        "type": "text",
                        "text": "Reply with exactly: ATController contract OK",
                        "text_elements": []
                    }]
                }),
                RequestOptions {
                    timeout: Duration::from_secs(45),
                    idempotent: false,
                },
            )
            .await
            .expect("turn/start should succeed");
        let turn_id = turn["turn"]["id"]
            .as_str()
            .expect("turn id should be present")
            .to_string();

        let completed = tokio::time::timeout(Duration::from_secs(180), async {
            while let Some(event) = events_rx.recv().await {
                if let WireEvent::Notification { method, params } = event {
                    if method == "turn/completed"
                        && params["threadId"] == thread_id
                        && params["turn"]["id"] == turn_id
                    {
                        return params;
                    }
                }
            }
            panic!("Codex event channel closed before turn completion");
        })
        .await
        .expect("real Codex turn should complete");
        assert_eq!(completed["turn"]["status"], "completed");

        let read = connection
            .request(
                "thread/read",
                json!({"threadId":thread_id,"includeTurns":true}),
                idempotent,
            )
            .await
            .expect("thread/read should succeed");
        assert!(
            read["thread"]["turns"]
                .as_array()
                .is_some_and(|turns| !turns.is_empty()),
            "structured history should include the completed turn"
        );
        connection
            .request(
                "thread/resume",
                json!({
                    "threadId":thread_id,
                    "cwd":root.to_string_lossy(),
                    "approvalPolicy":"never",
                    "sandbox":"danger-full-access"
                }),
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await
            .expect("thread/resume should succeed");
        connection
            .request(
                "thread/archive",
                json!({"threadId":thread_id}),
                RequestOptions::default(),
            )
            .await
            .expect("thread/archive should succeed");
        connection
            .request(
                "thread/unarchive",
                json!({"threadId":thread_id}),
                RequestOptions::default(),
            )
            .await
            .expect("thread/unarchive should succeed");
        let delete_result = connection
            .request(
                "thread/delete",
                json!({"threadId":thread_id}),
                RequestOptions::default(),
            )
            .await;
        if let Err(error) = delete_result {
            if error.message.contains("no such table: agent_jobs") {
                eprintln!(
                    "runtime compatibility skip: thread/delete removed the rollout but Codex \
                     0.144.0 could not clean its stale agent_jobs state: {error}"
                );
            } else {
                panic!("temporary thread should delete: {error:?}");
            }
        }

        connection.shutdown().await;
        tokio::time::sleep(Duration::from_millis(900)).await;
        #[cfg(unix)]
        assert!(
            !process::signal_process_group(pid, 0),
            "app-server process group must not remain after shutdown"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    #[ignore = "uses the installed authenticated Codex runtime for a temporary-project workflow"]
    async fn real_app_server_e2e() {
        if std::env::var_os("ATCONTROLLER_RUN_CODEX_E2E").is_none() {
            eprintln!("skipped: set ATCONTROLLER_RUN_CODEX_E2E=1");
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "ATController E2E workspace with spaces {}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("temporary E2E workspace should exist");
        assert!(
            std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&root)
                .status()
                .is_ok_and(|status| status.success()),
            "temporary Git repository should initialize"
        );
        std::fs::write(
            root.join("README.md"),
            "# Temporary ATController E2E project\n",
        )
        .expect("fixture should be writable");
        let _ = std::process::Command::new("git")
            .args(["add", "README.md"])
            .current_dir(&root)
            .status();
        let _ = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=ATController E2E",
                "-c",
                "user.email=atcontroller@example.invalid",
                "commit",
                "-qm",
                "initial",
            ])
            .current_dir(&root)
            .status();

        let Ok(spec) = process::discover().await else {
            eprintln!("skipped: an app-server-capable Codex CLI is unavailable");
            let _ = std::fs::remove_dir_all(&root);
            return;
        };
        let diagnostics = Arc::new(DiagnosticsState::default());
        let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<WireEvent>(256);
        let connection = RpcConnection::spawn(
            &spec,
            diagnostics,
            Arc::new(move |event| {
                let _ = events_tx.try_send(event);
            }),
            Arc::new(|exit| eprintln!("E2E app-server exit: {}", exit.summary)),
        )
        .await
        .expect("E2E app-server should initialize");
        let first_pid = connection.pid();
        let idempotent = RequestOptions::idempotent(Duration::from_secs(45));
        let account = connection
            .request("account/read", json!({"refreshToken":false}), idempotent)
            .await
            .expect("account/read should succeed");
        if account.get("account").is_none_or(Value::is_null) {
            eprintln!("skipped: Codex authentication is required");
            connection.shutdown().await;
            let _ = std::fs::remove_dir_all(&root);
            return;
        }

        let started = connection
            .request(
                "thread/start",
                json!({
                    "cwd": root.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                    "serviceName": "ATController-e2e",
                    "threadSource": "atcontroller"
                }),
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await
            .expect("Full Access thread should start");
        let thread_id = started["thread"]["id"]
            .as_str()
            .expect("thread identifier should be present")
            .to_string();
        connection
            .request(
                "thread/name/set",
                json!({"threadId":thread_id,"name":"ATController real E2E"}),
                RequestOptions::default(),
            )
            .await
            .expect("thread rename should succeed");

        let turn = connection
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{
                        "type":"text",
                        "text":"Create a file named atcontroller-e2e.txt in this repository containing exactly the line `created by ATController structured E2E`. Use a shell command or file edit tool, verify the file, then briefly report completion.",
                        "text_elements":[]
                    }],
                    "cwd": root.to_string_lossy(),
                    "approvalPolicy":"never",
                    "sandboxPolicy":{"type":"dangerFullAccess"}
                }),
                RequestOptions {
                    timeout: Duration::from_secs(45),
                    idempotent: false,
                },
            )
            .await
            .expect("structured file-creation turn should start");
        let turn_id = turn["turn"]["id"]
            .as_str()
            .expect("turn identifier should be present")
            .to_string();
        let mut saw_command = false;
        let mut saw_file_change = false;
        let mut saw_agent_stream = false;
        let completed = tokio::time::timeout(Duration::from_secs(240), async {
            while let Some(event) = events_rx.recv().await {
                if let WireEvent::Notification { method, params } = event {
                    if method == "item/started" && params["turnId"] == turn_id {
                        saw_command |= params["item"]["type"] == "commandExecution";
                        saw_file_change |= params["item"]["type"] == "fileChange";
                    }
                    if method == "item/agentMessage/delta" && params["turnId"] == turn_id {
                        saw_agent_stream = true;
                    }
                    if method == "turn/completed"
                        && params["threadId"] == thread_id
                        && params["turn"]["id"] == turn_id
                    {
                        return params;
                    }
                }
            }
            panic!("event stream ended before file-creation completion");
        })
        .await
        .expect("real file-creation turn should complete");
        assert_eq!(completed["turn"]["status"], "completed");
        assert!(
            saw_command || saw_file_change,
            "Codex should expose command or file-change activity"
        );
        assert!(
            saw_agent_stream,
            "agent response should stream as structured deltas"
        );
        let created_file = root.join("atcontroller-e2e.txt");
        assert!(
            std::fs::read_to_string(&created_file)
                .is_ok_and(|content| content.trim() == "created by ATController structured E2E"),
            "Codex should create the requested file on disk"
        );
        assert!(
            !std::process::Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(&root)
                .output()
                .expect("git status should run")
                .stdout
                .is_empty(),
            "the temporary working tree should reflect the edit"
        );

        let listed = connection
            .request(
                "thread/list",
                json!({
                    "cwd":root.to_string_lossy(),
                    "archived":false,
                    "limit":100,
                    "sortKey":"recency_at",
                    "sortDirection":"desc"
                }),
                idempotent,
            )
            .await
            .expect("thread/list should succeed");
        assert!(
            listed["data"]
                .as_array()
                .is_some_and(|threads| threads.iter().any(|thread| thread["id"] == thread_id)),
            "the new thread should be discoverable by its workspace"
        );

        connection.shutdown().await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        #[cfg(unix)]
        assert!(
            !process::signal_process_group(first_pid, 0),
            "first app-server process must stop before recovery"
        );

        let diagnostics = Arc::new(DiagnosticsState::default());
        let (recovery_tx, mut recovery_rx) = tokio::sync::mpsc::channel::<WireEvent>(256);
        let recovery = RpcConnection::spawn(
            &spec,
            diagnostics,
            Arc::new(move |event| {
                let _ = recovery_tx.try_send(event);
            }),
            Arc::new(|exit| eprintln!("E2E recovery app-server exit: {}", exit.summary)),
        )
        .await
        .expect("replacement app-server should initialize");
        let recovery_pid = recovery.pid();
        recovery
            .request(
                "thread/resume",
                json!({
                    "threadId":thread_id,
                    "cwd":root.to_string_lossy(),
                    "approvalPolicy":"never",
                    "sandbox":"danger-full-access"
                }),
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await
            .expect("thread should resume after runtime restart");
        let continuation = recovery
            .request(
                "turn/start",
                json!({
                    "threadId":thread_id,
                    "input":[{
                        "type":"text",
                        "text":"Append a second line containing exactly `resumed successfully` to atcontroller-e2e.txt, verify it, and reply briefly.",
                        "text_elements":[]
                    }],
                    "cwd":root.to_string_lossy(),
                    "approvalPolicy":"never",
                    "sandboxPolicy":{"type":"dangerFullAccess"}
                }),
                RequestOptions {
                    timeout: Duration::from_secs(45),
                    idempotent: false,
                },
            )
            .await
            .expect("continued turn should start");
        let continuation_id = continuation["turn"]["id"]
            .as_str()
            .expect("continued turn identifier should exist")
            .to_string();
        tokio::time::timeout(Duration::from_secs(240), async {
            while let Some(event) = recovery_rx.recv().await {
                if let WireEvent::Notification { method, params } = event {
                    if method == "turn/completed" && params["turn"]["id"] == continuation_id {
                        assert_eq!(params["turn"]["status"], "completed");
                        return;
                    }
                }
            }
            panic!("recovery event stream ended before completion");
        })
        .await
        .expect("continued turn should complete");
        assert!(
            std::fs::read_to_string(&created_file)
                .is_ok_and(|content| content.lines().any(|line| line == "resumed successfully")),
            "continued thread should modify the existing file"
        );

        let interrupting = recovery
            .request(
                "turn/start",
                json!({
                    "threadId":thread_id,
                    "input":[{
                        "type":"text",
                        "text":"Run the shell command `sleep 60`, wait for it to finish, then reply with `sleep finished`.",
                        "text_elements":[]
                    }],
                    "cwd":root.to_string_lossy(),
                    "approvalPolicy":"never",
                    "sandboxPolicy":{"type":"dangerFullAccess"}
                }),
                RequestOptions {
                    timeout: Duration::from_secs(45),
                    idempotent: false,
                },
            )
            .await
            .expect("interruptible turn should start");
        let interrupting_id = interrupting["turn"]["id"]
            .as_str()
            .expect("interruptible turn identifier should exist")
            .to_string();
        let mut interrupt_sent = false;
        tokio::time::timeout(Duration::from_secs(90), async {
            while let Some(event) = recovery_rx.recv().await {
                if let WireEvent::Notification { method, params } = event {
                    if method == "item/started"
                        && params["turnId"] == interrupting_id
                        && params["item"]["type"] == "commandExecution"
                        && !interrupt_sent
                    {
                        recovery
                            .request(
                                "turn/interrupt",
                                json!({"threadId":thread_id,"turnId":interrupting_id}),
                                RequestOptions {
                                    timeout: Duration::from_secs(30),
                                    idempotent: false,
                                },
                            )
                            .await
                            .expect("turn/interrupt should succeed");
                        interrupt_sent = true;
                    }
                    if method == "turn/completed" && params["turn"]["id"] == interrupting_id {
                        assert!(
                            interrupt_sent,
                            "turn should be interrupted while a command runs"
                        );
                        assert!(
                            matches!(
                                params["turn"]["status"].as_str(),
                                Some("interrupted" | "failed")
                            ),
                            "interrupted turn should not report successful completion: {}",
                            params["turn"]["status"]
                        );
                        return;
                    }
                }
            }
            panic!("recovery event stream ended before interrupted turn completed");
        })
        .await
        .expect("interruptible turn should stop promptly");

        let standard = recovery
            .request(
                "thread/start",
                json!({
                    "cwd":root.to_string_lossy(),
                    "approvalPolicy":"on-request",
                    "sandbox":"read-only",
                    "serviceName":"ATController-e2e-standard",
                    "threadSource":"atcontroller"
                }),
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await
            .expect("Standard permission thread should start");
        let standard_thread_id = standard["thread"]["id"]
            .as_str()
            .expect("Standard thread identifier should exist")
            .to_string();
        let standard_turn = recovery
            .request(
                "turn/start",
                json!({
                    "threadId":standard_thread_id,
                    "input":[{
                        "type":"text",
                        "text":"Use a shell command to create a file named standard-denied.txt in this repository. Do not use another mechanism.",
                        "text_elements":[]
                    }],
                    "cwd":root.to_string_lossy(),
                    "approvalPolicy":"on-request",
                    "sandboxPolicy":{"type":"readOnly","networkAccess":false}
                }),
                RequestOptions {
                    timeout: Duration::from_secs(45),
                    idempotent: false,
                },
            )
            .await
            .expect("Standard permission turn should start");
        let standard_turn_id = standard_turn["turn"]["id"]
            .as_str()
            .expect("Standard turn identifier should exist")
            .to_string();
        let mut saw_standard_approval = false;
        tokio::time::timeout(Duration::from_secs(180), async {
            while let Some(event) = recovery_rx.recv().await {
                match event {
                    WireEvent::ServerRequest { id, method, .. }
                        if method == "item/commandExecution/requestApproval"
                            || method == "execCommandApproval" =>
                    {
                        saw_standard_approval = true;
                        recovery
                            .respond_to_server_request(ServerRequestResponse::Command {
                                request_id: id,
                                decision: "decline".to_string(),
                            })
                            .await
                            .expect("command approval denial should be delivered");
                    }
                    WireEvent::ServerRequest { id, method, .. }
                        if method == "item/fileChange/requestApproval"
                            || method == "applyPatchApproval" =>
                    {
                        saw_standard_approval = true;
                        recovery
                            .respond_to_server_request(ServerRequestResponse::FileChange {
                                request_id: id,
                                decision: "decline".to_string(),
                            })
                            .await
                            .expect("file approval denial should be delivered");
                    }
                    WireEvent::Notification { method, params }
                        if method == "turn/completed"
                            && params["turn"]["id"] == standard_turn_id =>
                    {
                        return;
                    }
                    _ => {}
                }
            }
            panic!("event stream ended before Standard permission turn completed");
        })
        .await
        .expect("Standard permission turn should complete after denial");
        assert!(
            saw_standard_approval,
            "Standard permissions should surface a structured approval request"
        );
        assert!(
            !root.join("standard-denied.txt").exists(),
            "denied Standard permission action must not modify the project"
        );

        let invalid = recovery
            .request(
                "thread/read",
                json!({"threadId":"00000000-0000-0000-0000-000000000000","includeTurns":true}),
                idempotent,
            )
            .await;
        assert!(
            invalid.is_err(),
            "an invalid thread identifier should fail cleanly"
        );

        recovery
            .request(
                "thread/archive",
                json!({"threadId":thread_id}),
                RequestOptions::default(),
            )
            .await
            .expect("temporary thread should archive");
        recovery
            .request(
                "thread/unarchive",
                json!({"threadId":thread_id}),
                RequestOptions::default(),
            )
            .await
            .expect("temporary thread should restore");
        let _ = recovery
            .request(
                "thread/archive",
                json!({"threadId":standard_thread_id}),
                RequestOptions::default(),
            )
            .await;
        let _ = recovery
            .request(
                "thread/delete",
                json!({"threadId":standard_thread_id}),
                RequestOptions::default(),
            )
            .await;
        let deleted = recovery
            .request(
                "thread/delete",
                json!({"threadId":thread_id}),
                RequestOptions::default(),
            )
            .await;
        if let Err(error) = deleted {
            assert!(
                error.message.contains("no such table: agent_jobs"),
                "unexpected thread deletion failure: {error:?}"
            );
        }
        recovery.shutdown().await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        #[cfg(unix)]
        assert!(
            !process::signal_process_group(recovery_pid, 0),
            "replacement app-server process must stop after E2E"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
