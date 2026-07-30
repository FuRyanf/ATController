use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::codex::protocol::{redact_browser_url, BrowserActivity, CodexEvent};
use crate::codex::{process, CodexRuntime};
use crate::storage;

pub const EVENT_BROWSER_STATE: &str = "browser:state";
pub const PLAYWRIGHT_SERVER_NAME: &str = "atcontroller-playwright";
pub const PLAYWRIGHT_PACKAGE: &str = "@playwright/mcp";
pub const PLAYWRIGHT_PACKAGE_VERSION: &str = "0.0.77";

const SESSION_STORE_VERSION: u32 = 1;
const SESSION_STORE_FILE: &str = "browser-sessions.json";
const CACHE_SUBDIRECTORY: &str = "browser-cache/playwright";
const MAX_SCREENSHOT_BYTES: u64 = 24 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 160;
const MAX_RECENT_ACTIVITIES: usize = 40;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const TOOL_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDependency {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub detail: Option<String>,
}

impl BrowserDependency {
    fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            available: false,
            path: None,
            version: None,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserMcpConfiguration {
    pub server_name: String,
    pub configured: bool,
    pub managed_by_atcontroller: bool,
    pub command: Option<String>,
    pub arguments: Vec<String>,
    pub package: String,
    pub package_version: String,
    pub isolated: bool,
    pub headed: bool,
    pub output_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDiagnostics {
    pub node: BrowserDependency,
    pub npx: BrowserDependency,
    pub browser: BrowserDependency,
    pub playwright_browsers_available: bool,
    pub configuration: BrowserMcpConfiguration,
    pub codex_can_see_server: bool,
    pub codex_can_see_browser_tools: bool,
    pub tool_names: Vec<String>,
    pub mcp_server_version: Option<String>,
    pub mcp_process_id: Option<u32>,
    pub browser_process_id: Option<u32>,
    pub screenshot_cache_path: String,
    pub connection_state: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSetupPlan {
    pub ready: bool,
    pub can_configure: bool,
    pub requires_replacement: bool,
    pub command: String,
    pub server_name: String,
    pub package: String,
    pub package_version: String,
    pub effects: Vec<String>,
    pub blockers: Vec<String>,
    pub existing_configuration: Option<BrowserMcpConfiguration>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserSessionState {
    Unavailable,
    NotConfigured,
    #[default]
    Stopped,
    Starting,
    Ready,
    CodexActive,
    UserActive,
    Disconnected,
    Failed,
    Stopping,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserControlOwner {
    #[default]
    Codex,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionMetadata {
    pub thread_id: String,
    pub workspace_path: String,
    pub browser_session_id: String,
    pub page_id: Option<String>,
    pub state: BrowserSessionState,
    pub last_url: Option<String>,
    pub last_page_title: Option<String>,
    pub panel_visible: bool,
    pub window_visible: bool,
    pub last_screenshot_reference: Option<String>,
    pub control_owner: BrowserControlOwner,
    pub last_activity_at: DateTime<Utc>,
    pub failure: Option<String>,
    pub console_error_count: u32,
    pub failed_request_count: u32,
    pub recent_activities: Vec<BrowserActivity>,
}

impl BrowserSessionMetadata {
    fn new(thread_id: &str, workspace_path: &str) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            workspace_path: workspace_path.to_string(),
            browser_session_id: Uuid::new_v4().to_string(),
            page_id: None,
            state: BrowserSessionState::Stopped,
            last_url: None,
            last_page_title: None,
            panel_visible: false,
            window_visible: false,
            last_screenshot_reference: None,
            control_owner: BrowserControlOwner::Codex,
            last_activity_at: Utc::now(),
            failure: None,
            console_error_count: 0,
            failed_request_count: 0,
            recent_activities: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserAction {
    Open,
    TakeScreenshot,
    RefreshState,
    InspectConsole,
    InspectNetwork,
    TakeControl,
    ReturnToCodex,
    Restart,
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionRequest {
    pub thread_id: String,
    pub workspace_path: String,
    pub action: BrowserAction,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSelfTestResult {
    pub ok: bool,
    pub server_name: String,
    pub package_version: String,
    pub page_title: String,
    pub page_url: String,
    pub screenshot_reference: String,
    pub tools_seen: usize,
    pub browser_closed: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    pub reference: String,
    pub path: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSessionStore {
    version: u32,
    sessions: BTreeMap<String, BrowserSessionMetadata>,
}

impl Default for BrowserSessionStore {
    fn default() -> Self {
        Self {
            version: SESSION_STORE_VERSION,
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Clone)]
pub struct BrowserRuntime {
    inner: Arc<BrowserRuntimeInner>,
}

struct BrowserRuntimeInner {
    app: OnceLock<AppHandle>,
    sessions: Mutex<BTreeMap<String, BrowserSessionMetadata>>,
    last_error: Mutex<Option<String>>,
}

impl Default for BrowserRuntime {
    fn default() -> Self {
        let mut sessions = load_session_store()
            .map(|store| store.sessions)
            .unwrap_or_default();
        if normalize_restored_sessions(&mut sessions) {
            let _ = persist_sessions(&sessions);
        }
        Self {
            inner: Arc::new(BrowserRuntimeInner {
                app: OnceLock::new(),
                sessions: Mutex::new(sessions),
                last_error: Mutex::new(None),
            }),
        }
    }
}

impl BrowserRuntime {
    pub fn attach(&self, app: AppHandle) {
        let _ = self.inner.app.set(app);
        let _ = cleanup_cache();
    }

    pub fn session(&self, thread_id: &str) -> Result<BrowserSessionMetadata> {
        validate_identifier(thread_id, "thread identifier")?;
        let sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| anyhow!("Browser session lock poisoned"))?;
        sessions
            .get(thread_id)
            .cloned()
            .ok_or_else(|| anyhow!("No browser session exists for this thread"))
    }

    pub fn sessions(&self) -> Result<Vec<BrowserSessionMetadata>> {
        let sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| anyhow!("Browser session lock poisoned"))?;
        let mut result = sessions.values().cloned().collect::<Vec<_>>();
        result.sort_by_key(|session| std::cmp::Reverse(session.last_activity_at));
        Ok(result)
    }

    pub fn observe_codex_event(&self, event: &CodexEvent) {
        let Some(thread_id) = event.thread_id.as_deref() else {
            return;
        };
        let Some(mut activity) = event
            .item
            .as_ref()
            .and_then(|item| item.browser_activity.clone())
        else {
            return;
        };
        if validate_identifier(thread_id, "thread identifier").is_err() {
            return;
        }
        activity.thread_id = Some(thread_id.to_string());
        activity.turn_id = event.turn_id.clone();
        let session = {
            let Ok(mut sessions) = self.inner.sessions.lock() else {
                return;
            };
            let session = sessions
                .entry(thread_id.to_string())
                .or_insert_with(|| BrowserSessionMetadata::new(thread_id, ""));
            activity.browser_session_id = Some(session.browser_session_id.clone());
            apply_activity(session, &activity);
            let snapshot = session.clone();
            if persist_sessions(&sessions).is_err() {
                return;
            }
            snapshot
        };
        self.emit_session(&session);
    }

    pub fn mark_disconnected(&self) {
        let changed = {
            let Ok(mut sessions) = self.inner.sessions.lock() else {
                return;
            };
            let mut changed = Vec::new();
            for session in sessions.values_mut() {
                if !matches!(
                    session.state,
                    BrowserSessionState::Stopped
                        | BrowserSessionState::Unavailable
                        | BrowserSessionState::NotConfigured
                ) {
                    session.state = BrowserSessionState::Disconnected;
                    session.last_activity_at = Utc::now();
                    changed.push(session.clone());
                }
            }
            let _ = persist_sessions(&sessions);
            changed
        };
        for session in changed {
            self.emit_session(&session);
        }
    }

    pub async fn setup_plan(&self) -> Result<BrowserSetupPlan> {
        let environment = tokio::task::spawn_blocking(detect_environment)
            .await
            .context("Browser dependency detection task failed")??;
        let spec = process::discover().await?;
        let configurations = {
            let spec_for_list = spec.clone();
            tokio::task::spawn_blocking(move || list_mcp_configurations(&spec_for_list))
                .await
                .context("Codex MCP discovery task failed")??
        };
        build_setup_plan(
            &environment,
            configurations.get(PLAYWRIGHT_SERVER_NAME).cloned(),
            &spec.binary_path,
        )
    }

    pub async fn configure(&self, codex: Arc<CodexRuntime>) -> Result<BrowserDiagnostics> {
        let environment = tokio::task::spawn_blocking(detect_environment)
            .await
            .context("Browser dependency detection task failed")??;
        let spec = process::discover().await?;
        let configurations = {
            let spec = spec.clone();
            tokio::task::spawn_blocking(move || list_mcp_configurations(&spec))
                .await
                .context("Codex MCP discovery task failed")??
        };
        let plan = build_setup_plan(
            &environment,
            configurations.get(PLAYWRIGHT_SERVER_NAME).cloned(),
            &spec.binary_path,
        )?;
        if !plan.can_configure {
            return Err(anyhow!(plan.blockers.join(" ")));
        }
        if plan.ready {
            return self.diagnostics(codex, None).await;
        }
        if plan.requires_replacement {
            let existing = configurations
                .get(PLAYWRIGHT_SERVER_NAME)
                .ok_or_else(|| anyhow!("The existing Playwright MCP configuration disappeared"))?;
            if !existing.managed_by_atcontroller {
                return Err(anyhow!(
                    "ATController will not replace an MCP server it does not manage"
                ));
            }
            let spec_for_remove = spec.clone();
            tokio::task::spawn_blocking(move || {
                run_codex_cli(
                    &spec_for_remove,
                    &[
                        OsString::from("mcp"),
                        OsString::from("remove"),
                        OsString::from(PLAYWRIGHT_SERVER_NAME),
                    ],
                    COMMAND_TIMEOUT,
                )
            })
            .await
            .context("Playwright MCP removal task failed")??;
        }
        let args = setup_cli_arguments(&environment)?;
        let spec_for_add = spec.clone();
        tokio::task::spawn_blocking(move || run_codex_cli(&spec_for_add, &args, COMMAND_TIMEOUT))
            .await
            .context("Playwright MCP configuration task failed")??;
        codex.reload_mcp_servers().await?;
        self.diagnostics(codex, None).await
    }

    pub async fn diagnostics(
        &self,
        codex: Arc<CodexRuntime>,
        thread_id: Option<String>,
    ) -> Result<BrowserDiagnostics> {
        if let Some(thread_id) = thread_id.as_deref() {
            validate_identifier(thread_id, "thread identifier")?;
        }
        let environment = tokio::task::spawn_blocking(detect_environment)
            .await
            .context("Browser dependency detection task failed")??;
        let spec = process::discover().await?;
        let configurations = {
            let spec = spec.clone();
            tokio::task::spawn_blocking(move || list_mcp_configurations(&spec))
                .await
                .context("Codex MCP discovery task failed")??
        };
        let configuration = configurations
            .get(PLAYWRIGHT_SERVER_NAME)
            .cloned()
            .unwrap_or_else(|| desired_configuration(&environment));
        let mut tool_names = Vec::new();
        let mut can_see_server = false;
        let mut server_version = None;
        let mut connection_state = if configuration.configured {
            "configured".to_string()
        } else {
            "notConfigured".to_string()
        };
        let mut runtime_error = None;
        if configuration.configured {
            match codex.mcp_server_status(thread_id.clone()).await {
                Ok(statuses) => {
                    if let Some(status) = statuses
                        .get("data")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .find(|status| {
                            status.get("name").and_then(Value::as_str)
                                == Some(PLAYWRIGHT_SERVER_NAME)
                        })
                    {
                        can_see_server = true;
                        connection_state = "ready".to_string();
                        server_version = status
                            .pointer("/serverInfo/version")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        tool_names = status
                            .get("tools")
                            .and_then(Value::as_object)
                            .map(|tools| tools.keys().cloned().collect::<Vec<_>>())
                            .unwrap_or_default();
                        tool_names.sort();
                    }
                }
                Err(error) => {
                    connection_state = "failed".to_string();
                    runtime_error = Some(error.to_string());
                }
            }
        }
        let last_error = runtime_error.or_else(|| {
            self.inner
                .last_error
                .lock()
                .ok()
                .and_then(|error| error.clone())
        });
        Ok(BrowserDiagnostics {
            node: environment.node,
            npx: environment.npx,
            browser: environment.browser,
            playwright_browsers_available: environment.playwright_cached_browser.is_some(),
            configuration,
            codex_can_see_server: can_see_server,
            codex_can_see_browser_tools: tool_names.iter().any(|tool| tool.starts_with("browser_")),
            tool_names,
            mcp_server_version: server_version,
            mcp_process_id: None,
            browser_process_id: None,
            screenshot_cache_path: cache_root()?.to_string_lossy().to_string(),
            connection_state,
            last_error,
        })
    }

    pub async fn perform_action(
        &self,
        codex: Arc<CodexRuntime>,
        request: BrowserActionRequest,
    ) -> Result<BrowserSessionMetadata> {
        let thread_id = request.thread_id.clone();
        match self.perform_action_inner(codex, request).await {
            Ok(session) => Ok(session),
            Err(error) => {
                let message = error.to_string();
                self.record_failure(&thread_id, &message);
                Err(error)
            }
        }
    }

    async fn perform_action_inner(
        &self,
        codex: Arc<CodexRuntime>,
        request: BrowserActionRequest,
    ) -> Result<BrowserSessionMetadata> {
        validate_identifier(&request.thread_id, "thread identifier")?;
        let workspace_path = process::validate_workspace_path(&request.workspace_path)?;
        let mut session = self.ensure_session(&request.thread_id, &workspace_path)?;
        match request.action {
            BrowserAction::TakeControl => {
                session.control_owner = BrowserControlOwner::User;
                session.state = BrowserSessionState::UserActive;
                session.window_visible = true;
                session.failure = None;
                session.last_activity_at = Utc::now();
                return self.store_session(session);
            }
            BrowserAction::ReturnToCodex => {
                session.control_owner = BrowserControlOwner::Codex;
                session.state = BrowserSessionState::Starting;
                session.failure = None;
                self.store_session(session.clone())?;
                let snapshot = codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_snapshot",
                        json!({ "depth": 4 }),
                        TOOL_TIMEOUT,
                    )
                    .await?;
                update_session_from_tool_result(&mut session, "browser_snapshot", &snapshot);
                self.capture_screenshot(&codex, &mut session).await?;
                session.state = BrowserSessionState::Ready;
            }
            BrowserAction::Open => {
                session.control_owner = BrowserControlOwner::Codex;
                session.state = BrowserSessionState::Starting;
                session.window_visible = true;
                session.failure = None;
                self.store_session(session.clone())?;
                let url = validate_navigation_url(request.url.as_deref().unwrap_or("about:blank"))?;
                let result = codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_navigate",
                        json!({ "url": url }),
                        TOOL_TIMEOUT,
                    )
                    .await?;
                update_session_from_tool_result(&mut session, "browser_navigate", &result);
                session.state = BrowserSessionState::Ready;
            }
            BrowserAction::TakeScreenshot => {
                self.capture_screenshot(&codex, &mut session).await?;
                session.state = match session.control_owner {
                    BrowserControlOwner::Codex => BrowserSessionState::Ready,
                    BrowserControlOwner::User => BrowserSessionState::UserActive,
                };
            }
            BrowserAction::RefreshState => {
                let result = codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_snapshot",
                        json!({ "depth": 4 }),
                        TOOL_TIMEOUT,
                    )
                    .await?;
                update_session_from_tool_result(&mut session, "browser_snapshot", &result);
            }
            BrowserAction::InspectConsole => {
                let result = codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_console_messages",
                        json!({ "level": "error", "all": false }),
                        TOOL_TIMEOUT,
                    )
                    .await?;
                update_session_from_tool_result(&mut session, "browser_console_messages", &result);
            }
            BrowserAction::InspectNetwork => {
                let result = codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_network_requests",
                        json!({ "static": false }),
                        TOOL_TIMEOUT,
                    )
                    .await?;
                update_session_from_tool_result(&mut session, "browser_network_requests", &result);
            }
            BrowserAction::Restart => {
                session.state = BrowserSessionState::Stopping;
                self.store_session(session.clone())?;
                let _ = codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_close",
                        json!({}),
                        Duration::from_secs(30),
                    )
                    .await;
                let url = validate_navigation_url(
                    request
                        .url
                        .as_deref()
                        .or(session.last_url.as_deref())
                        .unwrap_or("about:blank"),
                )?;
                session.state = BrowserSessionState::Starting;
                self.store_session(session.clone())?;
                let result = codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_navigate",
                        json!({ "url": url }),
                        TOOL_TIMEOUT,
                    )
                    .await?;
                update_session_from_tool_result(&mut session, "browser_navigate", &result);
                session.state = BrowserSessionState::Ready;
                session.window_visible = true;
            }
            BrowserAction::Stop => {
                session.state = BrowserSessionState::Stopping;
                self.store_session(session.clone())?;
                codex
                    .call_mcp_tool(
                        &request.thread_id,
                        PLAYWRIGHT_SERVER_NAME,
                        "browser_close",
                        json!({}),
                        Duration::from_secs(30),
                    )
                    .await?;
                session.state = BrowserSessionState::Stopped;
                session.window_visible = false;
                session.control_owner = BrowserControlOwner::Codex;
            }
        }
        session.last_activity_at = Utc::now();
        session.failure = None;
        self.store_session(session)
    }

    pub async fn self_test(
        &self,
        codex: Arc<CodexRuntime>,
        thread_id: String,
        workspace_path: String,
    ) -> Result<BrowserSelfTestResult> {
        validate_identifier(&thread_id, "thread identifier")?;
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        let started = Instant::now();
        let diagnostics = self
            .diagnostics(codex.clone(), Some(thread_id.clone()))
            .await?;
        if !diagnostics.configuration.configured {
            return Err(anyhow!(
                "Playwright MCP is not configured. Open Browser Setup first."
            ));
        }
        if !diagnostics.codex_can_see_browser_tools {
            return Err(anyhow!(
                "Codex cannot see the Playwright browser tools. Restart the runtime and retry."
            ));
        }
        let test_server = LocalTestServer::start().await?;
        let page_url = redact_browser_url(&test_server.url);
        let mut session = self.ensure_session(&thread_id, &workspace_path)?;
        session.state = BrowserSessionState::Starting;
        self.store_session(session.clone())?;
        let workflow = async {
            let navigate = codex
                .call_mcp_tool(
                    &thread_id,
                    PLAYWRIGHT_SERVER_NAME,
                    "browser_navigate",
                    json!({ "url": test_server.url.clone() }),
                    TOOL_TIMEOUT,
                )
                .await
                .context("Playwright navigation self test failed")?;
            update_session_from_tool_result(&mut session, "browser_navigate", &navigate);
            let snapshot = codex
                .call_mcp_tool(
                    &thread_id,
                    PLAYWRIGHT_SERVER_NAME,
                    "browser_snapshot",
                    json!({ "depth": 5 }),
                    TOOL_TIMEOUT,
                )
                .await
                .context("Playwright page inspection self test failed")?;
            let snapshot_text = result_text(&snapshot);
            update_session_from_tool_result(&mut session, "browser_snapshot", &snapshot);
            if !snapshot_text.contains("ATController Browser Self Test") {
                return Err(anyhow!(
                    "Playwright opened the test page but did not return its title"
                ));
            }
            self.capture_screenshot(&codex, &mut session)
                .await
                .context("Playwright screenshot self test failed")?;
            let screenshot_reference = session
                .last_screenshot_reference
                .clone()
                .ok_or_else(|| anyhow!("Playwright did not produce a screenshot reference"))?;
            let screenshot_path = resolve_screenshot_reference(&screenshot_reference)?;
            if !screenshot_path.is_file() {
                return Err(anyhow!(
                    "Playwright reported a screenshot but the file is unavailable"
                ));
            }
            Ok::<String, anyhow::Error>(screenshot_reference)
        }
        .await;
        let close_result = codex
            .call_mcp_tool(
                &thread_id,
                PLAYWRIGHT_SERVER_NAME,
                "browser_close",
                json!({}),
                Duration::from_secs(30),
            )
            .await;
        test_server.stop().await;
        let screenshot_reference = match workflow {
            Ok(reference) => reference,
            Err(error) => {
                session.state = BrowserSessionState::Failed;
                session.window_visible = false;
                session.failure = Some(error.to_string());
                let _ = self.store_session(session);
                if let Err(cleanup_error) = close_result {
                    return Err(
                        error.context(format!("Browser cleanup also failed: {cleanup_error}"))
                    );
                }
                return Err(error);
            }
        };
        if let Err(error) = close_result {
            session.state = BrowserSessionState::Failed;
            session.window_visible = false;
            session.failure = Some(error.to_string());
            let _ = self.store_session(session);
            return Err(error).context("Playwright browser cleanup self test failed");
        }
        session.state = BrowserSessionState::Stopped;
        session.window_visible = false;
        session.failure = None;
        self.store_session(session)?;
        Ok(BrowserSelfTestResult {
            ok: true,
            server_name: PLAYWRIGHT_SERVER_NAME.to_string(),
            package_version: PLAYWRIGHT_PACKAGE_VERSION.to_string(),
            page_title: "ATController Browser Self Test".to_string(),
            page_url,
            screenshot_reference,
            tools_seen: diagnostics.tool_names.len(),
            browser_closed: true,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })
    }

    pub async fn shutdown_all(&self, codex: Arc<CodexRuntime>) {
        let active_thread_ids = self
            .sessions()
            .unwrap_or_default()
            .into_iter()
            .filter(|session| {
                !matches!(
                    session.state,
                    BrowserSessionState::Stopped
                        | BrowserSessionState::Unavailable
                        | BrowserSessionState::NotConfigured
                )
            })
            .map(|session| session.thread_id)
            .collect::<Vec<_>>();
        for thread_id in active_thread_ids {
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                codex.call_mcp_tool(
                    &thread_id,
                    PLAYWRIGHT_SERVER_NAME,
                    "browser_close",
                    json!({}),
                    Duration::from_secs(5),
                ),
            )
            .await;
            if let Ok(mut session) = self.session(&thread_id) {
                session.state = BrowserSessionState::Stopped;
                session.window_visible = false;
                let _ = self.store_session(session);
            }
        }
    }

    pub fn read_screenshot(&self, thread_id: &str, reference: &str) -> Result<BrowserScreenshot> {
        validate_identifier(thread_id, "thread identifier")?;
        let session = self.session(thread_id)?;
        let allowed = session
            .recent_activities
            .iter()
            .filter_map(|activity| activity.screenshot_reference.as_deref())
            .chain(session.last_screenshot_reference.as_deref())
            .any(|candidate| candidate == reference);
        if !allowed {
            return Err(anyhow!(
                "This screenshot is not associated with the selected browser session"
            ));
        }
        let path = resolve_screenshot_reference(reference)?;
        let metadata = fs::metadata(&path)
            .with_context(|| format!("Unable to inspect screenshot {}", path.display()))?;
        if !metadata.is_file() || metadata.len() > MAX_SCREENSHOT_BYTES {
            return Err(anyhow!("Screenshot is unavailable or too large"));
        }
        let mime_type = screenshot_mime(&path)?;
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
        File::open(&path)?.read_to_end(&mut bytes)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(BrowserScreenshot {
            reference: reference.to_string(),
            path: path.to_string_lossy().to_string(),
            mime_type: mime_type.to_string(),
            byte_length: metadata.len(),
            data_url: format!("data:{mime_type};base64,{encoded}"),
        })
    }

    pub fn reveal_screenshot(&self, thread_id: &str, reference: &str) -> Result<()> {
        let screenshot = self.read_screenshot(thread_id, reference)?;
        let status = Command::new("/usr/bin/open")
            .args(["-R", &screenshot.path])
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(anyhow!("Finder could not reveal the screenshot"))
        }
    }

