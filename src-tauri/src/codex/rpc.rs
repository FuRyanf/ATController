use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::diagnostics::{DiagnosticsState, ProcessExitInfo};
use super::process::{self, CodexProcessSpec};
use super::protocol::ServerRequestResponse;
use super::transport::{self, InboundFrame, OutboundFrame};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);
const OUTBOUND_ENQUEUE_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_IDEMPOTENT_ATTEMPTS: usize = 3;
const MAX_PENDING_REQUESTS: usize = 256;
const MAX_PENDING_SERVER_REQUESTS: usize = 256;
const OVERLOADED_ERROR_CODE: i64 = -32001;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: Option<i64>,
    pub message: String,
    #[allow(dead_code)]
    pub data: Option<Value>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some(code) => write!(formatter, "{} ({code})", self.message),
            None => formatter.write_str(&self.message),
        }
    }
}

impl std::error::Error for RpcError {}

#[derive(Debug, Clone, Copy)]
pub struct RequestOptions {
    pub timeout: Duration,
    pub idempotent: bool,
}

impl Default for RequestOptions {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_REQUEST_TIMEOUT,
            idempotent: false,
        }
    }
}

impl RequestOptions {
    pub fn idempotent(timeout: Duration) -> Self {
        Self {
            timeout,
            idempotent: true,
        }
    }
}

#[derive(Debug, Clone)]
pub enum WireEvent {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone)]
pub struct PendingServerRequest {
    pub id: Value,
    pub method: String,
    pub params: Value,
}

type PendingResponse = oneshot::Sender<std::result::Result<Value, RpcError>>;
type EventCallback = Arc<dyn Fn(WireEvent) + Send + Sync>;
type ExitCallback = Arc<dyn Fn(ProcessExitInfo) + Send + Sync>;

pub struct RpcConnection {
    outbound: mpsc::Sender<OutboundFrame>,
    pending: Mutex<HashMap<u64, PendingResponse>>,
    server_requests: Mutex<HashMap<String, PendingServerRequest>>,
    next_request_id: AtomicU64,
    initialized: AtomicBool,
    closed: AtomicBool,
    exit_reported: AtomicBool,
    pid: u32,
    diagnostics: Arc<DiagnosticsState>,
    event_callback: EventCallback,
    exit_callback: ExitCallback,
}

