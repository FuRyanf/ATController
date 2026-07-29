use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::process;
use super::protocol::{
    self, CodexDiscoveredProject, CodexThread, CodexThreadPage, CodexThreadSession, CodexTurn,
    ComposerInput, PermissionMode, ThreadPreferences,
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

    pub async fn discover_projects(
        self: &std::sync::Arc<Self>,
    ) -> Result<Vec<CodexDiscoveredProject>> {
        #[derive(Default)]
        struct Discovery {
            display_path: String,
            active: usize,
            archived: usize,
            latest: Option<i64>,
            thread_ids: Vec<String>,
        }

        let mut discovered: BTreeMap<String, Discovery> = BTreeMap::new();
        for archived in [false, true] {
            let mut cursor: Option<String> = None;
            for _ in 0..100 {
                let mut params = json!({
                    "archived": archived,
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "sourceKinds": ["cli", "vscode", "appServer"]
                });
                if let Some(value) = cursor.as_ref() {
                    params["cursor"] = Value::String(value.clone());
                }
                let result = self
                    .request(
                        "thread/list",
                        params,
                        RequestOptions::idempotent(Duration::from_secs(60)),
                    )
                    .await?;
                let page = protocol::normalize_thread_page(&result, archived)?;
                for thread in page.data {
                    let cwd = thread.cwd.trim();
                    if cwd.is_empty() {
                        continue;
                    }
                    let resolved =
                        std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
                    let key = resolved.to_string_lossy().to_string();
                    let entry = discovered.entry(key.clone()).or_default();
                    if entry.display_path.is_empty() {
                        entry.display_path = key;
                    }
                    if archived {
                        entry.archived += 1;
                    } else {
                        entry.active += 1;
                    }
                    entry.latest = [entry.latest, thread.recency_at, Some(thread.updated_at)]
                        .into_iter()
                        .flatten()
                        .max();
                    if !entry.thread_ids.iter().any(|id| id == &thread.id) {
                        entry.thread_ids.push(thread.id);
                    }
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
        }

        let registered = storage::load_workspaces()?;
        let mut projects = discovered
            .into_values()
            .map(|entry| {
                let path = PathBuf::from(&entry.display_path);
                let already_added = registered.iter().any(|workspace| {
                    std::fs::canonicalize(&workspace.path)
                        .map(|known| known == path)
                        .unwrap_or_else(|_| Path::new(&workspace.path) == path)
                });
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| "Project".to_string());
                CodexDiscoveredProject {
                    name,
                    workspace_path: entry.display_path,
                    thread_count: entry.active + entry.archived,
                    active_thread_count: entry.active,
                    archived_thread_count: entry.archived,
                    most_recent_activity: entry.latest,
                    already_added,
                    available: path.is_dir(),
                    thread_ids: entry.thread_ids,
                }
            })
            .collect::<Vec<_>>();
        projects.sort_by(|left, right| {
            right
                .most_recent_activity
                .cmp(&left.most_recent_activity)
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(projects)
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
            if !is_known_delete_cleanup_defect(&error) {
                return Err(error);
            }
            self.diagnostics.push_protocol_error(
                "Codex deleted the thread rollout but 0.144.0 reported its stale agent_jobs cleanup error",
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

fn is_known_delete_cleanup_defect(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("no such table: agent_jobs"))
}

#[cfg(test)]
mod delete_tests {
    use std::sync::Arc;
    use std::time::Duration;

    use anyhow::anyhow;
    use serde_json::json;
    use uuid::Uuid;

    use super::{is_known_delete_cleanup_defect, CodexRuntime, RequestOptions};

    #[test]
    fn recognizes_codex_0144_stale_agent_jobs_delete_error() {
        let error = anyhow!(
            "failed to delete app-server state for thread-1: error returned from database: \
             (code: 1) no such table: agent_jobs (-32603)"
        );
        assert!(is_known_delete_cleanup_defect(&error));
    }

    #[test]
    fn preserves_unrelated_thread_delete_errors() {
        assert!(!is_known_delete_cleanup_defect(&anyhow!(
            "thread/delete failed: permission denied"
        )));
    }

    #[tokio::test]
    #[ignore = "uses the installed Codex app-server to verify its 0.144.0 delete compatibility path"]
    async fn real_runtime_accepts_stale_agent_jobs_cleanup_failure() {
        if std::env::var_os("ATCONTROLLER_RUN_CODEX_DELETE_COMPAT").is_none() {
            eprintln!("skipped: set ATCONTROLLER_RUN_CODEX_DELETE_COMPAT=1");
            return;
        }
        let root =
            std::env::temp_dir().join(format!("atcontroller-delete-compat-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("temporary delete workspace should exist");
        let runtime = Arc::new(CodexRuntime::default());
        let started = runtime
            .request(
                "thread/start",
                json!({
                    "cwd": root.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                    "serviceName": "ATController-delete-compat",
                    "threadSource": "atcontroller"
                }),
                RequestOptions {
                    timeout: Duration::from_secs(90),
                    idempotent: false,
                },
            )
            .await
            .expect("temporary thread should start");
        let thread_id = started["thread"]["id"]
            .as_str()
            .expect("temporary thread should have an id")
            .to_string();

        let turn = runtime
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{
                        "type": "text",
                        "text": "Reply with exactly: OK",
                        "text_elements": []
                    }]
                }),
                RequestOptions {
                    timeout: Duration::from_secs(45),
                    idempotent: false,
                },
            )
            .await
            .expect("temporary turn should start");
        let turn_id = turn["turn"]["id"]
            .as_str()
            .expect("temporary turn should have an id")
            .to_string();
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let thread = runtime
                    .request(
                        "thread/read",
                        json!({"threadId": thread_id, "includeTurns": true}),
                        RequestOptions::idempotent(Duration::from_secs(30)),
                    )
                    .await
                    .expect("temporary thread should remain readable");
                let status = thread["thread"]["turns"]
                    .as_array()
                    .and_then(|turns| turns.iter().find(|turn| turn["id"] == turn_id))
                    .and_then(|turn| turn["status"].as_str());
                if status.is_some_and(|status| status != "inProgress") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
        .await
        .expect("temporary turn should finish before archiving");

        runtime
            .archive_thread(thread_id.clone())
            .await
            .expect("temporary thread should archive");
        let archived = runtime
            .request(
                "thread/list",
                json!({
                    "cwd": root.to_string_lossy(),
                    "archived": true,
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc"
                }),
                RequestOptions::idempotent(Duration::from_secs(30)),
            )
            .await
            .expect("archived threads should list");
        assert!(
            archived["data"]
                .as_array()
                .is_some_and(|threads| threads.iter().any(|thread| thread["id"] == thread_id)),
            "temporary thread should be visible in archived history before deletion"
        );

        runtime
            .delete_thread(thread_id.clone())
            .await
            .expect("the known post-delete cleanup defect should not block removal");
        let archived = runtime
            .request(
                "thread/list",
                json!({
                    "cwd": root.to_string_lossy(),
                    "archived": true,
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc"
                }),
                RequestOptions::idempotent(Duration::from_secs(30)),
            )
            .await
            .expect("archived threads should refresh after deletion");
        assert!(
            archived["data"]
                .as_array()
                .is_some_and(|threads| threads.iter().all(|thread| thread["id"] != thread_id)),
            "deleted thread must no longer be visible in archived history"
        );
        runtime.shutdown().await;
        let _ = std::fs::remove_dir_all(&root);
    }
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