    pub fn delete_screenshot(&self, thread_id: &str, reference: &str) -> Result<()> {
        validate_identifier(thread_id, "thread identifier")?;
        let path = resolve_screenshot_reference(reference)?;
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| anyhow!("Browser session lock poisoned"))?;
        let session = sessions
            .get_mut(thread_id)
            .ok_or_else(|| anyhow!("No browser session exists for this thread"))?;
        let associated = session.last_screenshot_reference.as_deref() == Some(reference)
            || session
                .recent_activities
                .iter()
                .any(|activity| activity.screenshot_reference.as_deref() == Some(reference));
        if !associated {
            return Err(anyhow!("Screenshot does not belong to this thread"));
        }
        if path.is_file() {
            fs::remove_file(&path)?;
        }
        if session.last_screenshot_reference.as_deref() == Some(reference) {
            session.last_screenshot_reference = None;
        }
        for activity in &mut session.recent_activities {
            if activity.screenshot_reference.as_deref() == Some(reference) {
                activity.screenshot_reference = None;
            }
        }
        let snapshot = session.clone();
        persist_sessions(&sessions)?;
        drop(sessions);
        self.emit_session(&snapshot);
        Ok(())
    }

    pub fn open_cache(&self) -> Result<()> {
        let root = cache_root()?;
        fs::create_dir_all(&root)?;
        let status = Command::new("/usr/bin/open").arg(&root).status()?;
        if status.success() {
            Ok(())
        } else {
            Err(anyhow!("Finder could not open the browser cache"))
        }
    }

    fn ensure_session(
        &self,
        thread_id: &str,
        workspace_path: &str,
    ) -> Result<BrowserSessionMetadata> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| anyhow!("Browser session lock poisoned"))?;
        let session = sessions
            .entry(thread_id.to_string())
            .or_insert_with(|| BrowserSessionMetadata::new(thread_id, workspace_path));
        if !session.workspace_path.is_empty() && session.workspace_path != workspace_path {
            return Err(anyhow!(
                "Browser session is associated with a different project"
            ));
        }
        session.workspace_path = workspace_path.to_string();
        let snapshot = session.clone();
        persist_sessions(&sessions)?;
        Ok(snapshot)
    }

    fn store_session(&self, session: BrowserSessionMetadata) -> Result<BrowserSessionMetadata> {
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| anyhow!("Browser session lock poisoned"))?;
        sessions.insert(session.thread_id.clone(), session.clone());
        persist_sessions(&sessions)?;
        drop(sessions);
        self.emit_session(&session);
        Ok(session)
    }

    fn record_failure(&self, thread_id: &str, message: &str) {
        if let Ok(mut last_error) = self.inner.last_error.lock() {
            *last_error = Some(message.to_string());
        }
        let snapshot = {
            let Ok(mut sessions) = self.inner.sessions.lock() else {
                return;
            };
            let Some(session) = sessions.get_mut(thread_id) else {
                return;
            };
            session.state = BrowserSessionState::Failed;
            session.failure = Some(message.to_string());
            session.last_activity_at = Utc::now();
            let snapshot = session.clone();
            let _ = persist_sessions(&sessions);
            snapshot
        };
        self.emit_session(&snapshot);
    }

    async fn capture_screenshot(
        &self,
        codex: &Arc<CodexRuntime>,
        session: &mut BrowserSessionMetadata,
    ) -> Result<()> {
        fs::create_dir_all(cache_root()?)?;
        let result = codex
            .call_mcp_tool(
                &session.thread_id,
                PLAYWRIGHT_SERVER_NAME,
                "browser_take_screenshot",
                json!({
                    "type": "png",
                    "fullPage": false,
                    "scale": "css"
                }),
                TOOL_TIMEOUT,
            )
            .await?;
        update_session_from_tool_result(session, "browser_take_screenshot", &result);
        let reference = screenshot_reference_from_result(&result)?;
        let destination = resolve_screenshot_reference(&reference)?;
        if !destination.is_file() {
            return Err(anyhow!(
                "Playwright completed the screenshot call but did not create {}",
                destination.display()
            ));
        }
        session.last_screenshot_reference = Some(reference.clone());
        session.recent_activities.push(BrowserActivity {
            id: Uuid::new_v4().to_string(),
            activity_type: "screenshot".to_string(),
            label: "Captured screenshot".to_string(),
            status: "completed".to_string(),
            server: PLAYWRIGHT_SERVER_NAME.to_string(),
            tool: "browser_take_screenshot".to_string(),
            thread_id: Some(session.thread_id.clone()),
            turn_id: None,
            browser_session_id: Some(session.browser_session_id.clone()),
            page_id: session.page_id.clone(),
            page_title: session.last_page_title.clone(),
            url: session.last_url.clone(),
            target: None,
            duration_ms: None,
            screenshot_reference: Some(reference),
            console_error_count: 0,
            failed_request_count: 0,
            summary_lines: Vec::new(),
            // Codex owns the tool transcript. Persist only presentation
            // metadata, never the raw screenshot tool result.
            details: None,
            error: None,
            timestamp: Utc::now(),
        });
        bound_activities(&mut session.recent_activities);
        cleanup_cache()?;
        Ok(())
    }

    fn emit_session(&self, session: &BrowserSessionMetadata) {
        if let Some(app) = self.inner.app.get() {
            let _ = app.emit(EVENT_BROWSER_STATE, session);
        }
    }
}

