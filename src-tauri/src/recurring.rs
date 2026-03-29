use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::{Tz, TZ_VARIANTS};
use cron::Schedule;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

pub const DEFAULT_RECURRING_SCHEDULE_RETENTION_COUNT: u32 = 20;
pub const MIN_RECURRING_SCHEDULE_RETENTION_COUNT: u32 = 1;
pub const MAX_RECURRING_SCHEDULE_RETENTION_COUNT: u32 = 200;

const RECURRING_HISTORY_DIR_NAME: &str = "state/recurring-history";

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecurringScheduleRecord {
    pub id: String,
    pub cron_expression: String,
    pub timezone: String,
    #[serde(default = "default_recurring_schedule_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub checksum_mode: bool,
    #[serde(default = "default_recurring_schedule_retention_count")]
    pub retention_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecurringScheduleHistoryStatus {
    Success,
    Failure,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecurringScheduleHistoryEntry {
    pub scheduled_for: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: RecurringScheduleHistoryStatus,
    pub checksum_mode: bool,
    pub cron_expression: String,
    pub timezone: String,
    pub message: String,
    #[serde(default)]
    pub error_detail: Option<String>,
    #[serde(default)]
    pub conflict_count: u64,
}

pub fn default_recurring_schedule_enabled() -> bool {
    true
}

pub fn default_recurring_schedule_retention_count() -> u32 {
    DEFAULT_RECURRING_SCHEDULE_RETENTION_COUNT
}

pub fn supported_timezone_names() -> Vec<String> {
    TZ_VARIANTS.iter().map(ToString::to_string).collect()
}

pub fn parse_timezone(value: &str) -> Result<Tz, String> {
    Tz::from_str(value.trim()).map_err(|_| format!("Unsupported timezone: {value}"))
}

pub fn normalize_cron_expression(value: &str) -> Result<String, String> {
    let normalized = value
        .split_whitespace()
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    let field_count = normalized.split_whitespace().count();
    if field_count != 5 {
        return Err("Cron expression must use 5 fields (min hour day month weekday)".to_string());
    }

    let schedule_source = format!("0 {normalized}");
    Schedule::from_str(&schedule_source)
        .map_err(|error| format!("Invalid cron expression: {error}"))?;

    Ok(normalized)
}

pub fn validate_recurring_schedules(schedules: &[RecurringScheduleRecord]) -> Result<(), String> {
    let mut seen_ids = HashSet::new();

    for schedule in schedules {
        if schedule.id.trim().is_empty() {
            return Err("Recurring schedule id cannot be empty".to_string());
        }
        if !seen_ids.insert(schedule.id.clone()) {
            return Err(format!("Duplicate recurring schedule id: {}", schedule.id));
        }
        if schedule.retention_count < MIN_RECURRING_SCHEDULE_RETENTION_COUNT
            || schedule.retention_count > MAX_RECURRING_SCHEDULE_RETENTION_COUNT
        {
            return Err(format!(
                "Recurring schedule retentionCount must be between {MIN_RECURRING_SCHEDULE_RETENTION_COUNT} and {MAX_RECURRING_SCHEDULE_RETENTION_COUNT}"
            ));
        }

        let _ = normalize_cron_expression(&schedule.cron_expression)?;
        let _ = parse_timezone(&schedule.timezone)?;
    }

    Ok(())
}

pub fn normalize_recurring_schedule(
    mut schedule: RecurringScheduleRecord,
) -> Result<RecurringScheduleRecord, String> {
    if schedule.id.trim().is_empty() {
        return Err("Recurring schedule id cannot be empty".to_string());
    }

    schedule.id = schedule.id.trim().to_string();
    schedule.cron_expression = normalize_cron_expression(&schedule.cron_expression)?;
    schedule.timezone = schedule.timezone.trim().to_string();
    let _ = parse_timezone(&schedule.timezone)?;
    if schedule.retention_count < MIN_RECURRING_SCHEDULE_RETENTION_COUNT
        || schedule.retention_count > MAX_RECURRING_SCHEDULE_RETENTION_COUNT
    {
        return Err(format!(
            "Recurring schedule retentionCount must be between {MIN_RECURRING_SCHEDULE_RETENTION_COUNT} and {MAX_RECURRING_SCHEDULE_RETENTION_COUNT}"
        ));
    }

    Ok(schedule)
}

pub fn normalize_recurring_schedules(
    schedules: Vec<RecurringScheduleRecord>,
) -> Result<Vec<RecurringScheduleRecord>, String> {
    let mut normalized = Vec::with_capacity(schedules.len());
    let mut seen_ids = HashSet::new();

    for schedule in schedules {
        let schedule = normalize_recurring_schedule(schedule)?;
        if !seen_ids.insert(schedule.id.clone()) {
            return Err(format!("Duplicate recurring schedule id: {}", schedule.id));
        }
        normalized.push(schedule);
    }

    Ok(normalized)
}

pub fn next_scheduled_fire_at(
    schedule: &RecurringScheduleRecord,
    after_utc: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, String> {
    if !schedule.enabled {
        return Ok(None);
    }

    let timezone = parse_timezone(&schedule.timezone)?;
    let schedule_source = format!("0 {}", normalize_cron_expression(&schedule.cron_expression)?);
    let parsed = Schedule::from_str(&schedule_source)
        .map_err(|error| format!("Invalid cron expression: {error}"))?;
    let reference = after_utc.with_timezone(&timezone) - Duration::seconds(1);
    Ok(parsed.after(&reference).next().map(|dt| dt.with_timezone(&Utc)))
}

#[derive(Debug, Clone)]
pub struct RecurringScheduleHistoryStore {
    root_dir: PathBuf,
}

impl RecurringScheduleHistoryStore {
    pub fn new(app_support_dir: PathBuf) -> Self {
        Self {
            root_dir: app_support_dir.join(RECURRING_HISTORY_DIR_NAME),
        }
    }

    pub fn root_dir(&self) -> &Path {
        &self.root_dir
    }

    pub fn history_file_path(&self, task_id: &str, schedule_id: &str) -> PathBuf {
        self.root_dir
            .join(task_id)
            .join(format!("{schedule_id}.yaml"))
    }

    pub fn read_history(
        &self,
        task_id: &str,
        schedule_id: &str,
    ) -> Result<Vec<RecurringScheduleHistoryEntry>, String> {
        let path = self.history_file_path(task_id, schedule_id);
        match fs::read_to_string(&path) {
            Ok(raw) if raw.trim().is_empty() => Ok(Vec::new()),
            Ok(raw) => serde_yaml::from_str(&raw)
                .map_err(|error| format!("Failed to parse recurring schedule history: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(format!("Failed to read recurring schedule history: {error}")),
        }
    }

    pub fn append_entry(
        &self,
        task_id: &str,
        schedule_id: &str,
        retention_count: u32,
        entry: RecurringScheduleHistoryEntry,
    ) -> Result<Vec<RecurringScheduleHistoryEntry>, String> {
        let mut history = self.read_history(task_id, schedule_id)?;
        history.insert(0, entry);
        history.truncate(retention_count as usize);
        self.write_history(task_id, schedule_id, &history)?;
        Ok(history)
    }

    pub fn write_history(
        &self,
        task_id: &str,
        schedule_id: &str,
        entries: &[RecurringScheduleHistoryEntry],
    ) -> Result<(), String> {
        let path = self.history_file_path(task_id, schedule_id);
        self.write_yaml_atomic(&path, entries)
    }

    pub fn clear_history(&self, task_id: &str, schedule_id: &str) -> Result<(), String> {
        let path = self.history_file_path(task_id, schedule_id);
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to clear recurring schedule history: {error}")),
        }
    }

    pub fn clear_all_task_history(&self, task_id: &str) -> Result<(), String> {
        let task_dir = self.root_dir.join(task_id);
        match fs::remove_dir_all(task_dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Failed to clear recurring schedule task history: {error}"
            )),
        }
    }

    pub fn remove_deleted_schedule_history(
        &self,
        task_id: &str,
        keep_schedule_ids: &HashSet<String>,
    ) -> Result<(), String> {
        let task_dir = self.root_dir.join(task_id);
        let read_dir = match fs::read_dir(&task_dir) {
            Ok(read_dir) => read_dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "Failed to inspect recurring schedule history directory: {error}"
                ))
            }
        };

        for entry in read_dir {
            let entry = entry.map_err(|error| {
                format!("Failed to inspect recurring schedule history file: {error}")
            })?;
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if keep_schedule_ids.contains(stem) {
                continue;
            }
            fs::remove_file(&path)
                .map_err(|error| format!("Failed to remove recurring schedule history: {error}"))?;
        }

        if fs::read_dir(&task_dir)
            .map_err(|error| format!("Failed to inspect recurring schedule history: {error}"))?
            .next()
            .is_none()
        {
            let _ = fs::remove_dir(&task_dir);
        }

        Ok(())
    }

    fn write_yaml_atomic<T: Serialize + ?Sized>(&self, path: &Path, value: &T) -> Result<(), String> {
        let bytes = serde_yaml::to_string(value)
            .map_err(|error| format!("Failed to serialize recurring schedule history: {error}"))?;
        let Some(parent) = path.parent() else {
            return Err("Recurring schedule history path has no parent".to_string());
        };
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to prepare recurring schedule history dir: {error}"))?;
        let mut temp = NamedTempFile::new_in(parent)
            .map_err(|error| format!("Failed to create temp recurring schedule history file: {error}"))?;
        temp.write_all(bytes.as_bytes())
            .map_err(|error| format!("Failed to write temp recurring schedule history file: {error}"))?;
        temp.flush()
            .map_err(|error| format!("Failed to flush temp recurring schedule history file: {error}"))?;
        temp.persist(path)
            .map_err(|error| format!("Failed to persist recurring schedule history file: {}", error.error))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn build_schedule() -> RecurringScheduleRecord {
        RecurringScheduleRecord {
            id: "schedule-1".to_string(),
            cron_expression: "15 9 * * 1,3".to_string(),
            timezone: "Asia/Seoul".to_string(),
            enabled: true,
            checksum_mode: true,
            retention_count: 3,
        }
    }

    #[test]
    fn normalizes_and_validates_five_field_cron() {
        let schedule = normalize_recurring_schedule(build_schedule()).expect("schedule should normalize");
        assert_eq!(schedule.cron_expression, "15 9 * * 1,3");
    }

    #[test]
    fn rejects_invalid_timezone() {
        let error = normalize_recurring_schedule(RecurringScheduleRecord {
            timezone: "Mars/Base".to_string(),
            ..build_schedule()
        })
        .expect_err("schedule should reject invalid timezone");
        assert!(error.contains("Unsupported timezone"));
    }

    #[test]
    fn computes_next_fire_at_in_timezone() {
        let next = next_scheduled_fire_at(
            &build_schedule(),
            DateTime::parse_from_rfc3339("2026-03-29T00:00:00Z")
                .expect("timestamp should parse")
                .with_timezone(&Utc),
        )
        .expect("next fire should compute")
        .expect("schedule should produce next fire");

        assert_eq!(next.to_rfc3339(), "2026-03-29T00:15:00+00:00");
    }

    #[test]
    fn history_store_truncates_to_retention() {
        let temp = tempdir().expect("tempdir should exist");
        let store = RecurringScheduleHistoryStore::new(temp.path().to_path_buf());

        for index in 0..4 {
            store
                .append_entry(
                    "task-1",
                    "schedule-1",
                    2,
                    RecurringScheduleHistoryEntry {
                        scheduled_for: format!("2026-03-28T0{index}:00:00Z"),
                        started_at: format!("2026-03-28T0{index}:00:01Z"),
                        finished_at: format!("2026-03-28T0{index}:00:02Z"),
                        status: RecurringScheduleHistoryStatus::Success,
                        checksum_mode: false,
                        cron_expression: "0 * * * *".to_string(),
                        timezone: "UTC".to_string(),
                        message: format!("run-{index}"),
                        error_detail: None,
                        conflict_count: 0,
                    },
                )
                .expect("history append should succeed");
        }

        let history = store
            .read_history("task-1", "schedule-1")
            .expect("history should load");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].message, "run-3");
        assert_eq!(history[1].message, "run-2");
    }
}
