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

                            volumes.push(VolumeInfo {
                                name,
                                path: path.clone(),
                                mount_point: path,
                                total_bytes: total,
                                available_bytes: available,
                                is_removable,
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
        use std::process::Command;
        use std::thread;
        use std::time::Duration;

        let max_retries = 3;
        let mut last_error = String::new();

        for attempt in 1..=max_retries {
            let output = Command::new("diskutil")
                .args(["unmount", path.to_str().unwrap_or("")])
                .output()
                .map_err(|e| anyhow::anyhow!("diskutil 실행 실패: {}", e))?;

            if output.status.success() {
                return Ok(());
            }

            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            last_error = stderr;
            
            if attempt < max_retries {
                thread::sleep(Duration::from_secs(1));
            }
        }

        Err(anyhow::anyhow!("Unmount 실패 ({}회 시도): {}", max_retries, last_error))
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
