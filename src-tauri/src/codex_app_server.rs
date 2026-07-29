use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::models::{
    CodexModelOption, CodexRateLimitWindow, CodexReasoningEffortOption, CodexRuntimeOverview,
    CodexRuntimePreferences,
};
use crate::{runner, storage};

const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(15);
const APP_SERVER_EXIT_GRACE_PERIOD: Duration = Duration::from_secs(1);
const APP_SERVER_MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const FIVE_HOUR_WINDOW_MINS: i64 = 5 * 60;
const WEEKLY_WINDOW_MINS: i64 = 7 * 24 * 60;
const RATE_WINDOW_DURATION_TOLERANCE_PERCENT: i64 = 5;

#[derive(Debug)]
struct RpcRequest {
    method: &'static str,
    params: Value,
}

fn codex_cli_path() -> Result<String> {
    let settings = storage::load_settings()?;
    runner::detect_codex_cli_path(&settings)
        .ok_or_else(|| anyhow!("Codex CLI not found. Configure the CLI path in Settings."))
}

fn write_message(stdin: &mut impl Write, message: &Value) -> Result<()> {
    serde_json::to_writer(&mut *stdin, message)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}

fn rpc_error_message(error: &Value) -> String {
    let description = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Codex app server request failed");
    let structured_code = error
        .pointer("/data/config_write_error_code")
        .or_else(|| error.pointer("/data/configWriteErrorCode"))
        .and_then(Value::as_str);
    match structured_code {
        Some(code) => format!("{code}: {description}"),
        None => description.to_string(),
    }
}

fn receive_response(
    receiver: &Receiver<Result<Value, String>>,
    response_id: i64,
    deadline: Instant,
) -> Result<Value> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!("Codex app server request timed out"));
        }
        let message = receiver
            .recv_timeout(remaining)
            .map_err(|_| anyhow!("Codex app server stopped before replying"))?
            .map_err(|error| anyhow!("{error}"))?;
        if message.get("id").and_then(Value::as_i64) != Some(response_id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(anyhow!("{}", rpc_error_message(error)));
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("Codex app server returned an invalid response"));
    }
}

