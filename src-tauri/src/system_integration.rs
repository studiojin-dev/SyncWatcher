use anyhow::Result;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};

pub struct FolderWatcher {
    _watcher: RecommendedWatcher,
}

impl FolderWatcher {
    pub fn new(path: PathBuf, callback: impl Fn(Event) + Send + 'static) -> Result<Self> {
        let mut watcher = notify::recommended_watcher(move |res| {
            if let Ok(event) = res {
                callback(event);
            }
        })?;

        watcher.watch(&path, RecursiveMode::Recursive)?;

        Ok(Self { _watcher: watcher })
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VolumeInfo {
    pub name: String,
    pub path: PathBuf,
    pub mount_point: PathBuf,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub is_removable: bool,
    /// 파일시스템 UUID (포맷 시 변경될 수 있음)
    pub volume_uuid: Option<String>,
    /// 파티션 UUID (포맷 후에도 유지됨, SD 카드 식별에 권장)
    pub disk_uuid: Option<String>,
}

pub struct DiskMonitor;

impl Default for DiskMonitor {
    fn default() -> Self {
        Self
    }
}

impl DiskMonitor {
    pub fn new() -> Self {
        Self
    }

    /// 마운트 포인트로부터 Volume UUID와 Disk/Partition UUID를 획득합니다.
    /// `diskutil info <mount_point>` 명령을 파싱합니다.
    fn get_volume_uuid(mount_point: &Path) -> (Option<String>, Option<String>) {
        use std::process::Command;

        let output = Command::new("diskutil")
            .arg("info")
            .arg(mount_point)
            .output();

        let Ok(output) = output else {
            return (None, None);
        };

        if !output.status.success() {
            return (None, None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut volume_uuid = None;
        let mut disk_uuid = None;

        for line in stdout.lines() {
            let line = line.trim();
            if line.starts_with("Volume UUID:") {
                volume_uuid = line
                    .strip_prefix("Volume UUID:")
                    .map(|s| s.trim().to_string());
            } else if line.starts_with("Disk / Partition UUID:") {
                disk_uuid = line
                    .strip_prefix("Disk / Partition UUID:")
                    .map(|s| s.trim().to_string());
            }
        }

        (volume_uuid, disk_uuid)
    }

    pub fn list_volumes(&self) -> Result<Vec<VolumeInfo>> {
        let mut volumes = Vec::new();

        if let Ok(entries) = std::fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let path = entry.path();

                if let Ok(meta) = std::fs::metadata(&path) {
                    if meta.is_dir() {
                        let name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("Unknown")
                            .to_string();

                        if let (Ok(total), Ok(available)) =
                            (get_disk_space(&path), get_available_space(&path))
                        {
                            let is_removable = Self::is_removable_volume(&path);
                            let (volume_uuid, disk_uuid) = Self::get_volume_uuid(&path);

                            volumes.push(VolumeInfo {
                                name,
                                path: path.clone(),
                                mount_point: path,
                                total_bytes: total,
                                available_bytes: available,
                                is_removable,
                                volume_uuid,
                                disk_uuid,
                            });
                        }
                    }
                }
            }
        }

        Ok(volumes)
    }

    fn is_removable_volume(path: &Path) -> bool {
        let volume_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // Non-removable system volumes
        let non_removable = [
            "Macintosh HD",
            "Preboot",
            "Recovery",
            "Data",
            "System",
            "VM",
        ];

        // Check if it's a known system volume
        if non_removable.contains(&volume_name) {
            return false;
        }

        // Check if it's a Time Machine volume
        if Self::is_time_machine_volume(path) {
            return false;
        }

        // Check if it's a system path
        if Self::is_system_volume(path) {
            return false;
        }

        true
    }

    fn is_time_machine_volume(path: &Path) -> bool {
        // Check for .timemachine file
        if path.join(".timemachine").exists() {
            return true;
        }

        // Check for com.apple.TimeMachine.MachineID.plist
        if path.join(".com.apple.TimeMachine.MachineID.plist").exists() {
            return true;
        }

        // Check volume name patterns
        let volume_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();

        volume_name.contains("time machine") 
            || volume_name.contains("timemachine")
            || volume_name.contains("backup")
    }

    fn is_system_volume(path: &Path) -> bool {
        // Check if mounted under /System/Volumes
        if let Some(path_str) = path.to_str() {
            if path_str.starts_with("/System/Volumes/") {
                return true;
            }
        }

        false
    }

    /// Get only removable volumes (USB, SD cards, external drives)
    /// Filters out Time Machine and system volumes
    pub fn get_removable_volumes(&self) -> Result<Vec<VolumeInfo>> {
        let all_volumes = self.list_volumes()?;
        Ok(all_volumes
            .into_iter()
            .filter(|v| v.is_removable)
            .collect())
    }

    /// Removable 디스크를 언마운트합니다.
    /// macOS의 diskutil 명령을 사용합니다.
    pub fn unmount_volume(path: &Path) -> Result<()> {
        use crate::path_validation::{validate_path, verify_path_exists};
        use std::process::Command;
        use std::thread;
        use std::time::Duration;

        // 1. Convert to string, reject if invalid UTF-8 or contains null
        let path_str = path.to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid path: contains non-UTF-8 characters"))?;

        // 2. Use existing validation module
        validate_path(path_str)
            .map_err(|e| anyhow::anyhow!("Path validation failed: {}", e))?;

        // 3. Verify path exists and is accessible
        verify_path_exists(path)
            .map_err(|e| anyhow::anyhow!("Path verification failed: {}", e))?;

        // 4. Additional validation: must be under /Volumes
        if !path_str.starts_with("/Volumes/") {
            return Err(anyhow::anyhow!(
                "Invalid volume path: must be under /Volumes, got: {}",
                path_str
            ));
        }

        // 5. Validate no shell metacharacters
        if path_str.contains('|') || path_str.contains('&') || path_str.contains(';')
            || path_str.contains('$') || path_str.contains('`') || path_str.contains('\n')
        {
            return Err(anyhow::anyhow!("Path contains shell metacharacters"));
        }

        let max_retries = 3;
        let mut last_error = String::new();

        for attempt in 1..=max_retries {
            // 6. Pass PathBuf directly, not string (safer)
            let output = Command::new("diskutil")
                .arg("unmount")
                .arg(path)  // Pass PathBuf directly
                .output()
                .map_err(|e| anyhow::anyhow!("diskutil execution failed: {}", e))?;

            if output.status.success() {
                return Ok(());
            }

            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            // 7. Validate error message doesn't contain injection indicators
            if stderr.contains("shell") || stderr.contains("syntax error") {
                return Err(anyhow::anyhow!("Potential command injection detected"));
            }

            last_error = stderr;

            if attempt < max_retries {
                thread::sleep(Duration::from_secs(1));
            }
        }

        Err(anyhow::anyhow!("Unmount failed ({} attempts): {}", max_retries, last_error))
    }
}

fn get_disk_space(path: &Path) -> Result<u64> {
    let stat = nix::sys::statvfs::statvfs(path)?;
    Ok(stat.blocks() as u64 * stat.block_size() as u64)
}

fn get_available_space(path: &Path) -> Result<u64> {
    let stat = nix::sys::statvfs::statvfs(path)?;
    Ok(stat.blocks_available() as u64 * stat.block_size() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_volumes() {
        let monitor = DiskMonitor::new();
        let volumes = monitor.list_volumes();
        assert!(volumes.is_ok());
    }

    #[test]
    fn test_folder_watcher_creation() {
        let temp = tempfile::tempdir().unwrap();
        let _watcher = FolderWatcher::new(temp.path().to_path_buf(), |_| {});
    }
}
