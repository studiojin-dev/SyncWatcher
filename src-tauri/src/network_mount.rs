use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::apple_bridge;
use crate::config_store::{NetworkMountRecord, NetworkMountScheme};

const KEYCHAIN_SERVICE_NAME: &str = "dev.studiojin.syncwatcher.network-mount";

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMountCapturePayload {
    pub scheme: NetworkMountScheme,
    pub remount_url: String,
    #[serde(default)]
    pub username: Option<String>,
    pub mount_root_path: String,
    pub relative_path_from_mount_root: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkMountRole {
    Source,
    Target,
}

impl NetworkMountRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Target => "target",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeychainSecretPayload<'a> {
    service: &'a str,
    account: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MountNetworkSharePayload<'a> {
    remount_url: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<&'a str>,
    allow_ui: bool,
}

pub fn keychain_account(task_id: &str, role: NetworkMountRole) -> String {
    format!("{task_id}:{}", role.as_str())
}

pub fn capture_from_path(path: &str) -> Result<Option<NetworkMountCapturePayload>, String> {
    let captured = apple_bridge::capture_network_mount(path)?;
    if captured.remount_url.trim().is_empty() {
        return Ok(None);
    }

    let scheme = match captured.scheme.trim().to_ascii_lowercase().as_str() {
        "smb" => NetworkMountScheme::Smb,
        other => {
            return Err(format!("unsupported network scheme: {other}"));
        }
    };

    Ok(Some(NetworkMountCapturePayload {
        scheme,
        remount_url: captured.remount_url,
        username: captured.username,
        mount_root_path: captured.mount_root_path,
        relative_path_from_mount_root: normalize_relative_subpath(
            &captured.relative_path_from_mount_root,
        ),
        enabled: true,
    }))
}

pub fn store_password(
    task_id: &str,
    role: NetworkMountRole,
    password: Option<&str>,
) -> Result<(), String> {
    let account = keychain_account(task_id, role);
    if let Some(password) = password {
        if password.is_empty() {
            return Ok(());
        }
        let payload = serde_json::to_string(&KeychainSecretPayload {
            service: KEYCHAIN_SERVICE_NAME,
            account: &account,
            secret: Some(password),
        })
        .map_err(|error| format!("Failed to serialize keychain store payload: {error}"))?;
        apple_bridge::store_keychain_secret(&payload)?;
    }
    Ok(())
}

pub fn delete_password(task_id: &str, role: NetworkMountRole) -> Result<(), String> {
    let account = keychain_account(task_id, role);
    let payload = serde_json::to_string(&KeychainSecretPayload {
        service: KEYCHAIN_SERVICE_NAME,
        account: &account,
        secret: None,
    })
    .map_err(|error| format!("Failed to serialize keychain delete payload: {error}"))?;
    apple_bridge::delete_keychain_secret(&payload)
}

pub fn read_password(task_id: &str, role: NetworkMountRole) -> Result<Option<String>, String> {
    let account = keychain_account(task_id, role);
    let payload = serde_json::to_string(&KeychainSecretPayload {
        service: KEYCHAIN_SERVICE_NAME,
        account: &account,
        secret: None,
    })
    .map_err(|error| format!("Failed to serialize keychain read payload: {error}"))?;
    apple_bridge::read_keychain_secret(&payload)
}

pub fn ensure_mount_available(
    task_id: &str,
    role: NetworkMountRole,
    mount: &NetworkMountRecord,
    allow_ui: bool,
) -> Result<PathBuf, String> {
    if !mount.enabled {
        return Ok(resolved_path_from_mount(Path::new(&mount.mount_root_path), mount));
    }

    let password = read_password(task_id, role)?;
    let payload = serde_json::to_string(&MountNetworkSharePayload {
        remount_url: &mount.remount_url,
        username: mount.username.as_deref(),
        password: password.as_deref(),
        allow_ui,
    })
    .map_err(|error| format!("Failed to serialize network mount payload: {error}"))?;
    let result = apple_bridge::mount_network_share(&payload)
        .map_err(|error| normalize_mount_error(error, None))?;
    if let Some(kind) = result.error_kind.as_deref() {
        return Err(normalize_mount_error(
            result.error.unwrap_or_else(|| "network mount failed".to_string()),
            Some(kind),
        ));
    }

    Ok(resolved_path_from_mount(Path::new(&result.mount_path), mount))
}

pub fn resolved_path_from_mount(mount_root: &Path, mount: &NetworkMountRecord) -> PathBuf {
    let relative = normalize_relative_subpath(&mount.relative_path_from_mount_root);
    if relative == "." {
        return mount_root.to_path_buf();
    }
    mount_root.join(relative)
}

pub fn normalize_relative_subpath(value: &str) -> String {
    let trimmed = value.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        ".".to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_mount_error(error: String, kind: Option<&str>) -> String {
    match kind.unwrap_or_default() {
        "auth" => format!("network mount authentication failed: {error}"),
        "shareNotFound" => format!("network share not found: {error}"),
        "unsupportedScheme" => format!("unsupported network scheme: {error}"),
        "userCancelled" => format!("network mount cancelled: {error}"),
        _ => format!("network mount failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_relative_subpath_uses_dot_for_root() {
        assert_eq!(normalize_relative_subpath(""), ".");
        assert_eq!(normalize_relative_subpath("/"), ".");
        assert_eq!(normalize_relative_subpath("///"), ".");
    }

    #[test]
    fn normalize_relative_subpath_strips_leading_slash() {
        assert_eq!(normalize_relative_subpath("/photos/raw"), "photos/raw");
    }

    #[test]
    fn resolved_path_from_mount_keeps_mount_root_for_dot() {
        let mount = NetworkMountRecord {
            scheme: NetworkMountScheme::Smb,
            remount_url: "smb://nas.local/share".to_string(),
            username: Some("user".to_string()),
            mount_root_path: "/Volumes/share".to_string(),
            relative_path_from_mount_root: ".".to_string(),
            enabled: true,
        };
        assert_eq!(
            resolved_path_from_mount(Path::new("/Volumes/share"), &mount),
            PathBuf::from("/Volumes/share")
        );
    }

    #[test]
    fn resolved_path_from_mount_appends_relative_subpath() {
        let mount = NetworkMountRecord {
            scheme: NetworkMountScheme::Smb,
            remount_url: "smb://nas.local/share".to_string(),
            username: Some("user".to_string()),
            mount_root_path: "/Volumes/share".to_string(),
            relative_path_from_mount_root: "photos/raw".to_string(),
            enabled: true,
        };
        assert_eq!(
            resolved_path_from_mount(Path::new("/Volumes/share"), &mount),
            PathBuf::from("/Volumes/share/photos/raw")
        );
    }
}