#[derive(Debug, Clone)]
struct DetectedEnvironment {
    node: BrowserDependency,
    npx: BrowserDependency,
    browser: BrowserDependency,
    playwright_cached_browser: Option<String>,
}

fn detect_environment() -> Result<DetectedEnvironment> {
    let node = detect_node();
    let npx = detect_npx(&node);
    let browser = detect_browser();
    let playwright_cached_browser = playwright_cached_browser();
    Ok(DetectedEnvironment {
        node,
        npx,
        browser,
        playwright_cached_browser,
    })
}

fn detect_node() -> BrowserDependency {
    let mut candidates = executable_candidates("node");
    if let Some(home) = dirs::home_dir() {
        let versions = home.join(".volta/tools/image/node");
        if let Ok(entries) = fs::read_dir(versions) {
            candidates.extend(entries.flatten().map(|entry| entry.path().join("bin/node")));
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ]);
    deduplicate_paths(&mut candidates);
    let mut detected = candidates
        .into_iter()
        .filter(|path| is_executable_file(path))
        .filter_map(|path| {
            let version = run_probe(&path, &[OsString::from("--version")], None).ok()?;
            let major = parse_node_major(&version)?;
            (major >= 18).then_some((major, path, version.trim().to_string()))
        })
        .collect::<Vec<_>>();
    detected.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    if let Some((_, path, version)) = detected.into_iter().next() {
        BrowserDependency {
            available: true,
            path: Some(path.to_string_lossy().to_string()),
            version: Some(version),
            detail: None,
        }
    } else {
        BrowserDependency::unavailable("Playwright MCP requires Node.js 18 or newer")
    }
}

