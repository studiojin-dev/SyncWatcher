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
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub is_network: bool,
    pub is_removable: bool,
    /// 파일시스템 UUID (포맷 시 변경될 수 있음)
    pub volume_uuid: Option<String>,
    /// 파티션 UUID (포맷 후에도 유지됨, SD 카드 식별에 권장)
    pub disk_uuid: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct VolumeMetadata {
    volume_uuid: Option<String>,
    disk_uuid: Option<String>,
    internal: Option<bool>,
    ejectable: Option<bool>,
    removable_media: Option<bool>,
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

    /// 마운트 포인트 메타데이터를 획득합니다.
    /// `diskutil info -plist <mount_point>` 명령을 사용합니다.
    fn get_volume_metadata(mount_point: &Path) -> Option<VolumeMetadata> {
        use std::process::Command;

        let output = Command::new("diskutil")
            .arg("info")
            .arg("-plist")
            .arg(mount_point)
            .output();

        let Ok(output) = output else {
            return None;
        };

        if !output.status.success() {
            return None;
        }

        Self::parse_volume_metadata_from_plist(&output.stdout)
    }

    /// `diskutil info -plist` 출력(XML) 파싱 로직 (순수 함수)
    /// 테스트를 위해 분리됨
    fn parse_volume_metadata_from_plist(data: &[u8]) -> Option<VolumeMetadata> {
        let value = plist::from_bytes::<plist::Value>(data).ok()?;
        let dict = value.as_dictionary()?;
        Some(VolumeMetadata {
            volume_uuid: dict
                .get("VolumeUUID")
                .and_then(|v| v.as_string())
                .map(|s| s.to_string()),
            disk_uuid: dict
                .get("DiskPartitionUUID")
                .and_then(|v| v.as_string())
                .map(|s| s.to_string()),
            internal: parse_optional_bool(dict, "Internal"),
            ejectable: parse_optional_bool(dict, "Ejectable"),
            removable_media: parse_optional_bool(dict, "RemovableMedia"),
        })
    }

    /// 볼륨 목록을 조회합니다.
    ///
    /// macOS 마운트 테이블(getmntinfo_r_np)을 기준으로 사용자 노출 볼륨을 열거합니다.
    /// 네트워크 마운트는 목록에 포함하지만 용량은 계산하지 않습니다.
    pub fn list_volumes(&self) -> Result<Vec<VolumeInfo>> {
        let mount_entries = list_mount_entries()?;
        let mut volumes = Vec::new();

        for entry in mount_entries {
            if !is_user_visible_mount(&entry.mount_point, entry.flags) {
                continue;
            }

            let is_network = is_network_mount(entry.flags);
            // 로컬 볼륨에서만 diskutil 메타데이터를 조회한다.
            let metadata = if is_network {
                None
            } else {
                Self::get_volume_metadata(&entry.mount_point)
            };
            let is_removable = is_removable_mount(&entry, is_network, metadata.as_ref());
            let (volume_uuid, disk_uuid) = metadata
                .as_ref()
                .map(|m| (m.volume_uuid.clone(), m.disk_uuid.clone()))
                .unwrap_or((None, None));

            volumes.push(volume_info_from_mount(
                &entry,
                is_network,
                is_removable,
                volume_uuid,
                disk_uuid,
            ));
        }

        Ok(volumes)
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

        let removable_volumes = Self::new().get_removable_volumes()?;
        let removable_mount_root = find_matching_removable_mount_root(path, &removable_volumes)
            .ok_or_else(|| anyhow::anyhow!("Unmount denied: not a mounted removable volume"))?;

        let max_retries = 3;
        let mut last_error = String::new();

        for attempt in 1..=max_retries {
            // 6. Pass PathBuf directly, not string (safer)
            let output = Command::new("diskutil")
                .arg("unmount")
                .arg(&removable_mount_root)  // Always unmount by resolved removable root
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

#[derive(Debug, Clone)]
struct MountEntry {
    mount_point: PathBuf,
    mount_from: String,
    flags: u32,
    block_size: u64,
    blocks: u64,
    blocks_available: u64,
}

const ROOT_MOUNT: &str = "/";
const VOLUMES_ROOT: &str = "/Volumes/";

fn parse_optional_bool(dict: &plist::Dictionary, key: &str) -> Option<bool> {
    dict.get(key).and_then(|value| {
        if let Some(boolean) = value.as_boolean() {
            return Some(boolean);
        }

        value
            .as_string()
            .and_then(|s| match s.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "1" => Some(true),
                "false" | "no" | "0" => Some(false),
                _ => None,
            })
    })
}

fn c_char_buffer_to_string(buffer: &[nix::libc::c_char]) -> String {
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).to_string()
}

fn mount_name(path: &Path) -> String {
    if path == Path::new(ROOT_MOUNT) {
        return "Macintosh HD".to_string();
    }
    path.file_name()
        .and_then(|n| n.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Unknown")
        .to_string()
}

fn is_user_visible_mount(path: &Path, flags: u32) -> bool {
    if path == Path::new(ROOT_MOUNT) {
        return true;
    }

    let Some(path_str) = path.to_str() else {
        return false;
    };

    if !path_str.starts_with(VOLUMES_ROOT) {
        return false;
    }

    if flags & nix::libc::MNT_DONTBROWSE as u32 != 0 {
        return false;
    }

    let volume_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if volume_name.starts_with('.') {
        return false;
    }

    if volume_name == "com.apple.timemachine.localsnapshots" {
        return false;
    }

    if path_str.contains("/.timemachine/") || path_str.ends_with("/.timemachine") {
        return false;
    }

    true
}

fn is_network_mount(flags: u32) -> bool {
    flags & nix::libc::MNT_LOCAL as u32 == 0
}

fn is_removable_mount(
    entry: &MountEntry,
    is_network: bool,
    metadata: Option<&VolumeMetadata>,
) -> bool {
    if is_network {
        return false;
    }

    let Some(path_str) = entry.mount_point.to_str() else {
        return false;
    };

    if !path_str.starts_with(VOLUMES_ROOT) {
        return false;
    }

    if !entry.mount_from.starts_with("/dev/disk") {
        return false;
    }

    let Some(metadata) = metadata else {
        return false;
    };

    metadata.internal == Some(false)
        && (metadata.ejectable == Some(true) || metadata.removable_media == Some(true))
}

fn find_matching_removable_mount_root(path: &Path, removable_volumes: &[VolumeInfo]) -> Option<PathBuf> {
    removable_volumes
        .iter()
        .filter_map(|volume| {
            let mount_point = &volume.mount_point;
            if path == mount_point || path.starts_with(mount_point) {
                Some(mount_point.clone())
            } else {
                None
            }
        })
        .max_by_key(|mount_point| mount_point.components().count())
}

fn volume_info_from_mount(
    entry: &MountEntry,
    is_network: bool,
    is_removable: bool,
    volume_uuid: Option<String>,
    disk_uuid: Option<String>,
) -> VolumeInfo {
    let (total_bytes, available_bytes) = if is_network {
        (None, None)
    } else {
        (
            Some(entry.blocks.saturating_mul(entry.block_size)),
            Some(entry.blocks_available.saturating_mul(entry.block_size)),
        )
    };

    VolumeInfo {
        name: mount_name(&entry.mount_point),
        path: entry.mount_point.clone(),
        mount_point: entry.mount_point.clone(),
        total_bytes,
        available_bytes,
        is_network,
        is_removable,
        volume_uuid,
        disk_uuid,
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn getmntinfo_r_np(
        mntbufp: *mut *mut nix::libc::statfs,
        flags: nix::libc::c_int,
    ) -> nix::libc::c_int;
}

#[cfg(target_os = "macos")]
fn list_mount_entries() -> Result<Vec<MountEntry>> {
    let mut mount_buf: *mut nix::libc::statfs = std::ptr::null_mut();
    let count = unsafe {
        // SAFETY: getmntinfo_r_np writes a pointer to an allocated statfs array on success.
        getmntinfo_r_np(&mut mount_buf, nix::libc::MNT_NOWAIT)
    };

    if count <= 0 || mount_buf.is_null() {
        return Err(anyhow::anyhow!(
            "Failed to list mounted filesystems: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mount_slice = unsafe {
        // SAFETY: count and pointer are returned by getmntinfo_r_np above.
        std::slice::from_raw_parts(mount_buf, count as usize)
    };

    let mut entries = Vec::with_capacity(count as usize);
    for stat in mount_slice {
        let mount_point = PathBuf::from(c_char_buffer_to_string(&stat.f_mntonname));
        if mount_point.as_os_str().is_empty() {
            continue;
        }

        entries.push(MountEntry {
            mount_point,
            mount_from: c_char_buffer_to_string(&stat.f_mntfromname),
            flags: stat.f_flags as u32,
            block_size: stat.f_bsize as u64,
            blocks: stat.f_blocks as u64,
            blocks_available: stat.f_bavail as u64,
        });
    }

    unsafe {
        // SAFETY: getmntinfo_r_np allocates this buffer and requires the caller to free it.
        nix::libc::free(mount_buf.cast());
    }

    Ok(entries)
}

#[cfg(not(target_os = "macos"))]
fn list_mount_entries() -> Result<Vec<MountEntry>> {
    Err(anyhow::anyhow!("list_mount_entries is only supported on macOS"))
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

    #[test]
    fn test_parse_volume_metadata() {
        // Mock output of `diskutil info -plist`
        // Based on user provided example (though user provided `list -plist`, the structure keys are consistent)
        let xml = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>VolumeName</key>
            <string>TestVolume</string>
            <key>VolumeUUID</key>
            <string>D47B2E09-AF70-3B66-B96F-D51909930EEA</string>
            <key>DiskPartitionUUID</key>
            <string>F7E6416E-BAD0-4304-8B13-E3268A1A1A07</string>
            <key>Internal</key>
            <false/>
            <key>Ejectable</key>
            <true/>
            <key>RemovableMedia</key>
            <true/>
            <key>DeviceIdentifier</key>
            <string>disk8s1</string>
        </dict>
        </plist>
        "#;

        let metadata = DiskMonitor::parse_volume_metadata_from_plist(xml.as_bytes())
            .expect("metadata should parse");
        assert_eq!(
            metadata.volume_uuid,
            Some("D47B2E09-AF70-3B66-B96F-D51909930EEA".to_string())
        );
        assert_eq!(
            metadata.disk_uuid,
            Some("F7E6416E-BAD0-4304-8B13-E3268A1A1A07".to_string())
        );
        assert_eq!(metadata.internal, Some(false));
        assert_eq!(metadata.ejectable, Some(true));
        assert_eq!(metadata.removable_media, Some(true));
    }

    #[test]
    fn test_parse_volume_metadata_missing_fields() {
        let xml = r#"
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>VolumeName</key>
            <string>NoUUID</string>
        </dict>
        </plist>
        "#;

        let metadata = DiskMonitor::parse_volume_metadata_from_plist(xml.as_bytes())
            .expect("metadata should parse");
        assert_eq!(metadata.volume_uuid, None);
        assert_eq!(metadata.disk_uuid, None);
        assert_eq!(metadata.internal, None);
        assert_eq!(metadata.ejectable, None);
        assert_eq!(metadata.removable_media, None);
    }

    #[test]
    fn test_is_user_visible_mount_filters_expected_paths() {
        let browsable_flags = 0u32;

        assert!(is_user_visible_mount(Path::new("/"), browsable_flags));
        assert!(is_user_visible_mount(Path::new("/Volumes/EVO990"), browsable_flags));
        assert!(!is_user_visible_mount(Path::new("/System/Volumes/VM"), browsable_flags));
        assert!(!is_user_visible_mount(Path::new("/Volumes/.timemachine"), browsable_flags));
        assert!(!is_user_visible_mount(
            Path::new("/Volumes/.timemachine/backup"),
            browsable_flags
        ));
        assert!(!is_user_visible_mount(
            Path::new("/Volumes/com.apple.TimeMachine.localsnapshots"),
            browsable_flags
        ));
        assert!(!is_user_visible_mount(
            Path::new("/Volumes/Visible"),
            nix::libc::MNT_DONTBROWSE as u32
        ));
    }

    #[test]
    fn test_network_mount_capacity_is_none() {
        let entry = MountEntry {
            mount_point: PathBuf::from("/Volumes/NAS"),
            mount_from: "//nas.local/share".to_string(),
            flags: 0, // MNT_LOCAL 미포함 = 네트워크 마운트
            block_size: 4096,
            blocks: 100,
            blocks_available: 40,
        };

        let volume = volume_info_from_mount(&entry, true, false, None, None);

        assert!(volume.is_network);
        assert_eq!(volume.total_bytes, None);
        assert_eq!(volume.available_bytes, None);
        assert!(!volume.is_removable);
    }

    #[test]
    fn test_is_removable_mount_requires_external_metadata() {
        let entry = MountEntry {
            mount_point: PathBuf::from("/Volumes/USB"),
            mount_from: "/dev/disk8s1".to_string(),
            flags: nix::libc::MNT_LOCAL as u32,
            block_size: 4096,
            blocks: 100,
            blocks_available: 40,
        };

        let removable_by_ejectable = VolumeMetadata {
            internal: Some(false),
            ejectable: Some(true),
            removable_media: Some(false),
            ..VolumeMetadata::default()
        };
        assert!(is_removable_mount(
            &entry,
            false,
            Some(&removable_by_ejectable)
        ));

        let removable_by_media_flag = VolumeMetadata {
            internal: Some(false),
            ejectable: Some(false),
            removable_media: Some(true),
            ..VolumeMetadata::default()
        };
        assert!(is_removable_mount(
            &entry,
            false,
            Some(&removable_by_media_flag)
        ));

        let internal_volume = VolumeMetadata {
            internal: Some(true),
            ejectable: Some(true),
            removable_media: Some(true),
            ..VolumeMetadata::default()
        };
        assert!(!is_removable_mount(&entry, false, Some(&internal_volume)));
        assert!(!is_removable_mount(&entry, false, None));
        assert!(!is_removable_mount(&entry, true, Some(&removable_by_ejectable)));

        let non_disk_entry = MountEntry {
            mount_from: "/dev/apfs".to_string(),
            ..entry.clone()
        };
        assert!(!is_removable_mount(
            &non_disk_entry,
            false,
            Some(&removable_by_ejectable)
        ));

        let non_volumes_entry = MountEntry {
            mount_point: PathBuf::from("/Users/kimjeongjin"),
            ..entry
        };
        assert!(!is_removable_mount(
            &non_volumes_entry,
            false,
            Some(&removable_by_ejectable)
        ));
    }

    #[test]
    fn test_find_matching_removable_mount_root() {
        let removable_volumes = vec![
            VolumeInfo {
                name: "USB".to_string(),
                path: PathBuf::from("/Volumes/USB"),
                mount_point: PathBuf::from("/Volumes/USB"),
                total_bytes: None,
                available_bytes: None,
                is_network: false,
                is_removable: true,
                volume_uuid: None,
                disk_uuid: None,
            },
            VolumeInfo {
                name: "USB-NESTED".to_string(),
                path: PathBuf::from("/Volumes/USB/DCIM"),
                mount_point: PathBuf::from("/Volumes/USB/DCIM"),
                total_bytes: None,
                available_bytes: None,
                is_network: false,
                is_removable: true,
                volume_uuid: None,
                disk_uuid: None,
            },
        ];

        let matched = find_matching_removable_mount_root(
            Path::new("/Volumes/USB/DCIM/100MSDCF"),
            &removable_volumes,
        );
        assert_eq!(matched, Some(PathBuf::from("/Volumes/USB/DCIM")));

        let matched_root =
            find_matching_removable_mount_root(Path::new("/Volumes/USB"), &removable_volumes);
        assert_eq!(matched_root, Some(PathBuf::from("/Volumes/USB")));

        let unmatched = find_matching_removable_mount_root(
            Path::new("/Volumes/INTERNAL/Documents"),
            &removable_volumes,
        );
        assert_eq!(unmatched, None);
    }
}
