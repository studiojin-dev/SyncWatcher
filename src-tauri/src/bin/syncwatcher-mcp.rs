use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use rmcp::{
    handler::server::{
        router::tool::ToolRouter,
        wrapper::{Json, Parameters},
    },
    model::{Implementation, ProtocolVersion, ServerInfo},
    tool, tool_handler, tool_router, ErrorData, ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use syncwatcher_lib::config_store::{
    default_config_dir, DeleteResultEnvelope, SettingsEnvelope, StoredSettings,
    SyncTaskEnvelope, SyncTasksEnvelope, SETTINGS_FILE_NAME,
};
use syncwatcher_lib::control_plane::{
    default_socket_path, send_request, ControlPlaneRequest, ControlPlaneResponse,
};
use syncwatcher_lib::mcp_jobs::McpJobEnvelope;
use syncwatcher_lib::system_integration::VolumeInfo;

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct TaskIdInput {
    task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct JobIdInput {
    job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateSettingsInput {
    language: Option<String>,
    theme: Option<String>,
    data_unit_system: Option<String>,
    notifications: Option<bool>,
    close_action: Option<String>,
    mcp_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateSyncTaskInput {
    name: String,
    source: String,
    target: String,
    #[serde(default)]
    checksum_mode: bool,
    #[serde(default = "default_verify_after_copy")]
    verify_after_copy: bool,
    #[serde(default)]
    exclusion_sets: Vec<String>,
    #[serde(default)]
    watch_mode: bool,
    #[serde(default)]
    auto_unmount: bool,
    source_type: Option<String>,
    source_uuid: Option<String>,
    source_uuid_type: Option<String>,
    source_sub_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateSyncTaskInput {
    task_id: String,
    name: Option<String>,
    source: Option<String>,
    target: Option<String>,
    checksum_mode: Option<bool>,
    verify_after_copy: Option<bool>,
    exclusion_sets: Option<Vec<String>>,
    watch_mode: Option<bool>,
    auto_unmount: Option<bool>,
    source_type: Option<String>,
    source_uuid: Option<String>,
    source_uuid_type: Option<String>,
    source_sub_path: Option<String>,
}

fn default_verify_after_copy() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct JobIdEnvelope {
    job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CancelledEnvelope {
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatePayload {
    watching_tasks: Vec<String>,
    syncing_tasks: Vec<String>,
    queued_tasks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RuntimeStateEnvelope {
    runtime_state: RuntimeStatePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct VolumesEnvelope {
    volumes: Vec<VolumeInfo>,
}

#[derive(Debug, Clone)]
struct SyncWatcherMcpServer {
    tool_router: ToolRouter<Self>,
}

impl SyncWatcherMcpServer {
    fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

fn settings_file_path() -> Result<PathBuf, ErrorData> {
    default_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE_NAME))
        .map_err(|error| ErrorData::internal_error(error.to_tauri_error_string(), None))
}

fn read_persisted_mcp_enabled() -> Result<Option<bool>, ErrorData> {
    let path = settings_file_path()?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ErrorData::internal_error(
                format!("Failed to read '{}': {error}", path.display()),
                None,
            ));
        }
    };

    if raw.trim().is_empty() {
        return Ok(Some(false));
    }

    serde_yaml::from_str::<StoredSettings>(&raw)
        .map(|settings| Some(settings.mcp_enabled))
        .map_err(|error| {
            ErrorData::invalid_request(
                format!("Failed to parse '{}': {error}", path.display()),
                None,
            )
        })
}

fn actionable_connect_error(socket_path: &PathBuf, connect_error: String) -> ErrorData {
    match read_persisted_mcp_enabled() {
        Ok(Some(false)) => ErrorData::invalid_request(
            "MCP control is disabled in SyncWatcher. Enable MCP Control in Settings and retry. SyncWatcher never auto-launches for MCP.".to_string(),
            Some(json!({
                "socketPath": socket_path,
                "connectError": connect_error,
                "reason": "disabled"
            })),
        ),
        Ok(Some(true)) | Ok(None) => ErrorData::invalid_request(
            "SyncWatcher must already be running with MCP Control enabled. Launch the app manually and retry.".to_string(),
            Some(json!({
                "socketPath": socket_path,
                "connectError": connect_error,
                "reason": "app_not_running"
            })),
        ),
        Err(error) => error,
    }
}

fn map_control_plane_error(response: &ControlPlaneResponse) -> ErrorData {
    let Some(error) = response.error.as_ref() else {
        return ErrorData::internal_error("Control plane request failed", None);
    };

    let data = Some(json!({
        "requestId": response.request_id,
        "controlPlaneCode": error.code
    }));

    match error.code.as_str() {
        "invalid_request" => ErrorData::invalid_request(error.message.clone(), data),
        "invalid_params" => ErrorData::invalid_params(error.message.clone(), data),
        _ => ErrorData::internal_error(error.message.clone(), data),
    }
}

fn next_request_id(method: &str) -> String {
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    format!("syncwatcher-mcp-{method}-{sequence}")
}

async fn relay_request(method: &'static str, params: Value) -> Result<Json<Value>, ErrorData> {
    let socket_path =
        default_socket_path().map_err(|error| ErrorData::internal_error(error, None))?;
    let request = ControlPlaneRequest {
        request_id: next_request_id(method),
        method: method.to_string(),
        params,
    };

    let response = send_request(&socket_path, &request)
        .await
        .map_err(|error| {
            if error.starts_with("Failed to connect to ") {
                actionable_connect_error(&socket_path, error)
            } else {
                ErrorData::internal_error(
                    format!("Control plane transport failed: {error}"),
                    Some(json!({
                        "socketPath": socket_path,
                        "requestId": request.request_id
                    })),
                )
            }
        })?;

    if !response.ok {
        return Err(map_control_plane_error(&response));
    }

    let Some(result) = response.result else {
        return Err(ErrorData::internal_error(
            format!("Control plane returned no result for {method}"),
            Some(json!({ "requestId": response.request_id })),
        ));
    };

    Ok(Json(result))
}

async fn relay_request_typed<T>(
    method: &'static str,
    params: Value,
) -> Result<Json<T>, ErrorData>
where
    T: DeserializeOwned + JsonSchema,
{
    let Json(result) = relay_request(method, params).await?;
    let typed = serde_json::from_value::<T>(result).map_err(|error| {
        ErrorData::internal_error(
            format!("Failed to decode relay result for {method}: {error}"),
            None,
        )
    })?;
    Ok(Json(typed))
}

#[tool_router]
impl SyncWatcherMcpServer {
    #[tool(
        name = "syncwatcher_get_settings",
        description = "Read SyncWatcher settings from the running app backend.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn get_settings(&self) -> Result<Json<SettingsEnvelope>, ErrorData> {
        relay_request_typed("syncwatcher_get_settings", json!({})).await
    }

    #[tool(
        name = "syncwatcher_update_settings",
        description = "Update SyncWatcher settings that are exposed to MCP: language, theme, dataUnitSystem, notifications, closeAction, and mcpEnabled.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn update_settings(
        &self,
        Parameters(params): Parameters<UpdateSettingsInput>,
    ) -> Result<Json<SettingsEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode settings patch: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_update_settings", params).await
    }

    #[tool(
        name = "syncwatcher_list_sync_tasks",
        description = "List all SyncWatcher sync tasks from the running app backend.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn list_sync_tasks(&self) -> Result<Json<SyncTasksEnvelope>, ErrorData> {
        relay_request_typed("syncwatcher_list_sync_tasks", json!({})).await
    }

    #[tool(
        name = "syncwatcher_get_sync_task",
        description = "Read one SyncWatcher sync task by taskId.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn get_sync_task(
        &self,
        Parameters(params): Parameters<TaskIdInput>,
    ) -> Result<Json<SyncTaskEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode task id: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_get_sync_task", params).await
    }

    #[tool(
        name = "syncwatcher_create_sync_task",
        description = "Create a new SyncWatcher sync task. The backend assigns the task id and validates all runtime safety constraints.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn create_sync_task(
        &self,
        Parameters(params): Parameters<CreateSyncTaskInput>,
    ) -> Result<Json<SyncTaskEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode sync task: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_create_sync_task", params).await
    }

    #[tool(
        name = "syncwatcher_update_sync_task",
        description = "Update an existing SyncWatcher sync task by taskId.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn update_sync_task(
        &self,
        Parameters(params): Parameters<UpdateSyncTaskInput>,
    ) -> Result<Json<SyncTaskEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode sync task update: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_update_sync_task", params).await
    }

    #[tool(
        name = "syncwatcher_delete_sync_task",
        description = "Delete a SyncWatcher sync task by taskId.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn delete_sync_task(
        &self,
        Parameters(params): Parameters<TaskIdInput>,
    ) -> Result<Json<DeleteResultEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode task id: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_delete_sync_task", params).await
    }

    #[tool(
        name = "syncwatcher_start_dry_run",
        description = "Start a dry-run for a SyncWatcher sync task and return an MCP jobId for polling.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn start_dry_run(
        &self,
        Parameters(params): Parameters<TaskIdInput>,
    ) -> Result<Json<JobIdEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode task id: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_start_dry_run", params).await
    }

    #[tool(
        name = "syncwatcher_start_sync",
        description = "Start a real sync for a SyncWatcher sync task and return an MCP jobId for polling.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn start_sync(
        &self,
        Parameters(params): Parameters<TaskIdInput>,
    ) -> Result<Json<JobIdEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode task id: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_start_sync", params).await
    }

    #[tool(
        name = "syncwatcher_start_orphan_scan",
        description = "Start an orphan scan for a SyncWatcher sync task and return an MCP jobId for polling.",
        annotations(
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn start_orphan_scan(
        &self,
        Parameters(params): Parameters<TaskIdInput>,
    ) -> Result<Json<JobIdEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode task id: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_start_orphan_scan", params).await
    }

    #[tool(
        name = "syncwatcher_get_job",
        description = "Read the current state of an MCP job by jobId.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn get_job(
        &self,
        Parameters(params): Parameters<JobIdInput>,
    ) -> Result<Json<McpJobEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode job id: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_get_job", params).await
    }

    #[tool(
        name = "syncwatcher_cancel_job",
        description = "Cancel a running MCP job by jobId.",
        annotations(
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false,
            open_world_hint = false
        )
    )]
    async fn cancel_job(
        &self,
        Parameters(params): Parameters<JobIdInput>,
    ) -> Result<Json<CancelledEnvelope>, ErrorData> {
        let params = serde_json::to_value(params).map_err(|error| {
            ErrorData::internal_error(format!("Failed to encode job id: {error}"), None)
        })?;
        relay_request_typed("syncwatcher_cancel_job", params).await
    }

    #[tool(
        name = "syncwatcher_get_runtime_state",
        description = "Read current runtime watcher, queue, and syncing state from the running app backend.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn get_runtime_state(&self) -> Result<Json<RuntimeStateEnvelope>, ErrorData> {
        relay_request_typed("syncwatcher_get_runtime_state", json!({})).await
    }

    #[tool(
        name = "syncwatcher_list_removable_volumes",
        description = "List currently mounted removable volumes as seen by the running app backend.",
        annotations(
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = false
        )
    )]
    async fn list_removable_volumes(&self) -> Result<Json<VolumesEnvelope>, ErrorData> {
        relay_request_typed("syncwatcher_list_removable_volumes", json!({})).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SyncWatcherMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::default()
            .with_protocol_version(ProtocolVersion::LATEST)
            .with_server_info(
                Implementation::new("syncwatcher-mcp", env!("CARGO_PKG_VERSION"))
                    .with_title("SyncWatcher MCP Relay")
                    .with_description(
                        "Thin stdio MCP relay for a manually launched SyncWatcher app.",
                    ),
            )
            .with_instructions(
                "This server only relays to a running SyncWatcher app over a local Unix socket. SyncWatcher never auto-launches for MCP. Enable MCP Control in the app settings first, then poll get_job after start_sync, start_dry_run, or start_orphan_scan.",
            )
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = SyncWatcherMcpServer::new();
    let transport = rmcp::transport::io::stdio();
    server.serve(transport).await?.waiting().await?;
    Ok(())
}