fn receive_responses(
    receiver: &Receiver<Result<Value, String>>,
    response_count: usize,
    deadline: Instant,
) -> Result<Vec<Value>> {
    let mut responses = vec![None; response_count];
    let mut received = 0usize;
    while received < response_count {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!("Codex app server request timed out"));
        }
        let message = receiver
            .recv_timeout(remaining)
            .map_err(|_| anyhow!("Codex app server stopped before replying"))?
            .map_err(|error| anyhow!("{error}"))?;
        let Some(response_id) = message.get("id").and_then(Value::as_i64) else {
            continue;
        };
        if response_id < 1 || response_id > response_count as i64 {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(anyhow!("{}", rpc_error_message(error)));
        }
        let result = message
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("Codex app server returned an invalid response"))?;
        let index = response_id as usize - 1;
        if responses[index].is_some() {
            return Err(anyhow!(
                "Codex app server returned a duplicate response identifier"
            ));
        }
        responses[index] = Some(result);
        received += 1;
    }
    responses
        .into_iter()
        .map(|response| {
            response.ok_or_else(|| anyhow!("Codex app server omitted a requested response"))
        })
        .collect()
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn signal_process_group(process_group_id: u32, signal: libc::c_int) -> bool {
    let Ok(process_group_id) = i32::try_from(process_group_id) else {
        return false;
    };
    let result = unsafe { libc::kill(-process_group_id, signal) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn terminate_app_server(child: &mut std::process::Child, process_group_id: u32) {
    #[cfg(unix)]
    {
        if signal_process_group(process_group_id, libc::SIGTERM) {
            let deadline = Instant::now() + Duration::from_millis(300);
            while Instant::now() < deadline {
                if !signal_process_group(process_group_id, 0) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if signal_process_group(process_group_id, 0) {
                let _ = signal_process_group(process_group_id, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_requests(cli_path: &str, requests: Vec<RpcRequest>) -> Result<Vec<Value>> {
    // GUI apps inherit a minimal PATH on macOS, while a configured Codex path can
    // itself be a script using `/usr/bin/env node`. Match terminal startup and CLI
    // validation by resolving it through the user's login shell, with the path
    // passed as a positional argument rather than interpolated into shell code.
    let login_shell = env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let mut command = Command::new(login_shell);
    command
        .args([
            "-lic",
            "exec \"$1\" app-server --stdio",
            "atcontroller-codex-app-server",
        ])
        .arg(cli_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .context("Unable to launch the Codex app server")?;
    let process_group_id = child.id();

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("Codex app server did not provide stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("Codex app server did not provide stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("Codex app server did not provide stderr"))?;

    let (message_tx, message_rx) = mpsc::channel::<Result<Value, String>>();
    let stdout_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            let read = match (&mut reader)
                .take((APP_SERVER_MAX_MESSAGE_BYTES + 1) as u64)
                .read_until(b'\n', &mut line)
            {
                Ok(read) => read,
                Err(error) => {
                    let _ = message_tx.send(Err(format!(
                        "Unable to read from the Codex app server: {error}"
                    )));
                    break;
                }
            };
            if read == 0 {
                break;
            }
            if line.len() > APP_SERVER_MAX_MESSAGE_BYTES {
                let _ = message_tx.send(Err(
                    "Codex app server returned an oversized response".to_string()
                ));
                break;
            }
            let message = match serde_json::from_slice::<Value>(&line) {
                Ok(message) => message,
                Err(error) => {
                    let _ = message_tx.send(Err(format!(
                        "Codex app server returned malformed JSON: {error}"
                    )));
                    break;
                }
            };
            if message_tx.send(Ok(message)).is_err() {
                break;
            }
        }
    });
    let stderr_reader = std::thread::spawn(move || {
        // Keep draining so a verbose login shell or app-server cannot block on a
        // full stderr pipe. Diagnostics are deliberately not surfaced because
        // they can contain private local configuration details.
        let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
    });

    let deadline = Instant::now() + APP_SERVER_TIMEOUT;
    let result = (|| {
        write_message(
            &mut stdin,
            &json!({
                "id": 0,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "atcontroller",
                        "title": "ATController",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": false
                    }
                }
            }),
        )?;
        receive_response(&message_rx, 0, deadline)?;
        write_message(&mut stdin, &json!({ "method": "initialized" }))?;

        for (index, request) in requests.iter().enumerate() {
            write_message(
                &mut stdin,
                &json!({
                    "id": (index + 1) as i64,
                    "method": request.method,
                    "params": request.params
                }),
            )?;
        }

        receive_responses(&message_rx, requests.len(), deadline)
    })();

    drop(stdin);
    let exit_deadline = Instant::now() + APP_SERVER_EXIT_GRACE_PERIOD;
    let mut parent_exited = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                parent_exited = true;
                break;
            }
            Ok(None) if Instant::now() < exit_deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => break,
        }
    }
    let process_group_still_alive = {
        #[cfg(unix)]
        {
            signal_process_group(process_group_id, 0)
        }
        #[cfg(not(unix))]
        {
            !parent_exited
        }
    };
    if !parent_exited || process_group_still_alive {
        terminate_app_server(&mut child, process_group_id);
    }
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    result
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn is_fast_tier(value: &str) -> bool {
    value.eq_ignore_ascii_case("fast") || value.eq_ignore_ascii_case("priority")
}

fn parse_models(result: &Value) -> Vec<CodexModelOption> {
    result
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            !model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|model| {
            let id = string_field(model, "id")?.trim();
            if id.is_empty() {
                return None;
            }
            let supported_reasoning_efforts = model
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    let value = string_field(effort, "reasoningEffort")?.trim();
                    if value.is_empty() {
                        return None;
                    }
                    Some(CodexReasoningEffortOption {
                        value: value.to_string(),
                        description: string_field(effort, "description")
                            .unwrap_or_default()
                            .trim()
                            .to_string(),
                    })
                })
                .collect::<Vec<_>>();
            let supports_fast_mode = model
                .get("serviceTiers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|tier| string_field(tier, "id"))
                .any(is_fast_tier)
                || model
                    .get("additionalSpeedTiers")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(is_fast_tier);

            Some(CodexModelOption {
                id: id.to_string(),
                model: string_field(model, "model")
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(id)
                    .trim()
                    .to_string(),
                display_name: string_field(model, "displayName")
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(id)
                    .trim()
                    .to_string(),
                description: string_field(model, "description")
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                is_default: model
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                default_reasoning_effort: string_field(model, "defaultReasoningEffort")
                    .unwrap_or("medium")
                    .trim()
                    .to_string(),
                supported_reasoning_efforts,
                supports_fast_mode,
            })
        })
        .collect()
}

fn parse_rate_limit_window(value: &Value) -> Option<CodexRateLimitWindow> {
    let used_percent = value.get("usedPercent")?.as_f64()?.round() as i64;
    let window_duration_mins = value.get("windowDurationMins")?.as_i64()?;
    Some(CodexRateLimitWindow {
        used_percent: used_percent.clamp(0, 100),
        window_duration_mins,
        resets_at: value.get("resetsAt").and_then(Value::as_i64),
    })
}

fn rate_limit_snapshots(result: &Value) -> Vec<&Value> {
    if let Some(by_limit_id) = result
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .filter(|limits| !limits.is_empty())
    {
        let mut snapshots = Vec::with_capacity(by_limit_id.len());
        if let Some(codex) = by_limit_id.get("codex") {
            snapshots.push(codex);
        }
        snapshots.extend(
            by_limit_id
                .iter()
                .filter(|(limit_id, _)| limit_id.as_str() != "codex")
                .map(|(_, snapshot)| snapshot),
        );
        return snapshots;
    }
    result.get("rateLimits").into_iter().collect()
}

