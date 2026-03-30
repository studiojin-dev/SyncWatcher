use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

const MAX_TERMINAL_JOBS: usize = 200;

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
        drop(jobs);
        self.prune_terminal_jobs().await;
    }

    pub async fn fail_job(&self, job_id: &str, error: String, now_ms: i64) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = McpJobStatus::Failed;
            job.error = Some(error);
            job.updated_at_unix_ms = now_ms;
        }
        drop(jobs);
        self.prune_terminal_jobs().await;
    }

    pub async fn cancel_job(&self, job_id: &str, now_ms: i64) -> bool {
        let cancelled = {
            let tokens = self.cancel_tokens.read().await;
            tokens.get(job_id).cloned()
        };

        if let Some(token) = cancelled {
            token.cancel();
            self.mark_cancelled(job_id, now_ms).await;
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

    pub async fn mark_cancelled(&self, job_id: &str, now_ms: i64) {
        let mut jobs = self.jobs.write().await;
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = McpJobStatus::Cancelled;
            job.updated_at_unix_ms = now_ms;
        }
        drop(jobs);
        self.prune_terminal_jobs().await;
    }

    async fn prune_terminal_jobs(&self) {
        let active_token_ids = {
            let tokens = self.cancel_tokens.read().await;
            tokens.keys().cloned().collect::<std::collections::HashSet<_>>()
        };

        let pruned_ids = {
            let mut jobs = self.jobs.write().await;
            let mut terminal_jobs: Vec<(String, i64)> = jobs
                .iter()
                .filter(|(job_id, job)| {
                    !active_token_ids.contains(*job_id)
                        && matches!(
                            job.status,
                            McpJobStatus::Completed
                                | McpJobStatus::Failed
                                | McpJobStatus::Cancelled
                        )
                })
                .map(|(job_id, job)| (job_id.clone(), job.updated_at_unix_ms))
                .collect();

            if terminal_jobs.len() <= MAX_TERMINAL_JOBS {
                Vec::new()
            } else {
                terminal_jobs.sort_by_key(|(_, updated_at)| *updated_at);
                let remove_count = terminal_jobs.len() - MAX_TERMINAL_JOBS;
                let ids: Vec<String> = terminal_jobs
                    .into_iter()
                    .take(remove_count)
                    .map(|(job_id, _)| job_id)
                    .collect();
                for job_id in &ids {
                    jobs.remove(job_id);
                }
                ids
            }
        };

        if pruned_ids.is_empty() {
            return;
        }

        let mut tokens = self.cancel_tokens.write().await;
        for job_id in pruned_ids {
            tokens.remove(&job_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_job(job_id: &str, status: McpJobStatus, updated_at_unix_ms: i64) -> McpJobRecord {
        McpJobRecord {
            job_id: job_id.to_string(),
            kind: McpJobKind::Sync,
            task_id: Some("task-1".to_string()),
            status,
            progress: None,
            result: None,
            error: None,
            created_at_unix_ms: updated_at_unix_ms,
            updated_at_unix_ms,
        }
    }

    #[tokio::test]
    async fn prunes_oldest_terminal_jobs_after_completion() {
        let registry = McpJobRegistry::new();

        for index in 0..=MAX_TERMINAL_JOBS {
            registry
                .insert_job(make_job(
                    &format!("job-{index}"),
                    McpJobStatus::Completed,
                    index as i64,
                ))
                .await;
        }

        registry
            .complete_job(
                &format!("job-{MAX_TERMINAL_JOBS}"),
                serde_json::json!({"ok": true}),
                MAX_TERMINAL_JOBS as i64,
            )
            .await;

        let jobs = registry.jobs.read().await;
        assert_eq!(jobs.len(), MAX_TERMINAL_JOBS);
        assert!(!jobs.contains_key("job-0"));
        assert!(jobs.contains_key(&format!("job-{MAX_TERMINAL_JOBS}")));
    }

    #[tokio::test]
    async fn prune_keeps_active_jobs_even_when_terminal_limit_exceeded() {
        let registry = McpJobRegistry::new();

        for index in 0..MAX_TERMINAL_JOBS {
            registry
                .insert_job(make_job(
                    &format!("terminal-{index}"),
                    McpJobStatus::Completed,
                    index as i64,
                ))
                .await;
        }

        registry
            .insert_job(make_job("running-job", McpJobStatus::Running, 10_000))
            .await;
        registry
            .attach_cancel_token("running-job", CancellationToken::new())
            .await;

        registry
            .insert_job(make_job("terminal-new", McpJobStatus::Failed, 20_000))
            .await;
        registry.fail_job("terminal-new", "boom".to_string(), 20_000).await;

        let jobs = registry.jobs.read().await;
        assert!(jobs.contains_key("running-job"));
        assert_eq!(jobs.len(), MAX_TERMINAL_JOBS + 1);
        assert!(!jobs.contains_key("terminal-0"));
    }

    #[tokio::test]
    async fn cancelled_jobs_are_pruned_after_token_detaches() {
        let registry = McpJobRegistry::new();

        for index in 0..MAX_TERMINAL_JOBS {
            registry
                .insert_job(make_job(
                    &format!("terminal-{index}"),
                    McpJobStatus::Completed,
                    index as i64,
                ))
                .await;
        }

        registry
            .insert_job(make_job("cancelled-job", McpJobStatus::Running, 999))
            .await;
        registry
            .attach_cancel_token("cancelled-job", CancellationToken::new())
            .await;

        assert!(registry.cancel_job("cancelled-job", 1_000).await);
        assert!(registry.get_job("cancelled-job").await.is_some());

        registry.detach_cancel_token("cancelled-job").await;
        registry.mark_cancelled("cancelled-job", 1_001).await;

        let jobs = registry.jobs.read().await;
        assert_eq!(jobs.len(), MAX_TERMINAL_JOBS);
        assert!(!jobs.contains_key("terminal-0"));
        assert!(jobs.contains_key("cancelled-job"));
    }
}