fn detect_npx(node: &BrowserDependency) -> BrowserDependency {
    let Some(node_path) = node.path.as_deref() else {
        return BrowserDependency::unavailable("npx cannot run without a compatible Node.js");
    };
    let node_parent = Path::new(node_path).parent();
    let mut candidates = node_parent
        .map(|parent| vec![parent.join("npx")])
        .unwrap_or_default();
    candidates.extend(executable_candidates("npx"));
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/npx"),
        PathBuf::from("/usr/local/bin/npx"),
    ]);
    deduplicate_paths(&mut candidates);
    let execution_path = node_parent.map(preferred_execution_path);
    for candidate in candidates {
        if !is_executable_file(&candidate) {
            continue;
        }
        if let Ok(version) = run_probe(
            &candidate,
            &[OsString::from("--version")],
            execution_path.as_deref(),
        ) {
            return BrowserDependency {
                available: true,
                path: Some(candidate.to_string_lossy().to_string()),
                version: Some(version.trim().to_string()),
                detail: None,
            };
        }
    }
    BrowserDependency::unavailable("npx was not found beside the compatible Node.js installation")
}

fn detect_browser() -> BrowserDependency {
    let mut candidates = vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        PathBuf::from("/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
    ];
    candidates.extend(executable_candidates("google-chrome"));
    candidates.extend(executable_candidates("chromium"));
    deduplicate_paths(&mut candidates);
    for candidate in candidates {
        if !is_executable_file(&candidate) {
            continue;
        }
        if let Ok(version) = run_probe(&candidate, &[OsString::from("--version")], None) {
            return BrowserDependency {
                available: true,
                path: Some(candidate.to_string_lossy().to_string()),
                version: Some(version.trim().to_string()),
                detail: Some("A separate isolated profile will be used".to_string()),
            };
        }
    }
    BrowserDependency::unavailable(
        "Google Chrome or Chromium is required for the headed browser session",
    )
}

