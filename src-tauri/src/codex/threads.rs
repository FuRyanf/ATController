use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::process;
use super::protocol::{
    self, CodexThread, CodexThreadPage, CodexThreadSession, CodexTurn, ComposerInput,
    PermissionMode, ThreadPreferences,
};
use super::rpc::RequestOptions;
use super::CodexRuntime;
use crate::storage;

impl CodexRuntime {
    pub async fn list_threads(
        self: &std::sync::Arc<Self>,
        workspace_path: String,
        archived: bool,
        search_term: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> Result<CodexThreadPage> {
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        let mut params = json!({
            "cwd": workspace_path,
            "archived": archived,
            "limit": limit.unwrap_or(100).clamp(1, 100),
            "sortKey": "recency_at",
            "sortDirection": "desc",
            "sourceKinds": ["cli", "vscode", "appServer"]
        });
        if let Some(search_term) = non_empty(search_term) {
            params["searchTerm"] = Value::String(search_term);
        }
        if let Some(cursor) = non_empty(cursor) {
            params["cursor"] = Value::String(cursor);
        }
        let result = self
            .request(
                "thread/list",
                params,
                RequestOptions::idempotent(Duration::from_secs(45)),
            )
            .await?;
        protocol::normalize_thread_page(&result, archived)
    }

    pub async fn read_thread(
        self: &std::sync::Arc<Self>,
        thread_id: String,
        include_turns: bool,
    ) -> Result<CodexThread> {
        validate_id(&thread_id, "thread id")?;
        let result = self
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": include_turns }),
                RequestOptions::idempotent(Duration::from_secs(60)),
            )
            .await?;
        protocol::normalize_thread(
            result
                .get("thread")
                .ok_or_else(|| anyhow!("thread/read response is missing thread"))?,
            false,
        )
    }

