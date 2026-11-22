//! 작업별 복사 기록 (ADR-0040).
//!
//! "이미 복사한 사진·영상은 다시 복사하지 않기" 옵션이 켜진 작업은 복사에 성공했거나
//! 타깃과 이미 같았던 카메라 미디어 파일의 식별 키를 기록한다. 다음 실행에서 타깃에
//! 없는 파일이라도 같은 키가 기록돼 있으면 복사하지 않는다.
//!
//! 식별 키는 `파일 이름 + 크기 + 촬영 시각`이다. 촬영 시각은 EXIF/영상 헤더에서 읽고,
//! 읽을 수 없으면 수정 시각(유닉스 초)으로 대신한다. 두 값 모두 시스템 시간대와
//! 저장 규칙 설정에 영향을 받지 않게 만든다.

use crate::input_validation;
use crate::save_rules::classify::classify;
use crate::save_rules::metadata::read_embedded_captured_at;
use crate::save_rules::MediaCategory;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

pub const COPY_HISTORY_DIR_NAME: &str = "copy-history";
const COPY_HISTORY_FILE_VERSION: u32 = 1;

/// 복사 기록 하나를 식별하는 키.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyHistoryKey {
    /// 파일 이름 (폴더 제외, 대소문자 그대로)
    pub name: String,
    pub size: u64,
    /// `exif:2026-10-22T14:03:55` 또는 `mtime:1761109435`
    pub captured: String,
}

/// 복사 기록 대상 파일인지: 사진, RAW, 영상, 프록시 영상.
pub fn is_eligible(relative_path: &Path) -> bool {
    matches!(
        classify(relative_path),
        MediaCategory::Image | MediaCategory::Raw | MediaCategory::Video | MediaCategory::Proxy
    )
}

pub fn file_name_of(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

/// 촬영 시각 표지. 파일을 읽으므로 블로킹 컨텍스트에서 부른다.
///
/// 파일 안의 값만 쓴다. 영상 헤더 값은 벽시계 시각 그대로 써서 Mac 시간대와 무관하고,
/// 옆 사이드카 XML이 있든 없든 같은 영상이면 같은 표지가 나온다.
/// 파일을 읽을 수 없으면 `None`이다. 읽기 오류를 "촬영 시각 없음"으로 보고 수정 시각 키로
/// 대신하면 다른 파일을 이미 복사한 것으로 볼 수 있으므로, 호출자는 이때 복사·미기록으로 처리한다.
pub fn capture_stamp(path: &Path, modified: SystemTime) -> Option<String> {
    if let Some(captured_at) = read_embedded_captured_at(path) {
        return Some(format!("exif:{}", captured_at.format("%Y-%m-%dT%H:%M:%S")));
    }
    // 메타데이터가 없는 파일인지, 읽을 수 없는 파일인지 가른다.
    let mut probe = [0u8; 1];
    let read = fs::File::open(path).ok()?.read(&mut probe).ok()?;
    debug_assert!(read <= probe.len());
    let seconds = modified
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_else(|error| -(error.duration().as_secs() as i64));
    Some(format!("mtime:{seconds}"))
}

/// 타깃 폴더의 실체 식별자 (inode + 생성 시각). 같은 경로에 다른 디스크가 연결되거나
/// 폴더를 지우고 다시 만들면 달라진다. 폴더가 없으면 `None`.
pub fn target_identity(target: &Path) -> Option<String> {
    let meta = fs::metadata(target).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let created = meta.created().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(format!(
        "{}:{}.{:09}",
        meta.ino(),
        created.as_secs(),
        created.subsec_nanos()
    ))
}

/// 파일 하나의 키를 만든다. 파일을 읽으므로 블로킹 컨텍스트에서 부른다.
pub fn key_for_file(
    absolute_path: &Path,
    relative_path: &Path,
    size: u64,
    modified: SystemTime,
) -> Option<CopyHistoryKey> {
    Some(CopyHistoryKey {
        name: file_name_of(relative_path)?,
        size,
        captured: capture_stamp(absolute_path, modified)?,
    })
}

#[derive(Default)]
struct LedgerInner {
    /// 이 기록이 속한 타깃 (작업에 설정된 경로 그대로).
    target: String,
    /// 실제로 복사하는 타깃 폴더 (자동 마운트로 설정 경로와 다를 수 있다).
    target_dir: PathBuf,
    /// 기록을 읽을 때 타깃 폴더의 식별자. 폴더가 없었으면 `None`.
    target_identity: Option<String>,
    /// 닫힌 기록에는 더 이상 더하지 않는다 (취소·종료 뒤 저장과 어긋나지 않게).
    closed: bool,
    /// 저장소에서 읽을 때의 작업 기록 세대. 그 뒤 기록이 지워졌으면 저장하지 않는다.
    store_generation: Option<u64>,
    /// (이름, 크기) → 촬영 시각 표지들. 이름·크기가 맞을 때만 파일을 읽게 한다.
    by_name_size: HashMap<(String, u64), HashSet<String>>,
    len: usize,
    dirty: bool,
}

/// 한 작업의 복사 기록. 엔진과 호출자가 함께 쓰므로 내부에서 잠근다.
#[derive(Default)]
pub struct CopyHistoryLedger {
    inner: StdMutex<LedgerInner>,
}

impl std::fmt::Debug for CopyHistoryLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CopyHistoryLedger")
            .field("len", &self.len())
            .finish()
    }
}