fn playwright_cached_browser() -> Option<String> {
    let home = dirs::home_dir()?;
    let cache = home.join("Library/Caches/ms-playwright");
    let Ok(entries) = fs::read_dir(cache) else {
        return None;
    };
    let names = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    ["chromium", "firefox", "webkit"]
        .into_iter()
        .find(|browser| {
            names
                .iter()
                .any(|name| name.starts_with(&format!("{browser}-")))
        })
        .map(str::to_string)
}

fn desired_browser_name(environment: &DetectedEnvironment) -> &str {
    if let Some(path) = environment.browser.path.as_deref() {
        let path = path.to_ascii_lowercase();
        if path.contains("chromium") {
            return "chromium";
        }
        if path.contains("google chrome") || path.contains("google-chrome") {
            return "chrome";
        }
    }
    environment
        .playwright_cached_browser
        .as_deref()
        .unwrap_or("chrome")
}

fn desired_configuration(environment: &DetectedEnvironment) -> BrowserMcpConfiguration {
    let npx = environment.npx.path.clone();
    let arguments = desired_playwright_arguments(environment);
    BrowserMcpConfiguration {
        server_name: PLAYWRIGHT_SERVER_NAME.to_string(),
        configured: false,
        managed_by_atcontroller: false,
        command: npx,
        arguments,
        package: PLAYWRIGHT_PACKAGE.to_string(),
        package_version: PLAYWRIGHT_PACKAGE_VERSION.to_string(),
        isolated: true,
        headed: true,
        output_directory: cache_root()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

fn desired_playwright_arguments(environment: &DetectedEnvironment) -> Vec<String> {
    vec![
        "-y".to_string(),
        format!("{PLAYWRIGHT_PACKAGE}@{PLAYWRIGHT_PACKAGE_VERSION}"),
        "--isolated".to_string(),
        "--browser".to_string(),
        desired_browser_name(environment).to_string(),
        "--output-dir".to_string(),
        cache_root()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        "--output-max-size".to_string(),
        MAX_CACHE_BYTES.to_string(),
        "--image-responses".to_string(),
        "omit".to_string(),
        "--console-level".to_string(),
        "warning".to_string(),
        "--timeout-action".to_string(),
        "10000".to_string(),
        "--timeout-navigation".to_string(),
        "60000".to_string(),
        "--codegen".to_string(),
        "none".to_string(),
    ]
}

fn build_setup_plan(
    environment: &DetectedEnvironment,
    existing: Option<BrowserMcpConfiguration>,
    codex_binary: &str,
) -> Result<BrowserSetupPlan> {
    let mut blockers = Vec::new();
    if !environment.node.available {
        blockers.push(
            environment
                .node
                .detail
                .clone()
                .unwrap_or_else(|| "Node.js is unavailable".to_string()),
        );
    }
    if !environment.npx.available {
        blockers.push(
            environment
                .npx
                .detail
                .clone()
                .unwrap_or_else(|| "npx is unavailable".to_string()),
        );
    }
    if !environment.browser.available && environment.playwright_cached_browser.is_none() {
        blockers.push(
            environment
                .browser
                .detail
                .clone()
                .unwrap_or_else(|| "A compatible browser is unavailable".to_string()),
        );
    }
    let desired = desired_configuration(environment);
    let ready = existing
        .as_ref()
        .is_some_and(|configuration| configuration_matches_desired(configuration, environment));
    let requires_replacement = existing.is_some() && !ready;
    if requires_replacement
        && existing
            .as_ref()
            .is_some_and(|configuration| !configuration.managed_by_atcontroller)
    {
        blockers.push(format!(
            "An MCP server named {PLAYWRIGHT_SERVER_NAME} already exists and is not managed by ATController"
        ));
    }
    let command = if environment.node.available && environment.npx.available {
        setup_command_preview(environment, codex_binary)?
    } else {
        String::new()
    };
    Ok(BrowserSetupPlan {
        ready,
        can_configure: blockers.is_empty(),
        requires_replacement,
        command,
        server_name: PLAYWRIGHT_SERVER_NAME.to_string(),
        package: PLAYWRIGHT_PACKAGE.to_string(),
        package_version: PLAYWRIGHT_PACKAGE_VERSION.to_string(),
        effects: vec![
            format!(
                "Register {PLAYWRIGHT_PACKAGE}@{PLAYWRIGHT_PACKAGE_VERSION} with the local Codex MCP configuration"
            ),
            "Launch a headed Chrome session with an isolated in-memory profile".to_string(),
            format!(
                "Store screenshots and browser artifacts under {}",
                desired.output_directory
            ),
            "Allow Codex to use Playwright browser tools in local threads".to_string(),
        ],
        blockers,
        existing_configuration: existing,
    })
}

fn setup_command_preview(environment: &DetectedEnvironment, codex_binary: &str) -> Result<String> {
    let args = setup_cli_arguments(environment)?;
    let mut command = shell_quote(codex_binary);
    for argument in args {
        command.push(' ');
        command.push_str(&shell_quote(&argument.to_string_lossy()));
    }
    Ok(command)
}

fn setup_cli_arguments(environment: &DetectedEnvironment) -> Result<Vec<OsString>> {
    let node_path = environment
        .node
        .path
        .as_deref()
        .ok_or_else(|| anyhow!("A compatible Node.js is unavailable"))?;
    let npx_path = environment
        .npx
        .path
        .as_deref()
        .ok_or_else(|| anyhow!("npx is unavailable"))?;
    let node_parent = Path::new(node_path)
        .parent()
        .ok_or_else(|| anyhow!("Node.js path has no parent directory"))?;
    let execution_path = preferred_execution_path(node_parent);
    let mut result = vec![
        OsString::from("mcp"),
        OsString::from("add"),
        OsString::from(PLAYWRIGHT_SERVER_NAME),
        OsString::from("--env"),
        OsString::from(format!("PATH={execution_path}")),
        OsString::from("--"),
        OsString::from(npx_path),
    ];
    result.extend(
        desired_playwright_arguments(environment)
            .into_iter()
            .map(OsString::from),
    );
    Ok(result)
}

fn list_mcp_configurations(
    spec: &process::CodexProcessSpec,
) -> Result<BTreeMap<String, BrowserMcpConfiguration>> {
    let raw = run_codex_cli(
        spec,
        &[
            OsString::from("mcp"),
            OsString::from("list"),
            OsString::from("--json"),
        ],
        COMMAND_TIMEOUT,
    )?;
    let rows: Vec<Value> =
        serde_json::from_str(&raw).context("Codex returned invalid JSON for `mcp list --json`")?;
    let mut result = BTreeMap::new();
    for row in rows {
        let Some(name) = row.get("name").and_then(Value::as_str) else {
            continue;
        };
        let transport = row.get("transport").cloned().unwrap_or(Value::Null);
        let command = transport
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string);
        let arguments = transport
            .get("args")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let package_version = arguments
            .iter()
            .find_map(|argument| {
                argument
                    .strip_prefix(&format!("{PLAYWRIGHT_PACKAGE}@"))
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let output_directory = argument_value(&arguments, "--output-dir")
            .unwrap_or_default()
            .to_string();
        let managed_by_atcontroller = name == PLAYWRIGHT_SERVER_NAME
            && arguments.iter().any(|argument| {
                argument == &format!("{PLAYWRIGHT_PACKAGE}@{PLAYWRIGHT_PACKAGE_VERSION}")
            })
            && arguments.iter().any(|argument| argument == "--isolated");
        result.insert(
            name.to_string(),
            BrowserMcpConfiguration {
                server_name: name.to_string(),
                configured: row.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                managed_by_atcontroller,
                command,
                arguments: arguments.clone(),
                package: PLAYWRIGHT_PACKAGE.to_string(),
                package_version,
                isolated: arguments.iter().any(|argument| argument == "--isolated"),
                headed: !arguments.iter().any(|argument| argument == "--headless"),
                output_directory,
            },
        );
    }
    Ok(result)
}

fn configuration_matches_desired(
    configuration: &BrowserMcpConfiguration,
    environment: &DetectedEnvironment,
) -> bool {
    configuration.configured
        && configuration.managed_by_atcontroller
        && configuration.package_version == PLAYWRIGHT_PACKAGE_VERSION
        && configuration.isolated
        && configuration.headed
        && configuration.arguments == desired_playwright_arguments(environment)
}

fn argument_value<'a>(arguments: &'a [String], key: &str) -> Option<&'a str> {
    arguments
        .iter()
        .position(|argument| argument == key)
        .and_then(|index| arguments.get(index + 1))
        .map(String::as_str)
}

fn run_codex_cli(
    spec: &process::CodexProcessSpec,
    arguments: &[OsString],
    timeout: Duration,
) -> Result<String> {
    let mut command = Command::new(&spec.binary_path);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = &spec.login_path {
        command.env("PATH", path);
    }
    let output = run_command_with_timeout(command, timeout)?;
    if !output.status.success() {
        return Err(anyhow!(
            "Codex MCP command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_probe(path: &Path, arguments: &[OsString], execution_path: Option<&str>) -> Result<String> {
    let mut command = Command::new(path);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(execution_path) = execution_path {
        command.env("PATH", execution_path);
    }
    let output = run_command_with_timeout(command, Duration::from_secs(5))?;
    if !output.status.success() {
        return Err(anyhow!("Dependency probe failed"));
    }
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

fn run_command_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<std::process::Output> {
    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map_err(Into::into);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow!("Command timed out"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn executable_candidates(name: &str) -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|root| root.join(name))
                .collect()
        })
        .unwrap_or_default()
}

fn deduplicate_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
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

fn parse_node_major(version: &str) -> Option<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn preferred_execution_path(node_parent: &Path) -> String {
    let paths = [
        node_parent.to_path_buf(),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    std::env::join_paths(paths)
        .ok()
        .and_then(|path| path.into_string().ok())
        .unwrap_or_else(|| "/usr/bin:/bin".to_string())
}

fn validate_identifier(value: &str, label: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 200
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(char::is_control)
    {
        return Err(anyhow!("Invalid {label}"));
    }
    Ok(())
}

fn validate_navigation_url(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed == "about:blank" {
        return Ok(trimmed.to_string());
    }
    if trimmed.len() > 4_096
        || trimmed.chars().any(char::is_control)
        || !(trimmed.starts_with("http://") || trimmed.starts_with("https://"))
    {
        return Err(anyhow!("Browser navigation requires a valid http(s) URL"));
    }
    Ok(trimmed.to_string())
}

fn cache_root() -> Result<PathBuf> {
    Ok(storage::ensure_base_dirs()?.join(CACHE_SUBDIRECTORY))
}

fn session_store_path() -> Result<PathBuf> {
    Ok(storage::ensure_base_dirs()?.join(SESSION_STORE_FILE))
}

fn load_session_store() -> Result<BrowserSessionStore> {
    let path = session_store_path()?;
    if !path.is_file() {
        return Ok(BrowserSessionStore::default());
    }
    let raw = fs::read(&path)?;
    let store: BrowserSessionStore = serde_json::from_slice(&raw)
        .with_context(|| format!("Invalid browser session metadata in {}", path.display()))?;
    if store.version != SESSION_STORE_VERSION {
        return Err(anyhow!(
            "Unsupported browser session metadata version {}",
            store.version
        ));
    }
    Ok(store)
}

fn persist_sessions(sessions: &BTreeMap<String, BrowserSessionMetadata>) -> Result<()> {
    let store = BrowserSessionStore {
        version: SESSION_STORE_VERSION,
        sessions: sessions.clone(),
    };
    write_atomic(
        &session_store_path()?,
        serde_json::to_string_pretty(&store)?.as_bytes(),
    )
}

fn normalize_restored_sessions(sessions: &mut BTreeMap<String, BrowserSessionMetadata>) -> bool {
    let mut changed = false;
    for session in sessions.values_mut() {
        if !matches!(
            session.state,
            BrowserSessionState::Stopped
                | BrowserSessionState::Unavailable
                | BrowserSessionState::NotConfigured
        ) {
            // Playwright profiles are intentionally ephemeral and owned by the
            // previous app-server process. Never present persisted metadata as
            // a still-live browser after ATController starts again.
            session.state = BrowserSessionState::Disconnected;
            session.window_visible = false;
            session.control_owner = BrowserControlOwner::Codex;
            changed = true;
        }
    }
    changed
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(crate) fn screenshot_reference_from_result(result: &Value) -> Result<String> {
    let text = result_text(result);
    for line in text.lines() {
        let candidate = line
            .rfind("](")
            .and_then(|start| {
                let value = &line[start + 2..];
                value.rfind(')').map(|end| &value[..end])
            })
            .unwrap_or(line)
            .trim()
            .trim_matches('`')
            .trim_matches('<')
            .trim_matches('>')
            .replace('\\', "/");
        let marker = format!("{CACHE_SUBDIRECTORY}/");
        let Some((_, reference)) = candidate.split_once(&marker) else {
            continue;
        };
        let reference = reference.trim_start_matches('/');
        if resolve_screenshot_reference(reference).is_ok() {
            return Ok(reference.to_string());
        }
    }
    Err(anyhow!(
        "Playwright created a screenshot but did not return a managed cache reference"
    ))
}

fn resolve_screenshot_reference(reference: &str) -> Result<PathBuf> {
    let relative = Path::new(reference);
    if relative.is_absolute()
        || reference.is_empty()
        || reference.len() > 1_024
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(anyhow!("Invalid screenshot reference"));
    }
    let extension = relative
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err(anyhow!("Unsupported screenshot type"));
    }
    Ok(cache_root()?.join(relative))
}

fn screenshot_mime(path: &Path) -> Result<&'static str> {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        _ => Err(anyhow!("Unsupported screenshot type")),
    }
}

fn cleanup_cache() -> Result<()> {
    let root = cache_root()?;
    fs::create_dir_all(&root)?;
    let mut files = Vec::new();
    collect_cache_files(&root, &mut files)?;
    files.sort_by_key(|entry| entry.1);
    let mut total = files.iter().map(|entry| entry.2).sum::<u64>();
    let mut count = files.len();
    for (path, _, size) in files {
        if total <= MAX_CACHE_BYTES && count <= MAX_CACHE_FILES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
            count = count.saturating_sub(1);
        }
    }
    Ok(())
}

