use anyhow::Result;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;

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

    fn is_removable_volume(path: &PathBuf) -> bool {
        let volume_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        let non_removable = [
            "Macintosh HD",
            "Preboot",
            "Recovery",
            "Data",
            "System",
            "VM",
        ];

        !non_removable.contains(&volume_name)
    }
}

fn get_disk_space(path: &PathBuf) -> Result<u64> {
    let stat = nix::sys::statvfs::statvfs(path.as_path())?;
    Ok(stat.blocks() as u64 * stat.block_size() as u64)
}

fn get_available_space(path: &PathBuf) -> Result<u64> {
    let stat = nix::sys::statvfs::statvfs(path.as_path())?;
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