fn parse_rate_limits(
    result: &Value,
) -> (
    Option<CodexRateLimitWindow>,
    Option<CodexRateLimitWindow>,
    Option<String>,
) {
    let snapshots = rate_limit_snapshots(result);
    let windows = snapshots
        .iter()
        .flat_map(|snapshot| [snapshot.get("primary"), snapshot.get("secondary")])
        .flatten()
        .filter_map(parse_rate_limit_window)
        .collect::<Vec<_>>();

    let duration_matches = |actual: i64, expected: i64| {
        let tolerance = expected * RATE_WINDOW_DURATION_TOLERANCE_PERCENT / 100;
        (actual - expected).abs() <= tolerance
    };
    let five_hour = windows
        .iter()
        .find(|window| duration_matches(window.window_duration_mins, FIVE_HOUR_WINDOW_MINS))
        .cloned();
    let weekly = windows
        .iter()
        .find(|window| duration_matches(window.window_duration_mins, WEEKLY_WINDOW_MINS))
        .cloned();
    let plan_type = snapshots
        .iter()
        .find_map(|snapshot| string_field(snapshot, "planType"))
        .map(str::to_string);
    (five_hour, weekly, plan_type)
}

fn build_runtime_overview(
    models_result: &Value,
    config_result: &Value,
    limits_result: &Value,
) -> Result<CodexRuntimeOverview> {
    let models = parse_models(models_result);
    if models.is_empty() {
        return Err(anyhow!("Codex did not return any selectable models"));
    }
    let config = config_result.get("config").unwrap_or(&Value::Null);
    let configured_model = string_field(config, "model").filter(|value| !value.trim().is_empty());
    let selected_model = configured_model
        .and_then(|configured| {
            models
                .iter()
                .find(|model| model.id == configured || model.model == configured)
                .map(|model| model.id.clone())
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| model.is_default)
                .map(|model| model.id.clone())
        })
        .unwrap_or_else(|| models[0].id.clone());
    let selected_model_option = models
        .iter()
        .find(|model| model.id == selected_model)
        .unwrap_or(&models[0]);
    let selected_reasoning_effort = string_field(config, "model_reasoning_effort")
        .filter(|value| {
            selected_model_option
                .supported_reasoning_efforts
                .iter()
                .any(|effort| effort.value == *value)
        })
        .map(str::to_string)
        .unwrap_or_else(|| selected_model_option.default_reasoning_effort.clone());
    let fast_mode = string_field(config, "service_tier")
        .map(is_fast_tier)
        .unwrap_or(false);
    let (five_hour_limit, weekly_limit, plan_type) = parse_rate_limits(limits_result);

    Ok(CodexRuntimeOverview {
        models,
        selected_model,
        selected_reasoning_effort,
        fast_mode,
        five_hour_limit,
        weekly_limit,
        plan_type,
    })
}

pub fn runtime_overview() -> Result<CodexRuntimeOverview> {
    let cli_path = codex_cli_path()?;
    let responses = run_requests(
        &cli_path,
        vec![
            RpcRequest {
                method: "model/list",
                params: json!({ "limit": 100, "includeHidden": false }),
            },
            RpcRequest {
                method: "config/read",
                params: json!({ "includeLayers": false }),
            },
        ],
    )?;
    // Rate limits are only available for supported ChatGPT-authenticated
    // accounts. API-key, Bedrock, and signed-out users should retain working
    // model controls with usage shown as unavailable.
    let limits = run_requests(
        &cli_path,
        vec![RpcRequest {
            method: "account/rateLimits/read",
            params: json!({}),
        }],
    )
    .ok()
    .and_then(|mut responses| responses.pop())
    .unwrap_or_else(|| json!({}));
    build_runtime_overview(&responses[0], &responses[1], &limits)
}