    pub async fn start_thread(
        self: &std::sync::Arc<Self>,
        workspace_path: String,
        preferences: ThreadPreferences,
        clear_replacement: bool,
    ) -> Result<CodexThreadSession> {
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        self.validate_preferences(&workspace_path, &preferences)
            .await?;
        let params = thread_open_params(
            &workspace_path,
            &preferences,
            Some(if clear_replacement {
                "clear"
            } else {
                "startup"
            }),
        );
        let result = self
            .request(
                "thread/start",
                params,
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await?;
        let session = protocol::normalize_thread_session(&result, &preferences)?;
        self.diagnostics
            .set_context(Some(workspace_path), Some(session.thread.id.clone()), None);
        update_effective_diagnostics(self, &session);
        persist_session_ui(self, &session, &preferences);
        Ok(session)
    }

    pub async fn resume_thread(
        self: &std::sync::Arc<Self>,
        workspace_path: String,
        thread_id: String,
        preferences: ThreadPreferences,
    ) -> Result<CodexThreadSession> {
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        validate_id(&thread_id, "thread id")?;
        self.validate_preferences(&workspace_path, &preferences)
            .await?;
        let mut params = thread_open_params(&workspace_path, &preferences, None);
        params["threadId"] = Value::String(thread_id);
        let result = self
            .request(
                "thread/resume",
                params,
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await?;
        let session = protocol::normalize_thread_session(&result, &preferences)?;
        self.diagnostics
            .set_context(Some(workspace_path), Some(session.thread.id.clone()), None);
        update_effective_diagnostics(self, &session);
        persist_session_ui(self, &session, &preferences);
        Ok(session)
    }

    pub async fn fork_thread(
        self: &std::sync::Arc<Self>,
        workspace_path: String,
        thread_id: String,
        last_turn_id: Option<String>,
        preferences: ThreadPreferences,
    ) -> Result<CodexThreadSession> {
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        validate_id(&thread_id, "thread id")?;
        self.validate_preferences(&workspace_path, &preferences)
            .await?;
        let mut params = thread_open_params(&workspace_path, &preferences, None);
        params["threadId"] = Value::String(thread_id);
        if let Some(last_turn_id) = non_empty(last_turn_id) {
            params["lastTurnId"] = Value::String(last_turn_id);
        }
        let result = self
            .request(
                "thread/fork",
                params,
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await?;
        let session = protocol::normalize_thread_session(&result, &preferences)?;
        persist_session_ui(self, &session, &preferences);
        Ok(session)
    }

    pub async fn rename_thread(
        self: &std::sync::Arc<Self>,
        thread_id: String,
        name: String,
    ) -> Result<()> {
        validate_id(&thread_id, "thread id")?;
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 200 {
            return Err(anyhow!("Thread name must contain 1 to 200 characters"));
        }
        self.request(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": name }),
            RequestOptions::default(),
        )
        .await?;
        Ok(())
    }

    pub async fn archive_thread(self: &std::sync::Arc<Self>, thread_id: String) -> Result<()> {
        self.thread_mutation("thread/archive", thread_id).await
    }

    pub async fn unarchive_thread(
        self: &std::sync::Arc<Self>,
        thread_id: String,
    ) -> Result<CodexThread> {
        validate_id(&thread_id, "thread id")?;
        let result = self
            .request(
                "thread/unarchive",
                json!({ "threadId": thread_id }),
                RequestOptions::default(),
            )
            .await?;
        protocol::normalize_thread(
            result
                .get("thread")
                .ok_or_else(|| anyhow!("thread/unarchive response is missing thread"))?,
            false,
        )
    }

    pub async fn delete_thread(self: &std::sync::Arc<Self>, thread_id: String) -> Result<()> {
        validate_id(&thread_id, "thread id")?;
        if let Err(error) = self
            .request(
                "thread/delete",
                json!({ "threadId": thread_id }),
                RequestOptions::default(),
            )
            .await
        {
            let known_cleanup_defect = error.to_string().contains("no such table: agent_jobs");
            if !known_cleanup_defect || self.read_thread(thread_id.clone(), false).await.is_ok() {
                return Err(error);
            }
            self.diagnostics.push_protocol_error(
                "Codex deleted the thread rollout but reported a stale agent_jobs cleanup error",
            );
        }
        storage::remove_codex_thread_ui_metadata(&thread_id)?;
        Ok(())
    }

    async fn thread_mutation(
        self: &std::sync::Arc<Self>,
        method: &str,
        thread_id: String,
    ) -> Result<()> {
        validate_id(&thread_id, "thread id")?;
        self.request(
            method,
            json!({ "threadId": thread_id }),
            RequestOptions::default(),
        )
        .await?;
        Ok(())
    }

    pub async fn start_turn(
        self: &std::sync::Arc<Self>,
        workspace_path: String,
        thread_id: String,
        inputs: Vec<ComposerInput>,
        preferences: ThreadPreferences,
    ) -> Result<CodexTurn> {
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        validate_id(&thread_id, "thread id")?;
        self.validate_preferences(&workspace_path, &preferences)
            .await?;
        self.validate_skill_inputs(&workspace_path, &inputs).await?;
        let input = protocol::build_wire_inputs(&workspace_path, inputs)?;
        let mut params = json!({
            "threadId": thread_id,
            "input": input,
            "cwd": workspace_path,
            "approvalPolicy": preferences.permission_mode.approval_policy(),
            "sandboxPolicy": sandbox_policy(preferences.permission_mode, &workspace_path)
        });
        optional_insert(&mut params, "model", preferences.model.clone());
        optional_insert(&mut params, "effort", preferences.reasoning_effort.clone());
        optional_insert(&mut params, "serviceTier", preferences.service_tier.clone());
        let result = self
            .request(
                "turn/start",
                params,
                RequestOptions {
                    timeout: Duration::from_secs(45),
                    idempotent: false,
                },
            )
            .await?;
        let turn = protocol::normalize_turn(
            result
                .get("turn")
                .ok_or_else(|| anyhow!("turn/start response is missing turn"))?,
        )?;
        self.diagnostics
            .set_context(Some(workspace_path), Some(thread_id), Some(turn.id.clone()));
        Ok(turn)
    }

    pub async fn steer_turn(
        self: &std::sync::Arc<Self>,
        workspace_path: String,
        thread_id: String,
        turn_id: String,
        inputs: Vec<ComposerInput>,
    ) -> Result<()> {
        let workspace_path = process::validate_workspace_path(&workspace_path)?;
        validate_id(&thread_id, "thread id")?;
        validate_id(&turn_id, "turn id")?;
        self.validate_skill_inputs(&workspace_path, &inputs).await?;
        let input = protocol::build_wire_inputs(&workspace_path, inputs)?;
        self.request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": turn_id,
                "input": input
            }),
            RequestOptions {
                timeout: Duration::from_secs(30),
                idempotent: false,
            },
        )
        .await?;
        Ok(())
    }

