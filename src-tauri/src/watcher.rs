//! 파일 시스템 감시 관리 모듈
//!
//! 여러 Sync Task의 watcher를 관리하고, 변경 감지 시 자동 동기화를 트리거합니다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;
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
                    EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
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
            run_debounce_loop(rx, Duration::from_millis(500), token_clone, on_change);
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

fn run_debounce_loop<F>(
    rx: std::sync::mpsc::Receiver<Event>,
    debounce_time: Duration,
    cancellation_token: CancellationToken,
    on_change: F,
) where
    F: Fn(Event),
{
    let mut paths = std::collections::HashSet::new();

    loop {
        // Check for cancellation
        if cancellation_token.is_cancelled() {
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
            if cancellation_token.is_cancelled() {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn test_watcher_debouncing() {
        let (input_tx, input_rx) = mpsc::channel();
        let (output_tx, output_rx) = mpsc::channel();
        let cancellation_token = CancellationToken::new();
        let token_clone = cancellation_token.clone();

        let handle = std::thread::spawn(move || {
            run_debounce_loop(
                input_rx,
                Duration::from_millis(100),
                token_clone,
                move |event| {
                    output_tx.send(event).unwrap();
                },
            );
        });

        for i in 0..5 {
            let event = Event {
                kind: EventKind::Modify(notify::event::ModifyKind::Any),
                paths: vec![PathBuf::from(format!("/tmp/debounce_{i}.txt"))],
                attrs: Default::default(),
            };
            input_tx.send(event).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }

        let event = output_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("Should receive debounced event");

        assert_eq!(event.paths.len(), 5);
        assert!(
            output_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "Should not receive more events"
        );

        cancellation_token.cancel();
        drop(input_tx);
        handle.join().unwrap();
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
