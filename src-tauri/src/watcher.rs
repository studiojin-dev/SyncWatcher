//! 파일 시스템 감시 관리 모듈
//! 
//! 여러 Sync Task의 watcher를 관리하고, 변경 감지 시 자동 동기화를 트리거합니다.

use std::collections::HashMap;
use std::path::PathBuf;
use anyhow::Result;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher, EventKind};

/// 단일 Task의 Watcher 정보
pub struct TaskWatcher {
    pub task_id: String,
    pub source_path: PathBuf,
    _watcher: RecommendedWatcher,
}

/// 여러 Task의 Watcher를 관리하는 매니저
pub struct WatcherManager {
    watchers: HashMap<String, TaskWatcher>,
}

impl Default for WatcherManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WatcherManager {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
        }
    }

    /// 특정 Task에 대한 파일 시스템 감시를 시작합니다.
    pub fn start_watching<F>(
        &mut self,
        task_id: String,
        source_path: PathBuf,
        on_change: F,
    ) -> Result<()>
    where
        F: Fn(Event) + Send + 'static,
    {
        // 이미 감시 중이면 중지 후 재시작
        if self.watchers.contains_key(&task_id) {
            self.stop_watching(&task_id)?;
        }

        let mut watcher = notify::recommended_watcher(move |res: std::result::Result<Event, notify::Error>| {
            if let Ok(event) = res {
                // 실제 파일 변경 이벤트만 처리
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        on_change(event);
                    }
                    _ => {}
                }
            }
        })?;

        watcher.watch(&source_path, RecursiveMode::Recursive)?;

        self.watchers.insert(task_id.clone(), TaskWatcher {
            task_id,
            source_path,
            _watcher: watcher,
        });

        Ok(())
    }

    /// 특정 Task의 파일 시스템 감시를 중지합니다.
    pub fn stop_watching(&mut self, task_id: &str) -> Result<()> {
        self.watchers.remove(task_id);
        Ok(())
    }

    /// 감시 중인 Task 목록을 반환합니다.
    pub fn get_watching_tasks(&self) -> Vec<String> {
        self.watchers.keys().cloned().collect()
    }

    /// 특정 Task가 감시 중인지 확인합니다.
    pub fn is_watching(&self, task_id: &str) -> bool {
        self.watchers.contains_key(task_id)
    }

    /// 모든 감시를 중지합니다.
    pub fn stop_all(&mut self) {
        self.watchers.clear();
    }
}

/// 감시 이벤트 정보 (프론트엔드 전송용)
#[derive(Debug, Clone, serde::Serialize)]
pub struct WatchEvent {
    pub task_id: String,
    pub event_type: String,
    pub paths: Vec<String>,
}

impl WatchEvent {
    pub fn from_notify_event(task_id: String, event: &Event) -> Self {
        let event_type = match event.kind {
            EventKind::Create(_) => "create",
            EventKind::Modify(_) => "modify",
            EventKind::Remove(_) => "remove",
            _ => "other",
        };

        Self {
            task_id,
            event_type: event_type.to_string(),
            paths: event.paths.iter()
                .filter_map(|p| p.to_str().map(|s| s.to_string()))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn test_watcher_manager_creation() {
        let manager = WatcherManager::new();
        assert!(manager.get_watching_tasks().is_empty());
    }

    #[test]
    fn test_start_stop_watching() {
        let mut manager = WatcherManager::new();
        let temp = tempfile::tempdir().unwrap();
        
        let result = manager.start_watching(
            "test-task".to_string(),
            temp.path().to_path_buf(),
            |_| {},
        );
        
        assert!(result.is_ok());
        assert!(manager.is_watching("test-task"));
        
        let result = manager.stop_watching("test-task");
        assert!(result.is_ok());
        assert!(!manager.is_watching("test-task"));
    }
}