impl RpcConnection {
    pub async fn spawn(
        spec: &CodexProcessSpec,
        diagnostics: Arc<DiagnosticsState>,
        event_callback: EventCallback,
        exit_callback: ExitCallback,
    ) -> Result<Arc<Self>> {
        let mut child = process::spawn(spec)?;
        let pid = child
            .id()
            .ok_or_else(|| anyhow!("Codex app-server did not report a process identifier"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Codex app-server stdin is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Codex app-server stdout is unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Codex app-server stderr is unavailable"))?;

        diagnostics.set_process(pid);
        let (outbound, outbound_rx) =
            mpsc::channel::<OutboundFrame>(transport::OUTBOUND_QUEUE_CAPACITY);
        let (inbound_tx, inbound_rx) =
            mpsc::channel::<InboundFrame>(transport::INBOUND_QUEUE_CAPACITY);
        let connection = Arc::new(Self {
            outbound,
            pending: Mutex::new(HashMap::new()),
            server_requests: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            initialized: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            exit_reported: AtomicBool::new(false),
            pid,
            diagnostics: diagnostics.clone(),
            event_callback,
            exit_callback,
        });

        transport::spawn_writer(stdin, outbound_rx, diagnostics.clone(), inbound_tx.clone());
        transport::spawn_stdout_reader(stdout, inbound_tx, diagnostics.clone());
        let dispatch_diagnostics = diagnostics.clone();
        transport::spawn_stderr_reader(stderr, diagnostics);

        let dispatch_connection = Arc::downgrade(&connection);
        tokio::spawn(async move {
            dispatch_inbound(dispatch_connection, inbound_rx, dispatch_diagnostics).await;
        });

        let wait_connection = Arc::downgrade(&connection);
        tokio::spawn(async move {
            let exit = match child.wait().await {
                Ok(status) => {
                    #[cfg(unix)]
                    let signal = {
                        use std::os::unix::process::ExitStatusExt;
                        status.signal().map(|signal| format!("SIG{signal}"))
                    };
                    #[cfg(not(unix))]
                    let signal = None;
                    ProcessExitInfo {
                        code: status.code(),
                        signal,
                        summary: format!("Codex app-server exited with {status}"),
                    }
                }
                Err(error) => ProcessExitInfo {
                    code: None,
                    signal: None,
                    summary: format!("Unable to wait for Codex app-server: {error}"),
                },
            };
            if let Some(connection) = wait_connection.upgrade() {
                connection.report_exit(exit).await;
            }
        });

        let initialize = connection
            .request_once(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "atcontroller",
                        "title": "ATController",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": false
                    }
                }),
                INITIALIZE_TIMEOUT,
            )
            .await
            .context("Codex app-server initialization failed")?;
        connection.diagnostics.set_initialized(&initialize);
        connection
            .notify("initialized", Value::Null)
            .await
            .context("Unable to finish the Codex initialization handshake")?;
        connection.initialized.store(true, Ordering::Release);
        Ok(connection)
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_ready(&self) -> bool {
        self.initialized.load(Ordering::Acquire) && !self.closed.load(Ordering::Acquire)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        options: RequestOptions,
    ) -> std::result::Result<Value, RpcError> {
        if !self.is_ready() {
            return Err(RpcError {
                code: None,
                message: "Codex app-server is not initialized".to_string(),
                data: None,
            });
        }
        let attempts = if options.idempotent {
            MAX_IDEMPOTENT_ATTEMPTS
        } else {
            1
        };
        for attempt in 0..attempts {
            let result = self
                .request_once(method, params.clone(), options.timeout)
                .await;
            match result {
                Err(error)
                    if options.idempotent
                        && error.code == Some(OVERLOADED_ERROR_CODE)
                        && attempt + 1 < attempts =>
                {
                    tokio::time::sleep(overload_backoff(attempt)).await;
                }
                other => return other,
            }
        }
        unreachable!("request retry loop always returns")
    }

