//! 파일 시스템 감시 관리 모듈
//!
//! 여러 Sync Task의 watcher를 관리하고, 변경 감지 시 자동 동기화를 트리거합니다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::thread;
use anyhow::Result;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher, EventKind};
use tokio_util::sync::CancellationToken;

/// 단일 Task의 Watcher 정보
pub struct TaskWatcher {
    pub task_id: String,
    pub source_path: PathBuf,
    _watcher: RecommendedWatcher,
    cancellation_token: CancellationToken,
    _debounce_thread_handle: Option<thread::JoinHandle<()>>,
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

        let cancellation_token = CancellationToken::new();
        let token_clone = cancellation_token.clone();

        // Use bounded channel (100 message buffer) to prevent memory exhaustion
        let (tx, rx) = std::sync::mpsc::sync_channel(100);
        let tx = std::sync::Arc::new(std::sync::Mutex::new(tx));

        let mut watcher = notify::recommended_watcher(move |res: std::result::Result<Event, notify::Error>| {
            if let Ok(event) = res {
                // 실제 파일 변경 이벤트만 처리
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        // Use try_send for backpressure handling
                        if let Ok(tx) = tx.lock() {
                            if let Err(_) = tx.try_send(event) {
                                // Channel full - log and skip (backpressure)
                                // In production, you might want to log this
                            }
                        }
                    }
                    _ => {}
                }
            }
        })?;

        watcher.watch(&source_path, RecursiveMode::Recursive)?;

        // 디바운싱 처리를 위한 스레드 생성 (with cancellation support)
        let thread_handle = std::thread::spawn(move || {
            use std::time::Duration;

            let debounce_time = Duration::from_millis(500);
            let mut paths = std::collections::HashSet::new();
            loop {
                // Check for cancellation
                if token_clone.is_cancelled() {
                    break;
                }

                // 첫 이벤트 대기
                let first_event = match rx.recv_timeout(debounce_time) {
                    Ok(e) => e,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue, // No events, check cancellation again
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break, // 채널 닫힘
                };

                // 첫 이벤트 처리
                for path in first_event.paths {
                    paths.insert(path);
                }
                let mut kind = first_event.kind;

                // 디바운싱 루프: 추가 이벤트 수집
                loop {
                    // Check for cancellation between events
                    if token_clone.is_cancelled() {
                        return;
                    }

                    match rx.recv_timeout(debounce_time) {
                        Ok(event) => {
                            for path in event.paths {
                                paths.insert(path);
                            }
                            // 이벤트 종류 업데이트 (단순화: 마지막 이벤트 기준)
                            // 실제로는 Create/Remove 등이 섞일 수 있으나,
                            // 동기화 트리거 목적상 '변경됨' 사실이 중요함.
                            kind = event.kind;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            // 타임아웃: 수집된 이벤트 처리 및 루프 종료
                            if !paths.is_empty() {
                                let collected_paths: Vec<PathBuf> = paths.drain().collect();
                                let synthetic_event = Event {
                                    kind: kind.clone(), // 마지막 이벤트 종류 사용
                                    paths: collected_paths,
                                    attrs: Default::default(),
                                };
                                on_change(synthetic_event);
                            }
                            break; // 안쪽 루프 탈출, 다시 첫 이벤트 대기
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return, // 스레드 종료
                    }
                }
            }
        });

        self.watchers.insert(task_id.clone(), TaskWatcher {
            task_id,
            source_path,
            _watcher: watcher,
            cancellation_token,
            _debounce_thread_handle: Some(thread_handle),
        });

        Ok(())
    }

    /// 특정 Task의 파일 시스템 감시를 중지합니다.
    pub fn stop_watching(&mut self, task_id: &str) -> Result<()> {
        if let Some(mut watcher) = self.watchers.remove(task_id) {
            // Cancel the debouncing thread
            watcher.cancellation_token.cancel();

            // Wait for thread to finish (non-blocking, thread will exit on its own)
            // The cancellation token ensures the thread will exit quickly
            let _ = watcher._debounce_thread_handle.take();
        }
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

impl Drop for TaskWatcher {
    fn drop(&mut self) {
        // Cancel the debouncing thread when watcher is dropped
        self.cancellation_token.cancel();
        // Don't wait in Drop (can deadlock), just cancel
        // Thread will exit on its own
    }
}

impl Drop for WatcherManager {
    fn drop(&mut self) {
        // Stop all watchers when manager is dropped
        self.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn test_watcher_debouncing() {
        // 임시 디렉토리 생성
        let dir = tempdir().unwrap();
        let dir_path = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel();

        let mut manager = WatcherManager::new();
        let task_id = "test_debounce".to_string();

        // 감시 시작
        manager.start_watching(task_id.clone(), dir_path.clone(), move |event| {
            tx.send(event).unwrap();
        }).unwrap();

        // 파일 5개를 100ms 간격으로 생성 (총 500ms 미만 간격이므로 하나로 묶여야 함)
        // Debounce 설정이 500ms이므로, 100ms 간격이면 계속 타임아웃이 연장됨.
        for i in 0..5 {
            let file_path = dir_path.join(format!("file_{}.txt", i));
            fs::write(file_path, "content").unwrap();
            std::thread::sleep(Duration::from_millis(50)); 
        }

        // Debounce 시간(500ms) + 여유 시간 대기 후 이벤트 수신 확인
        // 첫 번째 이벤트 수신
        let event = rx.recv_timeout(Duration::from_secs(2)).expect("Should receive debounced event");
        
        println!("Received event with {} paths", event.paths.len());

        // 추가 이벤트가 없어야 함 (하나로 묶였으므로)
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "Should not receive more events");

        // 생성된 파일들이 경로에 포함되어 있는지 확인
        assert!(!event.paths.is_empty());
        
        manager.stop_watching(&task_id).unwrap();
    }

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