    pub async fn interrupt_turn(
        self: &std::sync::Arc<Self>,
        thread_id: String,
        turn_id: String,
    ) -> Result<()> {
        validate_id(&thread_id, "thread id")?;
        validate_id(&turn_id, "turn id")?;
        self.request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
            RequestOptions {
                timeout: Duration::from_secs(30),
                idempotent: false,
            },
        )
        .await?;
        Ok(())
    }

    async fn validate_preferences(
        self: &std::sync::Arc<Self>,
        workspace_path: &str,
        preferences: &ThreadPreferences,
    ) -> Result<()> {
        let catalog = self.runtime_catalog().await?;
        let profile = catalog
            .permission_profiles
            .iter()
            .find(|profile| profile.id == preferences.permission_mode.profile_id())
            .ok_or_else(|| {
                anyhow!(
                    "Codex does not expose the required structured permission profile {}",
                    preferences.permission_mode.profile_id()
                )
            })?;
        if !profile.allowed {
            return Err(anyhow!(
                "Codex configuration does not allow permission profile {} for {}",
                profile.id,
                workspace_path
            ));
        }
        let model = preferences
            .model
            .as_ref()
            .and_then(|requested| {
                catalog
                    .models
                    .iter()
                    .find(|model| model.id == *requested || model.model == *requested)
            })
            .or_else(|| {
                catalog.configured_model.as_ref().and_then(|configured| {
                    catalog
                        .models
                        .iter()
                        .find(|model| model.id == *configured || model.model == *configured)
                })
            })
            .or_else(|| catalog.models.iter().find(|model| model.is_default))
            .or_else(|| catalog.models.first())
            .ok_or_else(|| anyhow!("Codex returned no usable models"))?;
        if preferences.model.is_some()
            && !catalog.models.iter().any(|model| {
                preferences
                    .model
                    .as_ref()
                    .is_some_and(|requested| model.id == *requested || model.model == *requested)
            })
        {
            return Err(anyhow!("The requested Codex model is unavailable"));
        }
        if let Some(effort) = &preferences.reasoning_effort {
            if !model
                .reasoning_efforts
                .iter()
                .any(|option| option.value == *effort)
            {
                return Err(anyhow!(
                    "Reasoning effort `{effort}` is unsupported by {}",
                    model.display_name
                ));
            }
        }
        if let Some(service_tier) = &preferences.service_tier {
            if !model
                .service_tiers
                .iter()
                .any(|tier| tier.id == *service_tier)
            {
                return Err(anyhow!(
                    "Service tier `{service_tier}` is unsupported by {}",
                    model.display_name
                ));
            }
        }
        Ok(())
    }

    async fn validate_skill_inputs(
        self: &std::sync::Arc<Self>,
        workspace_path: &str,
        inputs: &[ComposerInput],
    ) -> Result<()> {
        let requested = inputs
            .iter()
            .filter_map(|input| match input {
                ComposerInput::Skill { name, path } => Some((name, path)),
                _ => None,
            })
            .collect::<Vec<_>>();
        if requested.is_empty() {
            return Ok(());
        }
        let available = self.list_skills(workspace_path.to_string(), false).await?;
        for (name, path) in requested {
            if !available
                .iter()
                .any(|skill| skill.enabled && skill.name == *name && skill.path == *path)
            {
                return Err(anyhow!(
                    "The selected Codex skill is unavailable for this workspace"
                ));
            }
        }
        Ok(())
    }
}

