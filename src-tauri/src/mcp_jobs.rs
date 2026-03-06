use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpJobKind {
    Sync,
    DryRun,
    OrphanScan,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpJobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpJobProgress {
    pub message: Option<String>,
    pub current: u64,
    pub total: u64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub current_file_bytes_copied: u64,
    pub current_file_total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpJobRecord {
    pub job_id: String,
    pub kind: McpJobKind,
    pub task_id: Option<String>,
    pub status: McpJobStatus,
    pub progress: Option<McpJobProgress>,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

impl McpJobRecord {
    pub fn new(job_id: String, kind: McpJobKind, task_id: Option<String>, now_ms: i64) -> Self {
        Self {
            job_id,
            kind,
            task_id,
            status: McpJobStatus::Queued,
            progress: None,
            result: None,
            error: None,
            created_at_unix_ms: now_ms,
            updated_at_unix_ms: now_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpJobEnvelope {
    pub job: McpJobRecord,
}

#[derive(Debug, Clone, Default)]
pub struct McpJobRegistry {
    jobs: Arc<RwLock<HashMap<String, McpJobRecord>>>,
    cancel_tokens: Arc<RwLock<HashMap<String, CancellationToken>>>,
}

impl McpJobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert_job(&self, job: McpJobRecord) {
        let mut jobs = self.jobs.write().await;
        jobs.insert(job.job_id.clone(), job);
    }

    pub async fn get_job(&self, job_id: &str) -> Option<McpJobRecord> {
        let jobs = self.jobs.read().await;
        jobs.get(job_id).cloned()
    }

    pub async fn set_status(&self, job_id: &str, status: McpJobStatus, now_ms: i64) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = status;
            job.updated_at_unix_ms = now_ms;
        }
    }

    pub fn try_update_progress(&self, job_id: &str, progress: McpJobProgress, now_ms: i64) {
        if let Ok(mut jobs) = self.jobs.try_write() {
            if let Some(job) = jobs.get_mut(job_id) {
                job.progress = Some(progress);
                job.updated_at_unix_ms = now_ms;
            }
        }
    }

    pub async fn complete_job(&self, job_id: &str, result: serde_json::Value, now_ms: i64) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = McpJobStatus::Completed;
            job.result = Some(result);
            job.error = None;
            job.updated_at_unix_ms = now_ms;
        }
    }

    pub async fn fail_job(&self, job_id: &str, error: String, now_ms: i64) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = McpJobStatus::Failed;
            job.error = Some(error);
            job.updated_at_unix_ms = now_ms;
        }
    }

    pub async fn cancel_job(&self, job_id: &str, now_ms: i64) -> bool {
        let cancelled = {
            let tokens = self.cancel_tokens.read().await;
            tokens.get(job_id).cloned()
        };

        if let Some(token) = cancelled {
            token.cancel();
            self.set_status(job_id, McpJobStatus::Cancelled, now_ms)
                .await;
            return true;
        }

        false
    }

    pub async fn attach_cancel_token(&self, job_id: &str, token: CancellationToken) {
        let mut tokens = self.cancel_tokens.write().await;
        tokens.insert(job_id.to_string(), token);
    }

    pub async fn detach_cancel_token(&self, job_id: &str) {
        let mut tokens = self.cancel_tokens.write().await;
        tokens.remove(job_id);
    }
}