impl CopyHistoryLedger {
    pub fn from_keys(keys: impl IntoIterator<Item = CopyHistoryKey>) -> Self {
        Self::for_target(String::new(), keys)
    }

    /// 타깃에 묶인 기록. 저장할 때 이 타깃이 함께 기록된다.
    pub fn for_target(target: String, keys: impl IntoIterator<Item = CopyHistoryKey>) -> Self {
        let target_dir = PathBuf::from(&target);
        Self::for_target_dir(target, target_dir, keys)
    }

    fn for_target_dir(
        target: String,
        target_dir: PathBuf,
        keys: impl IntoIterator<Item = CopyHistoryKey>,
    ) -> Self {
        let ledger = Self::default();
        {
            let mut inner = ledger.lock();
            inner.target_identity = target_identity(&target_dir);
            inner.target = target;
            inner.target_dir = target_dir;
            for key in keys {
                Self::insert_locked(&mut inner, key);
            }
            inner.dirty = false;
        }
        ledger
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LedgerInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn insert_locked(inner: &mut LedgerInner, key: CopyHistoryKey) -> bool {
        let inserted = inner
            .by_name_size
            .entry((key.name, key.size))
            .or_default()
            .insert(key.captured);
        if inserted {
            inner.len += 1;
            inner.dirty = true;
        }
        inserted
    }

    pub fn len(&self) -> usize {
        self.lock().len
    }

    pub fn target(&self) -> String {
        self.lock().target.clone()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn is_dirty(&self) -> bool {
        self.lock().dirty
    }

    /// 이름과 크기가 같은 기록이 있는지. 촬영 시각을 읽기 전 빠른 거르기에 쓴다.
    pub fn contains_name_size(&self, name: &str, size: u64) -> bool {
        self.lock()
            .by_name_size
            .contains_key(&(name.to_string(), size))
    }

    pub fn contains(&self, key: &CopyHistoryKey) -> bool {
        self.lock()
            .by_name_size
            .get(&(key.name.clone(), key.size))
            .is_some_and(|stamps| stamps.contains(&key.captured))
    }

    pub fn insert(&self, key: CopyHistoryKey) -> bool {
        let mut inner = self.lock();
        if inner.closed {
            return false;
        }
        // 타깃이 없는 기록(메모리 전용)은 폴더에 묶지 않는다. 저장할 수도 없다.
        let bound = !inner.target_dir.as_os_str().is_empty();
        if bound && inner.target_identity.is_none() {
            // 실행을 시작할 때 타깃 폴더가 없었다. 첫 기록(첫 복사 직후)에 폴더를 확정해,
            // 그 뒤 폴더가 바뀌면 저장하지 않게 한다.
            let identity = target_identity(&inner.target_dir);
            if identity.is_none() {
                return false;
            }
            inner.target_identity = identity;
        } else if bound && target_identity(&inner.target_dir) != inner.target_identity {
            // 실행 도중 같은 경로에 다른 폴더(디스크)가 연결돼 있다. 그 폴더에 쓴 파일을
            // 이 기록에 넣지 않는다.
            return false;
        }
        Self::insert_locked(&mut inner, key)
    }

    /// 지금 타깃 폴더가 기록을 읽었을 때(또는 처음 기록했을 때)와 같은 폴더인지.
    /// 기록이 비어 있으면 건너뛸 파일도 없으므로 같다고 본다.
    pub fn target_unchanged(&self) -> bool {
        let (target_dir, loaded) = {
            let inner = self.lock();
            if inner.len == 0 || inner.target_dir.as_os_str().is_empty() {
                return true;
            }
            (inner.target_dir.clone(), inner.target_identity.clone())
        };
        loaded.is_some() && target_identity(&target_dir) == loaded
    }

    /// 기록 내용과 타깃 폴더를 함께 나타내는 값. 캐시된 계획이 같은 기록으로 만들어졌는지 본다.
    pub fn fingerprint(&self) -> String {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let (target, identity) = {
            let inner = self.lock();
            (inner.target.clone(), inner.target_identity.clone())
        };
        let mut hasher = DefaultHasher::new();
        for key in self.keys() {
            (&key.name, key.size, &key.captured).hash(&mut hasher);
        }
        format!(
            "{target}|{}|{}|{:016x}",
            identity.unwrap_or_default(),
            self.len(),
            hasher.finish()
        )
    }

    /// 아직 확정하지 않은 타깃 폴더 식별자를 지금 확정한다. 첫 파일을 쓰기 직전에 부른다.
    pub fn pin_target_identity(&self) {
        let mut inner = self.lock();
        if !inner.target_dir.as_os_str().is_empty() && inner.target_identity.is_none() {
            inner.target_identity = target_identity(&inner.target_dir);
        }
    }

    /// 실행이 끝났거나 취소됐다. 이후 기록 작업은 멈추고 아무것도 더하지 않는다.
    pub fn close(&self) {
        self.lock().closed = true;
    }

    pub fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// 저장용 정렬된 키 목록.
    pub fn keys(&self) -> Vec<CopyHistoryKey> {
        let inner = self.lock();
        let mut keys: Vec<CopyHistoryKey> = inner
            .by_name_size
            .iter()
            .flat_map(|((name, size), stamps)| {
                stamps.iter().map(move |captured| CopyHistoryKey {
                    name: name.clone(),
                    size: *size,
                    captured: captured.clone(),
                })
            })
            .collect();
        keys.sort_by(|a, b| {
            (&a.name, a.size, &a.captured).cmp(&(&b.name, b.size, &b.captured))
        });
        keys
    }

    fn mark_clean(&self) {
        self.lock().dirty = false;
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyHistoryFile {
    version: u32,
    /// 기록을 만든 타깃. 작업의 타깃과 다르면 기록을 쓰지 않는다.
    #[serde(default)]
    target: String,
    /// 저장할 때 타깃 폴더의 실체 식별자. 지금 폴더와 다르면 기록을 쓰지 않는다.
    #[serde(default)]
    target_identity: Option<String>,
    #[serde(default)]
    entries: Vec<CopyHistoryKey>,
}

/// 작업별 복사 기록 파일 저장소: `<app support>/copy-history/<task id>.json`.
#[derive(Debug)]
pub struct CopyHistoryStore {
    root_dir: PathBuf,
    /// 저장(작업 존재 확인 포함)과 삭제를 직렬화한다.
    write_lock: StdMutex<()>,
    /// 작업별 기록 세대. `clear`마다 늘어, 그 전에 읽은 기록이 지운 기록을 되살리지 못하게 한다.
    generations: StdMutex<HashMap<String, u64>>,
}

impl CopyHistoryStore {
    pub fn new(app_support_dir: PathBuf) -> Self {
        Self {
            root_dir: app_support_dir.join(COPY_HISTORY_DIR_NAME),
            write_lock: StdMutex::new(()),
            generations: StdMutex::new(HashMap::new()),
        }
    }

    fn generation(&self, task_id: &str) -> u64 {
        self.generations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(task_id)
            .copied()
            .unwrap_or(0)
    }

    fn lock_writes(&self) -> std::sync::MutexGuard<'_, ()> {
        self.write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `still_wanted`가 참일 때만 저장한다. 확인과 저장을 `clear`와 같은 잠금 안에서 해서,
    /// 작업을 지운 뒤(작업 목록에서 빠진 뒤 `clear`) 끝난 실행이 기록을 다시 만들지 않게 한다.
    pub fn save_if_dirty_when(
        &self,
        task_id: &str,
        ledger: &CopyHistoryLedger,
        still_wanted: impl FnOnce() -> Result<bool, String>,
    ) -> Result<bool, String> {
        let _guard = self.lock_writes();
        if !still_wanted()? {
            return Ok(false);
        }
        self.save_if_dirty_locked(task_id, ledger)
    }

    pub fn file_path(&self, task_id: &str) -> Result<PathBuf, String> {
        input_validation::validate_task_id(task_id).map_err(|error| error.to_string())?;
        Ok(self.root_dir.join(format!("{task_id}.json")))
    }

    /// `target`(작업에 설정된 경로)에 복사한 기록을 읽는다. `target_dir`은 이번 실행이 실제로
    /// 복사하는 폴더다. 파일이 없거나, 다른 타깃 경로의 기록이거나, 같은 경로라도 지금 연결된
    /// 폴더(디스크)가 기록을 저장할 때와 다르면 빈 기록.
    /// 읽거나 해석할 수 없으면 오류 (호출자는 이때 옵션 없이 실행해, 의심스러울 때 건너뛰지 않는다).
    pub fn load(
        &self,
        task_id: &str,
        target: &str,
        target_dir: &Path,
    ) -> Result<CopyHistoryLedger, String> {
        let path = self.file_path(task_id)?;
        // 파일을 읽기 전에 세대를 잡는다. 읽는 도중 지워져도 저장 때 알아챈다.
        let generation = self.generation(task_id);
        let ledger = Self::load_unversioned(&path, target, target_dir)?;
        ledger.lock().store_generation = Some(generation);
        Ok(ledger)
    }

    fn load_unversioned(
        path: &Path,
        target: &str,
        target_dir: &Path,
    ) -> Result<CopyHistoryLedger, String> {
        if target_dir.is_dir() && target_identity(target_dir).is_none() {
            // 폴더 생성 시각을 알려 주지 않는 파일 시스템. 같은 폴더인지 확인할 수 없으므로
            // 이번 실행은 기록 없이 진행한다 (호출자가 경고를 남긴다).
            return Err(
                "Target folder cannot be identified (no creation time); copy history disabled"
                    .to_string(),
            );
        }
        let empty =
            || CopyHistoryLedger::for_target_dir(target.to_string(), target_dir.to_path_buf(), []);
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
            Err(error) => return Err(format!("Failed to read copy history: {error}")),
        };
        if raw.trim().is_empty() {
            return Ok(empty());
        }
        let file: CopyHistoryFile = serde_json::from_str(&raw)
            .map_err(|error| format!("Failed to parse copy history: {error}"))?;
        if file.version != COPY_HISTORY_FILE_VERSION {
            return Err(format!(
                "Unsupported copy history version: {}",
                file.version
            ));
        }
        if file.target != target {
            // 타깃이 바뀐 뒤 남은 기록이다. 새 타깃에는 아무것도 복사한 적이 없다.
            return Ok(empty());
        }
        let ledger = CopyHistoryLedger::for_target_dir(
            file.target,
            target_dir.to_path_buf(),
            file.entries,
        );
        let loaded_identity = ledger.lock().target_identity.clone();
        if file.target_identity.is_none() || file.target_identity != loaded_identity {
            // 같은 경로에 다른 디스크가 연결됐거나 타깃 폴더가 새로 만들어졌다.
            return Ok(empty());
        }
        Ok(ledger)
    }

    /// 바뀐 기록만 원자적으로 저장한다.
    pub fn save_if_dirty(&self, task_id: &str, ledger: &CopyHistoryLedger) -> Result<bool, String> {
        let _guard = self.lock_writes();
        self.save_if_dirty_locked(task_id, ledger)
    }

    fn save_if_dirty_locked(
        &self,
        task_id: &str,
        ledger: &CopyHistoryLedger,
    ) -> Result<bool, String> {
        if !ledger.is_dirty() {
            return Ok(false);
        }
        let path = self.file_path(task_id)?;
        let (target, target_dir, loaded_identity, store_generation) = {
            let inner = ledger.lock();
            (
                inner.target.clone(),
                inner.target_dir.clone(),
                inner.target_identity.clone(),
                inner.store_generation,
            )
        };
        if store_generation.is_some_and(|generation| generation != self.generation(task_id)) {
            // 실행 중에 기록이 지워졌다 (타깃 변경 등). 지운 기록을 되살리지 않는다.
            return Err("Copy history was reset during the run; copy history not saved".to_string());
        }
        let Some(identity) = target_identity(&target_dir) else {
            return Err("Target folder is not available; copy history not saved".to_string());
        };
        if loaded_identity.as_ref() != Some(&identity) {
            // 실행 도중 같은 경로의 폴더(디스크)가 바뀌었다. 이전 폴더에 복사한 기록을
            // 새 폴더에 붙이지 않는다.
            return Err("Target folder changed during the run; copy history not saved".to_string());
        }
        let file = CopyHistoryFile {
            version: COPY_HISTORY_FILE_VERSION,
            target_identity: Some(identity),
            target,
            entries: ledger.keys(),
        };
        let bytes = serde_json::to_vec(&file)
            .map_err(|error| format!("Failed to serialize copy history: {error}"))?;
        let Some(parent) = path.parent() else {
            return Err("Copy history path has no parent".to_string());
        };
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to prepare copy history dir: {error}"))?;
        let mut temp = NamedTempFile::new_in(parent)
            .map_err(|error| format!("Failed to create temp copy history file: {error}"))?;
        temp.write_all(&bytes)
            .map_err(|error| format!("Failed to write temp copy history file: {error}"))?;
        temp.flush()
            .map_err(|error| format!("Failed to flush temp copy history file: {error}"))?;
        temp.persist(&path).map_err(|error| {
            format!("Failed to persist copy history file: {}", error.error)
        })?;
        ledger.mark_clean();
        Ok(true)
    }

    pub fn clear(&self, task_id: &str) -> Result<(), String> {
        let path = self.file_path(task_id)?;
        let _guard = self.lock_writes();
        *self
            .generations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(task_id.to_string())
            .or_insert(0) += 1;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to clear copy history: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_rules::exif::test_support::TiffBuilder;
    use std::time::Duration;

    fn key(name: &str, size: u64, captured: &str) -> CopyHistoryKey {
        CopyHistoryKey {
            name: name.to_string(),
            size,
            captured: captured.to_string(),
        }
    }

    #[test]
    fn eligibility_covers_photo_raw_video_and_proxy_only() {
        assert!(is_eligible(Path::new("DCIM/100MSDCF/DSC00001.JPG")));
        assert!(is_eligible(Path::new("DCIM/100MSDCF/DSC00001.ARW")));
        assert!(is_eligible(Path::new("PRIVATE/M4ROOT/CLIP/C0001.MP4")));
        assert!(is_eligible(Path::new("PRIVATE/M4ROOT/SUB/C0001S03.MP4")));
        assert!(!is_eligible(Path::new("PRIVATE/M4ROOT/CLIP/C0001M01.XML")));
        assert!(!is_eligible(Path::new("notes.txt")));
    }

    #[test]
    fn capture_stamp_prefers_exif_and_falls_back_to_mtime_seconds() {
        let dir = tempfile::TempDir::new().unwrap();
        let raw = dir.path().join("DSC00001.ARW");
        fs::write(
            &raw,
            TiffBuilder {
                little_endian: true,
                date_time_original: Some("2026:10:22 14:03:55".to_string()),
                ..TiffBuilder::default()
            }
            .build(),
        )
        .unwrap();
        let modified = UNIX_EPOCH + Duration::from_secs(1_761_109_435);
        assert_eq!(
            capture_stamp(&raw, modified).as_deref(),
            Some("exif:2026-10-22T14:03:55")
        );

        let plain = dir.path().join("IMG.CR3");
        fs::write(&plain, b"no exif here").unwrap();
        assert_eq!(
            capture_stamp(&plain, modified).as_deref(),
            Some("mtime:1761109435")
        );
        // 읽을 수 없는 파일은 수정 시각 키로 대신하지 않는다.
        assert_eq!(capture_stamp(&dir.path().join("MISSING.CR3"), modified), None);
    }

    #[test]
    fn video_capture_stamp_uses_header_time_without_local_timezone() {
        let dir = tempfile::TempDir::new().unwrap();
        let clip = dir.path().join("C0001.MP4");
        // 2026-10-22 14:03:55 UTC, Mac 기준(1904-01-01) 초.
        let mac_epoch_offset = 2_082_844_800u64;
        let unix_seconds = 1_792_677_835u64;
        fs::write(
            &clip,
            crate::save_rules::isobmff::test_support::build_mp4(
                unix_seconds + mac_epoch_offset,
                false,
                false,
            ),
        )
        .unwrap();
        let unrelated_mtime = UNIX_EPOCH + Duration::from_secs(1);
        assert_eq!(
            capture_stamp(&clip, unrelated_mtime).as_deref(),
            Some("exif:2026-10-22T14:03:55")
        );
    }

    #[test]
    fn ledger_matches_on_name_size_and_capture() {
        let ledger = CopyHistoryLedger::from_keys([key("A.JPG", 10, "exif:1")]);
        assert!(!ledger.is_dirty());
        assert!(ledger.contains_name_size("A.JPG", 10));
        assert!(!ledger.contains_name_size("A.JPG", 11));
        assert!(ledger.contains(&key("A.JPG", 10, "exif:1")));
        assert!(!ledger.contains(&key("A.JPG", 10, "exif:2")));
        assert!(ledger.insert(key("A.JPG", 10, "exif:2")));
        assert!(!ledger.insert(key("A.JPG", 10, "exif:2")));
        assert!(ledger.is_dirty());
        assert_eq!(ledger.len(), 2);
    }

    /// 앱 지원 폴더와 타깃 폴더 A, B를 만든다.
    fn store_with_targets() -> (tempfile::TempDir, CopyHistoryStore, String, String) {
        let dir = tempfile::TempDir::new().unwrap();
        let store = CopyHistoryStore::new(dir.path().join("support"));
        let a = dir.path().join("A");
        let b = dir.path().join("B");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let a = a.to_string_lossy().into_owned();
        let b = b.to_string_lossy().into_owned();
        (dir, store, a, b)
    }

    #[test]
    fn insert_refuses_files_written_while_another_folder_is_mounted() {
        let (_dir, store, a, _b) = store_with_targets();
        let ledger = store.load("task-1", &a, Path::new(&a)).unwrap();
        assert!(ledger.insert(key("DSC00001.ARW", 10, "exif:2026-10-22T14:03:55")));
        // 실행 도중 같은 경로에 다른 폴더가 연결됐다.
        fs::remove_dir_all(&a).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::create_dir_all(&a).unwrap();
        assert!(!ledger.insert(key("DSC00002.ARW", 20, "exif:2026-10-22T14:04:00")));
        assert_eq!(ledger.len(), 1);
    }

    #[test]
    fn run_loaded_before_clear_cannot_restore_cleared_history() {
        let (_dir, store, a, _b) = store_with_targets();
        let seed = store.load("task-1", &a, Path::new(&a)).unwrap();
        seed.insert(key("DSC00001.ARW", 10, "exif:2026-10-22T14:03:55"));
        store.save_if_dirty("task-1", &seed).unwrap();

        // 실행이 기록을 읽은 뒤 타깃이 A → B → A로 바뀌어 기록이 지워졌다.
        let running = store.load("task-1", &a, Path::new(&a)).unwrap();
        assert_eq!(running.len(), 1);
        store.clear("task-1").unwrap();
        running.insert(key("DSC00002.ARW", 20, "exif:2026-10-22T14:04:00"));

        assert!(store.save_if_dirty("task-1", &running).is_err());
        assert!(store.load("task-1", &a, Path::new(&a)).unwrap().is_empty());
    }

    #[test]
    fn store_round_trips_and_clears() {
        let (_dir, store, a, _b) = store_with_targets();
        let empty = store.load("task-1", &a, Path::new(&a)).unwrap();
        assert!(empty.is_empty());
        assert!(!store.save_if_dirty("task-1", &empty).unwrap());

        empty.insert(key("B.ARW", 20, "mtime:5"));
        assert!(store.save_if_dirty("task-1", &empty).unwrap());
        assert!(!empty.is_dirty());

        let loaded = store.load("task-1", &a, Path::new(&a)).unwrap();
        assert!(loaded.contains(&key("B.ARW", 20, "mtime:5")));

        store.clear("task-1").unwrap();
        assert!(store.load("task-1", &a, Path::new(&a)).unwrap().is_empty());
        store.clear("task-1").unwrap();
    }

    #[test]
    fn store_ignores_history_written_for_another_target() {
        let (_dir, store, a, b) = store_with_targets();
        // 타깃 A로 실행 중이던 동기화가 타깃을 B로 바꾼 뒤에 기록을 저장한 경우.
        let ledger_a = store.load("task-1", &a, Path::new(&a)).unwrap();
        ledger_a.insert(key("B.ARW", 20, "mtime:5"));
        store.save_if_dirty("task-1", &ledger_a).unwrap();

        let ledger_b = store.load("task-1", &b, Path::new(&b)).unwrap();
        assert!(ledger_b.is_empty());
        assert!(!ledger_b.contains(&key("B.ARW", 20, "mtime:5")));

        // B에 복사한 기록을 저장하면 A의 기록을 대신한다.
        ledger_b.insert(key("C.ARW", 30, "mtime:6"));
        store.save_if_dirty("task-1", &ledger_b).unwrap();
        assert!(store.load("task-1", &a, Path::new(&a)).unwrap().is_empty());
        let reloaded = store.load("task-1", &b, Path::new(&b)).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded.target(), b);
    }

    #[test]
    fn store_ignores_history_when_another_disk_is_at_the_same_path() {
        let (_dir, store, a, _b) = store_with_targets();
        let ledger = store.load("task-1", &a, Path::new(&a)).unwrap();
        ledger.insert(key("B.ARW", 20, "mtime:5"));
        store.save_if_dirty("task-1", &ledger).unwrap();
        assert_eq!(store.load("task-1", &a, Path::new(&a)).unwrap().len(), 1);

        // 같은 이름의 빈 디스크로 바꾼 것처럼, 같은 경로에 새 폴더가 생겼다.
        fs::remove_dir_all(&a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::create_dir_all(&a).unwrap();
        assert!(store.load("task-1", &a, Path::new(&a)).unwrap().is_empty());

        // 타깃 폴더가 없으면 기록도 없다.
        fs::remove_dir_all(&a).unwrap();
        assert!(store.load("task-1", &a, Path::new(&a)).unwrap().is_empty());
    }

    #[test]
    fn store_refuses_to_save_when_target_folder_changed_during_run() {
        let (_dir, store, a, _b) = store_with_targets();
        let ledger = store.load("task-1", &a, Path::new(&a)).unwrap();
        ledger.insert(key("B.ARW", 20, "mtime:5"));
        // 실행 도중 같은 경로에 다른 디스크가 연결됐다.
        fs::remove_dir_all(&a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::create_dir_all(&a).unwrap();
        assert!(store.save_if_dirty("task-1", &ledger).is_err());
        assert!(store.load("task-1", &a, Path::new(&a)).unwrap().is_empty());
    }

    #[test]
    fn store_reads_identity_from_the_mounted_folder() {
        let (dir, store, _a, b) = store_with_targets();
        // 설정 경로는 없고, 자동 마운트가 실제 폴더 B를 돌려준 경우.
        let configured = dir.path().join("Volumes/Archive").to_string_lossy().into_owned();
        let ledger = store.load("task-1", &configured, Path::new(&b)).unwrap();
        ledger.insert(key("B.ARW", 20, "mtime:5"));
        assert!(store.save_if_dirty("task-1", &ledger).unwrap());
        assert_eq!(
            store.load("task-1", &configured, Path::new(&b)).unwrap().len(),
            1
        );
    }

    #[test]
    fn identity_is_pinned_at_first_record_when_target_was_missing() {
        let (dir, store, _a, _b) = store_with_targets();
        let fresh = dir.path().join("Fresh");
        let fresh_str = fresh.to_string_lossy().into_owned();
        // 실행을 시작할 때는 타깃 폴더가 없었다.
        let ledger = store.load("task-1", &fresh_str, &fresh).unwrap();
        assert!(!ledger.insert(key("A.ARW", 1, "mtime:1")), "no folder, nothing copied");
        fs::create_dir_all(&fresh).unwrap();
        assert!(ledger.insert(key("A.ARW", 1, "mtime:1")));
        assert!(ledger.target_unchanged());

        // 첫 기록 뒤 같은 경로의 폴더가 바뀌었다.
        fs::remove_dir_all(&fresh).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::create_dir_all(&fresh).unwrap();
        assert!(!ledger.target_unchanged());
        assert!(store.save_if_dirty("task-1", &ledger).is_err());
    }

    #[test]
    fn identity_pinned_before_first_copy_rejects_a_later_swap() {
        let (dir, store, _a, _b) = store_with_targets();
        let fresh = dir.path().join("Fresh");
        let fresh_str = fresh.to_string_lossy().into_owned();
        let ledger = store.load("task-1", &fresh_str, &fresh).unwrap();
        // 실행이 타깃 폴더를 만든 직후, 첫 파일을 쓰기 전에 확정한다.
        fs::create_dir_all(&fresh).unwrap();
        ledger.pin_target_identity();
        // 첫 기록 전에 같은 경로의 폴더가 바뀌었다.
        fs::remove_dir_all(&fresh).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::create_dir_all(&fresh).unwrap();
        assert!(!ledger.insert(key("A.ARW", 1, "mtime:1")));
        assert!(ledger.is_empty());
    }

    #[test]
    fn save_when_skips_saving_for_a_deleted_task() {
        let (_dir, store, a, _b) = store_with_targets();
        let ledger = store.load("task-1", &a, Path::new(&a)).unwrap();
        ledger.insert(key("A.ARW", 1, "mtime:1"));
        assert!(!store.save_if_dirty_when("task-1", &ledger, || Ok(false)).unwrap());
        assert!(store
            .save_if_dirty_when("task-1", &ledger, || Err("tasks unreadable".to_string()))
            .is_err());
        assert!(store.load("task-1", &a, Path::new(&a)).unwrap().is_empty());
        assert!(store.save_if_dirty_when("task-1", &ledger, || Ok(true)).unwrap());
        assert_eq!(store.load("task-1", &a, Path::new(&a)).unwrap().len(), 1);
    }

    #[test]
    fn closed_ledger_accepts_no_more_keys() {
        let ledger = CopyHistoryLedger::default();
        assert!(ledger.insert(key("A.JPG", 1, "exif:1")));
        ledger.close();
        assert!(ledger.is_closed());
        assert!(!ledger.insert(key("B.JPG", 1, "exif:1")));
        assert_eq!(ledger.len(), 1);
    }

    #[test]
    fn video_capture_stamp_ignores_sidecar_xml() {
        let dir = tempfile::TempDir::new().unwrap();
        let clip = dir.path().join("C0001.MP4");
        let unix_seconds = 1_792_677_835u64;
        fs::write(
            &clip,
            crate::save_rules::isobmff::test_support::build_mp4(
                unix_seconds + 2_082_844_800,
                false,
                false,
            ),
        )
        .unwrap();
        let modified = UNIX_EPOCH + Duration::from_secs(1);
        let without_sidecar = capture_stamp(&clip, modified);
        fs::write(
            dir.path().join("C0001M01.XML"),
            r#"<NonRealTimeMeta><CreationDate value="2026-01-01T09:00:00+09:00"/></NonRealTimeMeta>"#,
        )
        .unwrap();
        assert_eq!(capture_stamp(&clip, modified), without_sidecar);
        assert_eq!(without_sidecar.as_deref(), Some("exif:2026-10-22T14:03:55"));
    }

    #[test]
    fn store_rejects_corrupt_file_and_bad_task_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = CopyHistoryStore::new(dir.path().to_path_buf());
        let path = store.file_path("task-1").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert!(store.load("task-1", "/tmp", Path::new("/tmp")).is_err());
        assert!(store.file_path("../escape").is_err());
    }
}