pub fn update_runtime_preferences(
    preferences: CodexRuntimePreferences,
) -> Result<CodexRuntimeOverview> {
    let cli_path = codex_cli_path()?;
    let model_and_config = run_requests(
        &cli_path,
        vec![
            RpcRequest {
                method: "model/list",
                params: json!({ "limit": 100, "includeHidden": false }),
            },
            RpcRequest {
                method: "config/read",
                params: json!({ "includeLayers": true }),
            },
        ],
    )?;
    let models = parse_models(&model_and_config[0]);
    let model = models
        .iter()
        .find(|model| model.id == preferences.model)
        .ok_or_else(|| anyhow!("The selected Codex model is not available"))?;
    if !model
        .supported_reasoning_efforts
        .iter()
        .any(|effort| effort.value == preferences.reasoning_effort)
    {
        return Err(anyhow!(
            "The selected reasoning effort is not supported by this model"
        ));
    }
    if preferences.fast_mode && !model.supports_fast_mode {
        return Err(anyhow!("Fast mode is not available for this model"));
    }

    let mut edits = vec![
        json!({
            "keyPath": "model",
            "value": model.model,
            "mergeStrategy": "replace"
        }),
        json!({
            "keyPath": "model_reasoning_effort",
            "value": preferences.reasoning_effort,
            "mergeStrategy": "replace"
        }),
        json!({
            "keyPath": "service_tier",
            "value": if preferences.fast_mode { Value::String("fast".to_string()) } else { Value::Null },
            "mergeStrategy": "replace"
        }),
    ];
    if preferences.fast_mode {
        edits.push(json!({
            "keyPath": "features.fast_mode",
            "value": true,
            "mergeStrategy": "upsert"
        }));
    }

    let expected_version = model_and_config[1]
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|layer| {
            let name = layer.get("name")?;
            let is_base_user_layer = string_field(name, "type") == Some("user")
                && name.get("profile").is_none_or(Value::is_null);
            is_base_user_layer
                .then(|| string_field(layer, "version"))
                .flatten()
                .map(str::to_string)
        });

    run_requests(
        &cli_path,
        vec![RpcRequest {
            method: "config/batchWrite",
            params: json!({
                "edits": edits,
                "expectedVersion": expected_version,
                "reloadUserConfig": true
            }),
        }],
    )?;
    runtime_overview()
}

#[cfg(test)]
mod tests {
    use super::{
        build_runtime_overview, parse_rate_limits, FIVE_HOUR_WINDOW_MINS, WEEKLY_WINDOW_MINS,
    };
    use serde_json::json;

    fn model_response() -> serde_json::Value {
        json!({
            "data": [
                {
                    "id": "gpt-test",
                    "model": "gpt-test-model",
                    "displayName": "GPT Test",
                    "description": "Primary model",
                    "hidden": false,
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Quick" },
                        { "reasoningEffort": "medium", "description": "Balanced" }
                    ],
                    "serviceTiers": [
                        { "id": "priority", "name": "Fast", "description": "Faster" }
                    ]
                }
            ]
        })
    }

    #[test]
    fn builds_catalog_driven_runtime_overview() {
        let overview = build_runtime_overview(
            &model_response(),
            &json!({
                "config": {
                    "model": "gpt-test",
                    "model_reasoning_effort": "low",
                    "service_tier": "priority"
                }
            }),
            &json!({
                "rateLimits": {
                    "limitId": "codex",
                    "planType": "pro",
                    "primary": {
                        "usedPercent": 25,
                        "windowDurationMins": FIVE_HOUR_WINDOW_MINS,
                        "resetsAt": 123
                    },
                    "secondary": {
                        "usedPercent": 40,
                        "windowDurationMins": WEEKLY_WINDOW_MINS,
                        "resetsAt": 456
                    }
                }
            }),
        )
        .expect("overview should parse");

        assert_eq!(overview.selected_model, "gpt-test");
        assert_eq!(overview.models[0].model, "gpt-test-model");
        assert_eq!(overview.selected_reasoning_effort, "low");
        assert!(overview.fast_mode);
        assert!(overview.models[0].supports_fast_mode);
        assert_eq!(overview.five_hour_limit.unwrap().used_percent, 25);
        assert_eq!(overview.weekly_limit.unwrap().used_percent, 40);
        assert_eq!(overview.plan_type.as_deref(), Some("pro"));
    }

    #[test]
    fn missing_five_hour_window_stays_unavailable() {
        let (five_hour, weekly, _) = parse_rate_limits(&json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": {
                        "usedPercent": 8,
                        "windowDurationMins": WEEKLY_WINDOW_MINS
                    },
                    "secondary": null
                }
            }
        }));
        assert!(five_hour.is_none());
        assert_eq!(weekly.unwrap().used_percent, 8);
    }

    #[test]
    fn scans_all_named_rate_limits_and_accepts_fractional_usage() {
        let (five_hour, weekly, plan_type) = parse_rate_limits(&json!({
            "rateLimitsByLimitId": {
                "codex-weekly": {
                    "planType": "team",
                    "primary": {
                        "usedPercent": 12.6,
                        "windowDurationMins": WEEKLY_WINDOW_MINS
                    }
                },
                "codex-burst": {
                    "primary": {
                        "usedPercent": 47.4,
                        "windowDurationMins": FIVE_HOUR_WINDOW_MINS
                    }
                }
            }
        }));

        assert_eq!(five_hour.unwrap().used_percent, 47);
        assert_eq!(weekly.unwrap().used_percent, 13);
        assert_eq!(plan_type.as_deref(), Some("team"));
    }
}