    async fn request_once(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> std::result::Result<Value, RpcError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(connection_closed_error());
        }
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(RpcError {
                    code: None,
                    message: "ATController has too many pending Codex requests".to_string(),
                    data: None,
                });
            }
            if pending.insert(id, sender).is_some() {
                return Err(RpcError {
                    code: None,
                    message: "Duplicate ATController request identifier".to_string(),
                    data: None,
                });
            }
        }
        self.diagnostics.pending_increment();
        if let Err(error) = self
            .enqueue(json!({ "id": id, "method": method, "params": params }))
            .await
        {
            if self.pending.lock().await.remove(&id).is_some() {
                self.diagnostics.pending_decrement();
            }
            return Err(error);
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(connection_closed_error()),
            Err(_) => {
                if self.pending.lock().await.remove(&id).is_some() {
                    self.diagnostics.pending_decrement();
                }
                Err(RpcError {
                    code: None,
                    message: format!("Codex request `{method}` timed out"),
                    data: None,
                })
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let mut message = json!({ "method": method });
        if !params.is_null() {
            message["params"] = params;
        }
        self.enqueue(message)
            .await
            .map_err(|error| anyhow!(error.to_string()))
    }

    async fn enqueue(&self, message: Value) -> std::result::Result<(), RpcError> {
        self.diagnostics.queue_increment();
        let result = tokio::time::timeout(
            OUTBOUND_ENQUEUE_TIMEOUT,
            self.outbound.send(OutboundFrame::Message(message)),
        )
        .await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => {
                self.diagnostics.queue_decrement();
                Err(connection_closed_error())
            }
            Err(_) => {
                self.diagnostics.queue_decrement();
                Err(RpcError {
                    code: None,
                    message: "Codex outbound queue is backpressured".to_string(),
                    data: None,
                })
            }
        }
    }

    async fn dispatch_message(&self, message: Value) {
        if message.get("method").is_some() {
            let Some(method) = message.get("method").and_then(Value::as_str) else {
                self.diagnostics
                    .push_protocol_error("Codex message has a non-string method");
                return;
            };
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if let Some(id) = message.get("id").cloned() {
                if is_supported_server_request(method) {
                    let key = request_id_key(&id);
                    let mut pending = self.server_requests.lock().await;
                    if pending.contains_key(&key) {
                        self.diagnostics.push_protocol_error(
                            "Codex sent a duplicate server request identifier",
                        );
                        return;
                    }
                    if pending.len() >= MAX_PENDING_SERVER_REQUESTS {
                        drop(pending);
                        self.diagnostics.push_protocol_error(
                            "Codex exceeded ATController's pending server-request limit",
                        );
                        let _ = self
                            .enqueue(json!({
                                "id": id,
                                "error": {
                                    "code": -32000,
                                    "message": "ATController is waiting on too many user decisions"
                                }
                            }))
                            .await;
                        return;
                    }
                    pending.insert(
                        key,
                        PendingServerRequest {
                            id: id.clone(),
                            method: method.to_string(),
                            params: params.clone(),
                        },
                    );
                    drop(pending);
                    (self.event_callback)(WireEvent::ServerRequest {
                        id,
                        method: method.to_string(),
                        params,
                    });
                } else {
                    self.diagnostics.push_protocol_error(&format!(
                        "Unsupported Codex server request `{method}`"
                    ));
                    let _ = self
                        .enqueue(json!({
                            "id": id,
                            "error": {
                                "code": -32601,
                                "message": "ATController does not expose this client capability"
                            }
                        }))
                        .await;
                }
            } else {
                if method == "serverRequest/resolved" {
                    if let Some(id) = params.get("requestId") {
                        self.server_requests
                            .lock()
                            .await
                            .remove(&request_id_key(id));
                    }
                }
                (self.event_callback)(WireEvent::Notification {
                    method: method.to_string(),
                    params,
                });
            }
            return;
        }

        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            self.diagnostics
                .push_protocol_error("Codex response is missing a numeric request identifier");
            return;
        };
        let Some(sender) = self.pending.lock().await.remove(&id) else {
            self.diagnostics
                .push_protocol_error("Codex sent a late, duplicate, or unknown response");
            return;
        };
        self.diagnostics.pending_decrement();
        let response = if let Some(error) = message.get("error") {
            Err(parse_rpc_error(error))
        } else if let Some(result) = message.get("result") {
            Ok(result.clone())
        } else {
            Err(RpcError {
                code: None,
                message: "Codex response contains neither result nor error".to_string(),
                data: None,
            })
        };
        let _ = sender.send(response);
    }

    pub async fn respond_to_server_request(&self, response: ServerRequestResponse) -> Result<()> {
        let key = request_id_key(response.request_id());
        let pending = self
            .server_requests
            .lock()
            .await
            .remove(&key)
            .ok_or_else(|| anyhow!("This Codex request was already resolved"))?;
        let result = build_server_response(&pending, response)?;
        self.enqueue(json!({ "id": pending.id, "result": result }))
            .await
            .map_err(|error| anyhow!(error.to_string()))
    }

    pub async fn shutdown(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.initialized.store(false, Ordering::Release);
        self.diagnostics.queue_increment();
        let _ = self.outbound.send(OutboundFrame::Shutdown).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        #[cfg(unix)]
        {
            // The discovered Codex executable may be a version-manager shim that
            // exits before its node/vendor descendants. Always address the full
            // process group, even when the direct child has already reported exit.
            if process::signal_process_group(self.pid, libc::SIGTERM) {
                tokio::time::sleep(Duration::from_millis(700)).await;
                if process::signal_process_group(self.pid, 0) {
                    process::signal_process_group(self.pid, libc::SIGKILL);
                }
            }
        }
        self.reject_pending(connection_closed_error()).await;
    }

    async fn report_exit(&self, exit: ProcessExitInfo) {
        if self.exit_reported.swap(true, Ordering::AcqRel) {
            return;
        }
        self.closed.store(true, Ordering::Release);
        self.initialized.store(false, Ordering::Release);
        self.reject_pending(RpcError {
            code: None,
            message: exit.summary.clone(),
            data: None,
        })
        .await;
        (self.exit_callback)(exit);
    }

    async fn reject_pending(&self, error: RpcError) {
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, sender) in pending {
            self.diagnostics.pending_decrement();
            let _ = sender.send(Err(error.clone()));
        }
        self.server_requests.lock().await.clear();
    }
}