fn thread_open_params(
    workspace_path: &str,
    preferences: &ThreadPreferences,
    start_source: Option<&str>,
) -> Value {
    let mut params = json!({
        "cwd": workspace_path,
        "approvalPolicy": preferences.permission_mode.approval_policy(),
        "sandbox": preferences.permission_mode.sandbox_mode(),
        "serviceName": "ATController",
        "threadSource": "atcontroller"
    });
    optional_insert(&mut params, "model", preferences.model.clone());
    optional_insert(&mut params, "serviceTier", preferences.service_tier.clone());
    if let Some(effort) = preferences.reasoning_effort.clone() {
        params["config"] = json!({ "model_reasoning_effort": effort });
    }
    if let Some(source) = start_source {
        params["sessionStartSource"] = Value::String(source.to_string());
    }
    params
}

fn sandbox_policy(permission: PermissionMode, workspace_path: &str) -> Value {
    match permission {
        PermissionMode::Standard => json!({
            "type": "readOnly",
            "networkAccess": false
        }),
        PermissionMode::WorkspaceAccess => json!({
            "type": "workspaceWrite",
            "writableRoots": [workspace_path],
            "networkAccess": true,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        }),
        PermissionMode::FullAccess => json!({ "type": "dangerFullAccess" }),
    }
}

fn optional_insert(target: &mut Value, key: &str, value: Option<String>) {
    if let (Some(object), Some(value)) = (target.as_object_mut(), value) {
        object.insert(key.to_string(), Value::String(value));
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validate_id(value: &str, label: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || trimmed.chars().any(|character| character.is_control())
    {
        return Err(anyhow!("Invalid {label}"));
    }
    Ok(())
}

fn update_effective_diagnostics(runtime: &CodexRuntime, session: &CodexThreadSession) {
    runtime.diagnostics.set_effective_settings(
        session.settings.effective_model.clone(),
        session.settings.effective_reasoning_effort.clone(),
        Some(session.settings.permission_profile.clone()),
        Some(session.settings.approval_policy.clone()),
        Some(session.settings.sandbox_policy.clone()),
    );
}

fn persist_session_ui(
    runtime: &CodexRuntime,
    session: &CodexThreadSession,
    preferences: &ThreadPreferences,
) {
    if let Err(error) = storage::ensure_codex_thread_ui_metadata(
        &session.settings.cwd,
        &session.thread.id,
        &session.thread.title,
        permission_mode_label(preferences.permission_mode),
        preferences.model.clone(),
        preferences.reasoning_effort.clone(),
        preferences.service_tier.clone(),
    ) {
        runtime.diagnostics.push_protocol_error(&format!(
            "Unable to persist Codex thread UI metadata: {error:#}"
        ));
    }
}

fn permission_mode_label(permission: PermissionMode) -> &'static str {
    match permission {
        PermissionMode::Standard => "standard",
        PermissionMode::WorkspaceAccess => "workspaceAccess",
        PermissionMode::FullAccess => "fullAccess",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{sandbox_policy, thread_open_params};
    use crate::codex::protocol::{PermissionMode, ThreadPreferences};

    #[test]
    fn full_access_uses_stable_structured_fields() {
        let params = thread_open_params(
            "/tmp/project",
            &ThreadPreferences {
                permission_mode: PermissionMode::FullAccess,
                ..ThreadPreferences::default()
            },
            Some("startup"),
        );
        assert_eq!(params["sandbox"], "danger-full-access");
        assert_eq!(params["approvalPolicy"], "never");
        assert!(params.to_string().find("yolo").is_none());
    }

    #[test]
    fn turn_sandbox_policy_uses_generated_camel_case_variant() {
        assert_eq!(
            sandbox_policy(PermissionMode::FullAccess, "/tmp/project"),
            json!({"type":"dangerFullAccess"})
        );
    }
}