fn collect_cache_files(
    root: &Path,
    destination: &mut Vec<(PathBuf, SystemTime, u64)>,
) -> Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            collect_cache_files(&entry.path(), destination)?;
        } else if metadata.is_file() {
            destination.push((
                entry.path(),
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                metadata.len(),
            ));
        }
    }
    Ok(())
}

fn apply_activity(session: &mut BrowserSessionMetadata, activity: &BrowserActivity) {
    session.last_activity_at = activity.timestamp;
    session.failure = activity.error.clone();
    if let Some(url) = activity.url.as_ref() {
        session.last_url = Some(url.clone());
    }
    if let Some(title) = activity.page_title.as_ref() {
        session.last_page_title = Some(title.clone());
    }
    if let Some(page_id) = activity.page_id.as_ref() {
        session.page_id = Some(page_id.clone());
    }
    if let Some(reference) = activity.screenshot_reference.as_ref() {
        session.last_screenshot_reference = Some(reference.clone());
    }
    session.console_error_count = session
        .console_error_count
        .saturating_add(activity.console_error_count);
    session.failed_request_count = session
        .failed_request_count
        .saturating_add(activity.failed_request_count);
    session.control_owner = BrowserControlOwner::Codex;
    session.window_visible = activity.activity_type != "browserStopped";
    session.state = if activity.status == "failed" || activity.error.is_some() {
        BrowserSessionState::Failed
    } else if activity.activity_type == "browserStopped" {
        BrowserSessionState::Stopped
    } else if activity.status == "inProgress" {
        BrowserSessionState::CodexActive
    } else {
        BrowserSessionState::Ready
    };
    let mut persisted_activity = activity.clone();
    // Codex owns the authoritative tool transcript. Browser session metadata keeps
    // only presentation fields so page content and form data are not duplicated.
    persisted_activity.details = None;
    session.recent_activities.push(persisted_activity);
    bound_activities(&mut session.recent_activities);
}