async fn dispatch_inbound(
    connection: std::sync::Weak<RpcConnection>,
    mut receiver: mpsc::Receiver<InboundFrame>,
    diagnostics: Arc<DiagnosticsState>,
) {
    while let Some(frame) = receiver.recv().await {
        diagnostics.queue_decrement();
        let Some(connection) = connection.upgrade() else {
            while receiver.try_recv().is_ok() {
                diagnostics.queue_decrement();
            }
            break;
        };
        match frame {
            InboundFrame::Message(message) => connection.dispatch_message(message).await,
            InboundFrame::Malformed(error) => connection.diagnostics.push_protocol_error(&error),
            InboundFrame::Oversized => {
                let message =
                    "Codex returned a JSONL message larger than ATController's 256 MiB safety limit";
                connection.diagnostics.push_protocol_error(message);
                connection
                    .reject_pending(RpcError {
                        code: Some(-32098),
                        message: message.to_string(),
                        data: None,
                    })
                    .await;
            }
            InboundFrame::TransportError(error) => {
                connection.diagnostics.push_protocol_error(&error);
                connection.reject_pending(connection_closed_error()).await;
                break;
            }
            InboundFrame::Eof => {
                connection.reject_pending(connection_closed_error()).await;
                break;
            }
        }
    }
}

fn parse_rpc_error(error: &Value) -> RpcError {
    RpcError {
        code: error.get("code").and_then(Value::as_i64),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Codex app-server request failed")
            .to_string(),
        data: error.get("data").cloned(),
    }
}

fn connection_closed_error() -> RpcError {
    RpcError {
        code: None,
        message: "Codex app-server connection closed".to_string(),
        data: None,
    }
}

fn overload_backoff(attempt: usize) -> Duration {
    let base = 200u64.saturating_mul(1u64 << attempt.min(4));
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::from(duration.subsec_millis()) % 100)
        .unwrap_or(0);
    Duration::from_millis(base + jitter)
}

fn request_id_key(id: &Value) -> String {
    match id {
        Value::String(value) => format!("s:{value}"),
        Value::Number(value) => format!("n:{value}"),
        _ => format!("j:{}", serde_json::to_string(id).unwrap_or_default()),
    }
}

fn is_supported_server_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
            | "mcpServer/elicitation/request"
            | "applyPatchApproval"
            | "execCommandApproval"
    )
}

