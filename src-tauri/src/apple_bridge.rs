use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStoreSupporterStatus {
    pub active: bool,
    #[serde(default)]
    pub product_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStorePurchaseResult {
    pub success: bool,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub product_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkCaptureResult {
    pub path: String,
    pub bookmark: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkResolveResult {
    pub path: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMountCaptureResult {
    pub scheme: String,
    pub remount_url: String,
    #[serde(default)]
    pub username: Option<String>,
    pub mount_root_path: String,
    pub relative_path_from_mount_root: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMountExecutionResult {
    pub mount_path: String,
    #[serde(default)]
    pub error_kind: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn syncwatcher_storekit_get_supporter_status(product_id: *const c_char) -> *mut c_char;
    fn syncwatcher_storekit_purchase_supporter(product_id: *const c_char) -> *mut c_char;
    fn syncwatcher_storekit_restore_supporter(product_id: *const c_char) -> *mut c_char;
    fn syncwatcher_create_security_scoped_bookmark(path: *const c_char) -> *mut c_char;
    fn syncwatcher_resolve_security_scoped_bookmark(bookmark: *const c_char) -> *mut c_char;
    fn syncwatcher_capture_network_mount(path: *const c_char) -> *mut c_char;
    fn syncwatcher_mount_network_share(payload: *const c_char) -> *mut c_char;
    fn syncwatcher_store_keychain_secret(payload: *const c_char) -> *mut c_char;
    fn syncwatcher_read_keychain_secret(payload: *const c_char) -> *mut c_char;
    fn syncwatcher_delete_keychain_secret(payload: *const c_char) -> *mut c_char;
    fn syncwatcher_free_bridge_string(value: *mut c_char);
}

#[cfg(target_os = "macos")]
fn call_string_bridge<F>(input: &str, bridge_call: F) -> Result<String, String>
where
    F: FnOnce(*const c_char) -> *mut c_char,
{
    let input_c_string = CString::new(input)
        .map_err(|_| "Bridge input contained an interior null byte".to_string())?;
    let response_ptr = bridge_call(input_c_string.as_ptr());
    if response_ptr.is_null() {
        return Err("Native Apple bridge returned an empty response".to_string());
    }

    let response = unsafe { CStr::from_ptr(response_ptr) }
        .to_string_lossy()
        .to_string();
    unsafe {
        syncwatcher_free_bridge_string(response_ptr);
    }
    Ok(response)
}

#[cfg(target_os = "macos")]
pub fn get_app_store_supporter_status(product_id: &str) -> Result<AppStoreSupporterStatus, String> {
    let response = call_string_bridge(product_id, |value| unsafe {
        syncwatcher_storekit_get_supporter_status(value)
    })?;
    serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode App Store supporter status: {error}"))
}

#[cfg(not(target_os = "macos"))]
pub fn get_app_store_supporter_status(
    _product_id: &str,
) -> Result<AppStoreSupporterStatus, String> {
    Err("App Store supporter status is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn purchase_app_store_supporter(product_id: &str) -> Result<AppStorePurchaseResult, String> {
    let response = call_string_bridge(product_id, |value| unsafe {
        syncwatcher_storekit_purchase_supporter(value)
    })?;
    serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode App Store purchase result: {error}"))
}

#[cfg(not(target_os = "macos"))]
pub fn purchase_app_store_supporter(_product_id: &str) -> Result<AppStorePurchaseResult, String> {
    Err("App Store supporter purchase is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn restore_app_store_supporter(product_id: &str) -> Result<AppStorePurchaseResult, String> {
    let response = call_string_bridge(product_id, |value| unsafe {
        syncwatcher_storekit_restore_supporter(value)
    })?;
    serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode App Store restore result: {error}"))
}

#[cfg(not(target_os = "macos"))]
pub fn restore_app_store_supporter(_product_id: &str) -> Result<AppStorePurchaseResult, String> {
    Err("App Store supporter restore is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn create_security_scoped_bookmark(path: &str) -> Result<BookmarkCaptureResult, String> {
    let response = call_string_bridge(path, |value| unsafe {
        syncwatcher_create_security_scoped_bookmark(value)
    })?;
    let payload: BookmarkCaptureResult = serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode bookmark capture result: {error}"))?;
    if let Some(error) = payload.error.clone() {
        return Err(error);
    }
    Ok(payload)
}

#[cfg(not(target_os = "macos"))]
pub fn create_security_scoped_bookmark(path: &str) -> Result<BookmarkCaptureResult, String> {
    Ok(BookmarkCaptureResult {
        path: path.to_string(),
        bookmark: String::new(),
        error: None,
    })
}

#[cfg(target_os = "macos")]
pub fn resolve_security_scoped_bookmark(bookmark: &str) -> Result<BookmarkResolveResult, String> {
    let response = call_string_bridge(bookmark, |value| unsafe {
        syncwatcher_resolve_security_scoped_bookmark(value)
    })?;
    serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode bookmark resolve result: {error}"))
}

#[cfg(target_os = "macos")]
pub fn capture_network_mount(path: &str) -> Result<NetworkMountCaptureResult, String> {
    let response = call_string_bridge(path, |value| unsafe {
        syncwatcher_capture_network_mount(value)
    })?;
    let payload: NetworkMountCaptureResult = serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode network mount capture result: {error}"))?;
    if let Some(error) = payload.error.clone() {
        return Err(error);
    }
    Ok(payload)
}

#[cfg(not(target_os = "macos"))]
pub fn capture_network_mount(_path: &str) -> Result<NetworkMountCaptureResult, String> {
    Err("Network mount capture is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn mount_network_share(payload_json: &str) -> Result<NetworkMountExecutionResult, String> {
    let response = call_string_bridge(payload_json, |value| unsafe {
        syncwatcher_mount_network_share(value)
    })?;
    let payload: NetworkMountExecutionResult = serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode network mount execution result: {error}"))?;
    if let Some(error) = payload.error.clone() {
        return Err(error);
    }
    Ok(payload)
}

#[cfg(not(target_os = "macos"))]
pub fn mount_network_share(_payload_json: &str) -> Result<NetworkMountExecutionResult, String> {
    Err("Network share mounting is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn store_keychain_secret(payload_json: &str) -> Result<(), String> {
    let response = call_string_bridge(payload_json, |value| unsafe {
        syncwatcher_store_keychain_secret(value)
    })?;
    let payload: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode keychain store result: {error}"))?;
    if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn store_keychain_secret(_payload_json: &str) -> Result<(), String> {
    Err("Keychain secret storage is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn read_keychain_secret(payload_json: &str) -> Result<Option<String>, String> {
    let response = call_string_bridge(payload_json, |value| unsafe {
        syncwatcher_read_keychain_secret(value)
    })?;
    let payload: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode keychain read result: {error}"))?;
    if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_string());
    }
    Ok(payload
        .get("secret")
        .and_then(|value| value.as_str())
        .map(ToString::to_string))
}

#[cfg(not(target_os = "macos"))]
pub fn read_keychain_secret(_payload_json: &str) -> Result<Option<String>, String> {
    Err("Keychain secret storage is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub fn delete_keychain_secret(payload_json: &str) -> Result<(), String> {
    let response = call_string_bridge(payload_json, |value| unsafe {
        syncwatcher_delete_keychain_secret(value)
    })?;
    let payload: serde_json::Value = serde_json::from_str(&response)
        .map_err(|error| format!("Failed to decode keychain delete result: {error}"))?;
    if let Some(error) = payload.get("error").and_then(|value| value.as_str()) {
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn delete_keychain_secret(_payload_json: &str) -> Result<(), String> {
    Err("Keychain secret storage is only available on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn resolve_security_scoped_bookmark(_bookmark: &str) -> Result<BookmarkResolveResult, String> {
    Err("Security-scoped bookmarks are only available on macOS".to_string())
}

#[allow(dead_code)]
fn _ensure_c_int_is_available(_: c_int) {}