fn bound_activities(activities: &mut Vec<BrowserActivity>) {
    if activities.len() > MAX_RECENT_ACTIVITIES {
        activities.drain(0..activities.len() - MAX_RECENT_ACTIVITIES);
    }
}

fn update_session_from_tool_result(
    session: &mut BrowserSessionMetadata,
    tool: &str,
    result: &Value,
) {
    let text = result_text(result);
    if let Some(url) = parse_labeled_line(&text, "Page URL:") {
        session.last_url = Some(redact_browser_url(&url));
    }
    if let Some(title) = parse_labeled_line(&text, "Page Title:") {
        session.last_page_title = Some(title);
    }
    if tool == "browser_console_messages" {
        session.console_error_count = count_console_errors(&text);
    }
    if tool == "browser_network_requests" {
        session.failed_request_count = count_failed_requests(&text);
    }
    session.last_activity_at = Utc::now();
}

fn result_text(value: &Value) -> String {
    let mut output = Vec::new();
    collect_text(value, &mut output, 0);
    output.join("\n")
}

fn collect_text(value: &Value, output: &mut Vec<String>, depth: usize) {
    if depth > 12 || output.len() > 256 {
        return;
    }
    match value {
        Value::String(value) => output.push(value.clone()),
        Value::Array(values) => {
            for value in values {
                collect_text(value, output, depth + 1);
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                output.push(text.to_string());
            }
            for (key, value) in map {
                if key != "text" && key != "data" {
                    collect_text(value, output, depth + 1);
                }
            }
        }
        _ => {}
    }
}

fn parse_labeled_line(text: &str, label: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(label).map(str::trim))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn count_console_errors(text: &str) -> u32 {
    u32::try_from(
        text.lines()
            .filter(|line| {
                let line = line.to_ascii_lowercase();
                line.contains("[error]") || line.contains("uncaught") || line.contains("unhandled")
            })
            .count(),
    )
    .unwrap_or(u32::MAX)
}