fn build_server_response(
    pending: &PendingServerRequest,
    response: ServerRequestResponse,
) -> Result<Value> {
    match (pending.method.as_str(), response) {
        (
            "item/commandExecution/requestApproval",
            ServerRequestResponse::Command { decision, .. },
        ) => {
            if !["accept", "acceptForSession", "decline", "cancel"].contains(&decision.as_str()) {
                return Err(anyhow!("Unsupported command approval decision"));
            }
            Ok(json!({ "decision": decision }))
        }
        ("item/fileChange/requestApproval", ServerRequestResponse::FileChange { decision, .. }) => {
            if !["accept", "acceptForSession", "decline", "cancel"].contains(&decision.as_str()) {
                return Err(anyhow!("Unsupported file approval decision"));
            }
            Ok(json!({ "decision": decision }))
        }
        ("execCommandApproval", ServerRequestResponse::Command { decision, .. })
        | ("applyPatchApproval", ServerRequestResponse::FileChange { decision, .. }) => {
            let legacy_decision = match decision.as_str() {
                "accept" => "approved",
                "acceptForSession" => "approved_for_session",
                "decline" => "denied",
                "cancel" => "abort",
                _ => return Err(anyhow!("Unsupported legacy approval decision")),
            };
            Ok(json!({ "decision": legacy_decision }))
        }
        (
            "item/permissions/requestApproval",
            ServerRequestResponse::Permissions { grant, scope, .. },
        ) => {
            let scope = scope.unwrap_or_else(|| "turn".to_string());
            if !["turn", "session"].contains(&scope.as_str()) {
                return Err(anyhow!("Unsupported permission grant scope"));
            }
            let permissions = if grant {
                pending
                    .params
                    .get("permissions")
                    .cloned()
                    .unwrap_or_else(|| json!({}))
            } else {
                json!({})
            };
            Ok(json!({ "permissions": permissions, "scope": scope }))
        }
        ("item/tool/requestUserInput", ServerRequestResponse::UserInput { answers, .. }) => {
            Ok(json!({
                "answers": answers
                    .into_iter()
                    .map(|(id, answers)| (id, json!({ "answers": answers })))
                    .collect::<serde_json::Map<String, Value>>()
            }))
        }
        (
            "mcpServer/elicitation/request",
            ServerRequestResponse::McpElicitation {
                action, content, ..
            },
        ) => {
            if !["accept", "decline", "cancel"].contains(&action.as_str()) {
                return Err(anyhow!("Unsupported MCP elicitation action"));
            }
            Ok(json!({
                "action": action,
                "content": if action == "accept" { content } else { None },
                "_meta": null
            }))
        }
        _ => Err(anyhow!(
            "The response type does not match the pending Codex request"
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{build_server_response, PendingServerRequest};
    use crate::codex::protocol::ServerRequestResponse;

    #[test]
    fn command_decisions_are_schema_values() {
        let pending = PendingServerRequest {
            id: json!(1),
            method: "item/commandExecution/requestApproval".to_string(),
            params: json!({}),
        };
        assert_eq!(
            build_server_response(
                &pending,
                ServerRequestResponse::Command {
                    request_id: json!(1),
                    decision: "acceptForSession".to_string()
                }
            )
            .unwrap(),
            json!({"decision":"acceptForSession"})
        );
    }

    #[test]
    fn declining_permission_requests_grants_an_empty_subset() {
        let pending = PendingServerRequest {
            id: json!("approval-1"),
            method: "item/permissions/requestApproval".to_string(),
            params: json!({"permissions":{"network":{"enabled":true}}}),
        };
        let result = build_server_response(
            &pending,
            ServerRequestResponse::Permissions {
                request_id: json!("approval-1"),
                grant: false,
                scope: None,
            },
        )
        .unwrap();
        assert_eq!(result, json!({"permissions":{},"scope":"turn"}));
    }

    #[test]
    fn legacy_approvals_use_generated_review_decision_values() {
        let pending = PendingServerRequest {
            id: json!("legacy-1"),
            method: "execCommandApproval".to_string(),
            params: json!({}),
        };
        assert_eq!(
            build_server_response(
                &pending,
                ServerRequestResponse::Command {
                    request_id: json!("legacy-1"),
                    decision: "acceptForSession".to_string()
                }
            )
            .unwrap(),
            json!({"decision":"approved_for_session"})
        );
    }

    #[test]
    fn user_input_answers_keep_question_ids() {
        let pending = PendingServerRequest {
            id: json!(5),
            method: "item/tool/requestUserInput".to_string(),
            params: json!({}),
        };
        let mut answers = BTreeMap::new();
        answers.insert("choice".to_string(), vec!["First".to_string()]);
        let result = build_server_response(
            &pending,
            ServerRequestResponse::UserInput {
                request_id: json!(5),
                answers,
            },
        )
        .unwrap();
        assert_eq!(result["answers"]["choice"]["answers"][0], "First");
    }
}