fn count_failed_requests(text: &str) -> u32 {
    u32::try_from(
        text.lines()
            .filter(|line| {
                let lower = line.to_ascii_lowercase();
                lower.contains("=> [4")
                    || lower.contains("=> [5")
                    || lower.contains("failed")
                    || lower.contains("net::err_")
            })
            .count(),
    )
    .unwrap_or(u32::MAX)
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@%_+=:,./-".contains(&byte))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

pub(crate) struct LocalTestServer {
    pub(crate) url: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl LocalTestServer {
    pub(crate) async fn start() -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break };
                        tokio::spawn(async move {
                            let mut request = vec![0u8; 8 * 1024];
                            let read = tokio::time::timeout(
                                Duration::from_secs(2),
                                stream.read(&mut request),
                            )
                            .await
                            .ok()
                            .and_then(Result::ok)
                            .unwrap_or_default();
                            let request = String::from_utf8_lossy(&request[..read]);
                            let failed_request = request
                                .lines()
                                .next()
                                .is_some_and(|line| line.contains(" /api/fail "));
                            if failed_request {
                                let body = "{\"error\":\"intentional self-test failure\"}";
                                let response = format!(
                                    "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    body.len(),
                                    body
                                );
                                let _ = stream.write_all(response.as_bytes()).await;
                                let _ = stream.shutdown().await;
                                return;
                            }
                            let body = concat!(
                                "<!doctype html><html><head>",
                                "<title>ATController Browser Self Test</title>",
                                "</head><body><main>",
                                "<h1>ATController Browser Self Test</h1>",
                                "<label>Project name <input id=\"project-name\" /></label>",
                                "<label>Environment <select id=\"environment\">",
                                "<option value=\"local\">Local</option>",
                                "<option value=\"staging\">Staging</option>",
                                "</select></label>",
                                "<button type=\"button\" id=\"ready\" ",
                                "onclick=\"document.title='ATController Browser Test Complete';",
                                "console.error('ATController intentional browser test error');",
                                "fetch('/api/fail').catch(() => {})\">Ready</button>",
                                "</main></body></html>"
                            );
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            let _ = stream.shutdown().await;
                        });
                    }
                }
            }
        });
        Ok(Self {
            url: format!("http://127.0.0.1:{}/", address.port()),
            shutdown: Some(shutdown_tx),
        })
    }

    pub(crate) async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{
        apply_activity, argument_value, build_setup_plan, count_console_errors,
        count_failed_requests, normalize_restored_sessions, parse_node_major,
        resolve_screenshot_reference, screenshot_reference_from_result, BrowserActivity,
        BrowserControlOwner, BrowserDependency, BrowserSessionMetadata, BrowserSessionState,
        DetectedEnvironment,
    };

    #[test]
    fn parses_only_supported_node_versions() {
        assert_eq!(parse_node_major("v22.12.0\n"), Some(22));
        assert_eq!(parse_node_major("18.20.1"), Some(18));
        assert_eq!(parse_node_major("not-node"), None);
    }

    #[test]
    fn reads_flag_values_without_shell_parsing() {
        let arguments = vec![
            "--isolated".to_string(),
            "--output-dir".to_string(),
            "/tmp/Folder with spaces".to_string(),
        ];
        assert_eq!(
            argument_value(&arguments, "--output-dir"),
            Some("/tmp/Folder with spaces")
        );
    }

    #[test]
    fn setup_plan_reports_missing_dependencies_without_trying_to_build_a_command() {
        let environment = DetectedEnvironment {
            node: BrowserDependency::unavailable("Node.js unavailable"),
            npx: BrowserDependency::unavailable("npx unavailable"),
            browser: BrowserDependency {
                available: true,
                path: Some("/Applications/Chromium".to_string()),
                version: Some("1".to_string()),
                detail: None,
            },
            playwright_cached_browser: None,
        };
        let plan = build_setup_plan(&environment, None, "/usr/local/bin/codex")
            .expect("missing dependencies should produce a setup plan");
        assert!(!plan.can_configure);
        assert!(plan.command.is_empty());
        assert!(plan.blockers.iter().any(|blocker| blocker.contains("Node")));
        assert!(plan.blockers.iter().any(|blocker| blocker.contains("npx")));
    }

    #[test]
    fn setup_plan_blocks_configuration_when_no_browser_is_available() {
        let environment = DetectedEnvironment {
            node: BrowserDependency {
                available: true,
                path: Some("/opt/node/bin/node".to_string()),
                version: Some("v22.22.0".to_string()),
                detail: None,
            },
            npx: BrowserDependency {
                available: true,
                path: Some("/opt/node/bin/npx".to_string()),
                version: Some("10.9.4".to_string()),
                detail: None,
            },
            browser: BrowserDependency::unavailable("Browser unavailable"),
            playwright_cached_browser: None,
        };
        let plan = build_setup_plan(&environment, None, "/usr/local/bin/codex")
            .expect("missing browser should produce a setup plan");
        assert!(!plan.can_configure);
        assert!(!plan.command.is_empty());
        assert!(plan
            .blockers
            .iter()
            .any(|blocker| blocker.contains("Browser unavailable")));
    }

    #[test]
    fn browser_activity_state_is_thread_scoped() {
        let mut session = BrowserSessionMetadata::new("thread-1", "/tmp/project");
        let activity = BrowserActivity {
            id: "item-1".to_string(),
            activity_type: "navigation".to_string(),
            label: "Opened page".to_string(),
            status: "completed".to_string(),
            server: "atcontroller-playwright".to_string(),
            tool: "browser_navigate".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            browser_session_id: None,
            page_id: None,
            page_title: Some("Example".to_string()),
            url: Some("https://example.test/".to_string()),
            target: None,
            duration_ms: Some(20),
            screenshot_reference: None,
            console_error_count: 0,
            failed_request_count: 0,
            summary_lines: Vec::new(),
            details: Some(json!({"ok": true})),
            error: None,
            timestamp: chrono::Utc::now(),
        };
        apply_activity(&mut session, &activity);
        assert_eq!(session.state, BrowserSessionState::Ready);
        assert_eq!(session.last_page_title.as_deref(), Some("Example"));
        assert_eq!(session.recent_activities.len(), 1);
    }

    #[test]
    fn restored_ephemeral_sessions_require_an_explicit_restart() {
        let mut session = BrowserSessionMetadata::new("thread-1", "/tmp/project");
        session.state = BrowserSessionState::UserActive;
        session.window_visible = true;
        session.control_owner = BrowserControlOwner::User;
        let mut sessions = BTreeMap::from([(session.thread_id.clone(), session)]);

        assert!(normalize_restored_sessions(&mut sessions));
        let restored = &sessions["thread-1"];
        assert_eq!(restored.state, BrowserSessionState::Disconnected);
        assert!(!restored.window_visible);
        assert_eq!(restored.control_owner, BrowserControlOwner::Codex);
    }

    #[test]
    fn console_and_network_failures_are_grouped() {
        assert_eq!(
            count_console_errors("[error] first\n[warning] no\nUncaught Error: second"),
            2
        );
        assert_eq!(
            count_failed_requests("GET /ok => [200]\nPOST /bad => [500]\nnet::ERR_FAILED"),
            2
        );
    }

    #[test]
    fn screenshot_references_cannot_escape_the_cache() {
        assert!(resolve_screenshot_reference("screenshots/thread/file.png").is_ok());
        assert!(resolve_screenshot_reference("../private.png").is_err());
        assert!(resolve_screenshot_reference("/tmp/private.png").is_err());
        assert!(resolve_screenshot_reference("screenshots/file.txt").is_err());
    }

    #[test]
    fn screenshot_result_is_routed_back_to_the_managed_cache() {
        let result = json!({
            "content": [{
                "type": "text",
                "text": "### Result\n- [Screenshot of viewport](../../Library/Application Support/ATController/browser-cache/playwright/page-2026-07-29T12-00-00.png)"
            }]
        });
        assert_eq!(
            screenshot_reference_from_result(&result).expect("managed reference"),
            "page-2026-07-29T12-00-00.png"
        );
        let workspace_file = json!({
            "content": [{
                "type": "text",
                "text": "- [Screenshot of viewport](./screenshot.png)"
            }]
        });
        assert!(screenshot_reference_from_result(&workspace_file).is_err());
    }
}
