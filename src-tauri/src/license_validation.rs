//! Lemon Squeezy 라이선스 검증 모듈
//!
//! Lemon Squeezy API를 통해 라이선스 키 활성화 및 검증을 수행합니다.
//! 네트워크 오류 시 캐시된 상태를 사용하며, 앱 데이터 디렉토리에
//! 라이선스 상태를 영구 저장합니다.

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Grace period: 네트워크 오류 시 마지막 검증 후 7일간 유효
const GRACE_PERIOD_DAYS: i64 = 7;

/// 라이선스 파일명
const LICENSE_STATE_FILE: &str = "license_state.json";
const LEMON_SQUEEZY_STORE_ID_ENV: &str = "SYNCWATCHER_LEMON_SQUEEZY_STORE_ID";
const LEMON_SQUEEZY_PRODUCT_ID_ENV: &str = "SYNCWATCHER_LEMON_SQUEEZY_PRODUCT_ID";
const LEMON_SQUEEZY_VARIANT_ID_ENV: &str = "SYNCWATCHER_LEMON_SQUEEZY_VARIANT_ID";

#[derive(Debug, Clone, PartialEq, Eq)]
struct LemonSqueezyConfig {
    store_id: u64,
    product_id: u64,
    variant_id: Option<u64>,
}

/// 로컬에 저장되는 라이선스 상태
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    /// Lemon Squeezy 라이선스 키
    pub license_key: String,
    /// 활성화된 인스턴스 ID
    pub instance_id: String,
    /// 마지막 검증 성공 시각 (RFC 3339)
    pub validated_at: String,
    /// 유효 여부
    pub is_valid: bool,
}

/// 프론트엔드로 반환하는 라이선스 상태
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub is_registered: bool,
    pub license_key: Option<String>,
}

/// Lemon Squeezy API activate 응답 구조
#[derive(Debug, Deserialize)]
struct LsActivateResponse {
    activated: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "license_key")]
    _license_key: Option<LsLicenseKeyInfo>,
    #[serde(default)]
    instance: Option<LsInstance>,
    #[serde(default)]
    meta: Option<LsMeta>,
}

/// Lemon Squeezy API validate 응답 구조
#[derive(Debug, Deserialize)]
struct LsValidateResponse {
    valid: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    meta: Option<LsMeta>,
}

#[derive(Debug, Deserialize)]
struct LsLicenseKeyInfo {
    #[allow(dead_code)]
    id: u64,
    #[allow(dead_code)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct LsInstance {
    id: String,
}

#[derive(Debug, Deserialize)]
struct LsMeta {
    store_id: u64,
    #[serde(default)]
    product_id: u64,
    #[serde(default)]
    variant_id: Option<u64>,
}

/// Lemon Squeezy API deactivate 응답 구조
#[derive(Debug, Deserialize)]
struct LsDeactivateResponse {
    deactivated: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    meta: Option<LsMeta>,
}

/// 라이선스 상태 파일 경로를 반환합니다.
///
/// # Arguments
/// * `app` - Tauri AppHandle
///
/// # Returns
/// 라이선스 상태 파일의 절대 경로
fn license_state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app_data.join(LICENSE_STATE_FILE))
}

pub(crate) fn debug_license_state_path(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    license_state_path(app)
}

/// 저장된 라이선스 상태를 로드합니다.
///
/// # Arguments
/// * `app` - Tauri AppHandle
///
/// # Returns
/// 저장된 LicenseState 또는 None
fn load_license_state(app: &tauri::AppHandle) -> Option<LicenseState> {
    let path = license_state_path(app).ok()?;
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn debug_load_license_state(app: &tauri::AppHandle) -> Option<LicenseState> {
    load_license_state(app)
}

fn clear_license_state(app: &tauri::AppHandle) -> Result<(), String> {
    let path = license_state_path(app)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// 라이선스 상태를 파일로 저장합니다.
///
/// # Arguments
/// * `app` - Tauri AppHandle
/// * `state` - 저장할 LicenseState
///
/// # Returns
/// 성공 시 Ok, 실패 시 에러 메시지
fn save_license_state(app: &tauri::AppHandle, state: &LicenseState) -> Result<(), String> {
    let path = license_state_path(app)?;

    // 디렉토리가 없으면 생성
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// 머신 고유 식별자를 생성합니다 (hostname 기반).
///
/// # Returns
/// 머신 식별자 문자열
fn get_instance_name() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown-machine".to_string())
}

fn compile_time_env(name: &str) -> Option<&'static str> {
    match name {
        LEMON_SQUEEZY_STORE_ID_ENV => option_env!("SYNCWATCHER_LEMON_SQUEEZY_STORE_ID"),
        LEMON_SQUEEZY_PRODUCT_ID_ENV => option_env!("SYNCWATCHER_LEMON_SQUEEZY_PRODUCT_ID"),
        LEMON_SQUEEZY_VARIANT_ID_ENV => option_env!("SYNCWATCHER_LEMON_SQUEEZY_VARIANT_ID"),
        _ => None,
    }
}

fn configured_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| compile_time_env(name).map(|value| value.to_string()))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_required_u64(name: &str, value: Option<String>) -> Result<u64, String> {
    let raw = value.ok_or_else(|| format!("Missing required Lemon Squeezy config: {name}"))?;
    raw.parse::<u64>()
        .map_err(|_| format!("Invalid Lemon Squeezy config for {name}: expected unsigned integer"))
}

fn parse_optional_u64(name: &str, value: Option<String>) -> Result<Option<u64>, String> {
    match value {
        Some(raw) => raw.parse::<u64>().map(Some).map_err(|_| {
            format!("Invalid Lemon Squeezy config for {name}: expected unsigned integer")
        }),
        None => Ok(None),
    }
}

impl LemonSqueezyConfig {
    fn load() -> Result<Self, String> {
        Self::from_values(
            configured_env(LEMON_SQUEEZY_STORE_ID_ENV),
            configured_env(LEMON_SQUEEZY_PRODUCT_ID_ENV),
            configured_env(LEMON_SQUEEZY_VARIANT_ID_ENV),
        )
    }

    fn from_values(
        store_id: Option<String>,
        product_id: Option<String>,
        variant_id: Option<String>,
    ) -> Result<Self, String> {
        Ok(Self {
            store_id: parse_required_u64(LEMON_SQUEEZY_STORE_ID_ENV, store_id)?,
            product_id: parse_required_u64(LEMON_SQUEEZY_PRODUCT_ID_ENV, product_id)?,
            variant_id: parse_optional_u64(LEMON_SQUEEZY_VARIANT_ID_ENV, variant_id)?,
        })
    }

    fn verify_meta(&self, meta: &LsMeta) -> Result<(), String> {
        if meta.store_id != self.store_id {
            return Err("Invalid store".to_string());
        }
        if meta.product_id != self.product_id {
            return Err("Invalid product".to_string());
        }
        if let Some(expected_variant_id) = self.variant_id {
            if meta.variant_id != Some(expected_variant_id) {
                return Err("Invalid variant".to_string());
            }
        }
        Ok(())
    }
}

/// Lemon Squeezy에서 라이선스 키를 활성화합니다.
///
/// # Arguments
/// * `app` - Tauri AppHandle
/// * `license_key` - 활성화할 라이선스 키
///
/// # Returns
/// 활성화 결과 (valid, error)
#[tauri::command]
pub async fn activate_license_key(
    app: tauri::AppHandle,
    license_key: String,
) -> Result<serde_json::Value, String> {
    let config = LemonSqueezyConfig::load()?;
    let client = reqwest::Client::new();
    let instance_name = get_instance_name();

    let response = client
        .post("https://api.lemonsqueezy.com/v1/licenses/activate")
        .header("Accept", "application/json")
        .form(&[
            ("license_key", license_key.as_str()),
            ("instance_name", instance_name.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let body: LsActivateResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if body.activated {
        let meta = match &body.meta {
            Some(meta) => meta,
            None => {
                return Ok(serde_json::json!({
                    "valid": false,
                    "error": "Missing license metadata"
                }));
            }
        };
        if let Err(error) = config.verify_meta(meta) {
            return Ok(serde_json::json!({
                "valid": false,
                "error": error
            }));
        }

        let instance_id = body.instance.map(|i| i.id).unwrap_or_default();
        if instance_id.is_empty() {
            return Ok(serde_json::json!({
                "valid": false,
                "error": "Missing license instance id"
            }));
        }

        let state = LicenseState {
            license_key: license_key.clone(),
            instance_id,
            validated_at: chrono::Utc::now().to_rfc3339(),
            is_valid: true,
        };

        save_license_state(&app, &state)?;

        Ok(serde_json::json!({
            "valid": true,
            "error": null
        }))
    } else {
        Ok(serde_json::json!({
            "valid": false,
            "error": body.error.unwrap_or_else(|| "Activation failed".to_string())
        }))
    }
}

/// 저장된 라이선스 키를 Lemon Squeezy에서 검증합니다.
/// 네트워크 오류 시 grace period 내이면 유효로 간주합니다.
///
/// # Arguments
/// * `app` - Tauri AppHandle
///
/// # Returns
/// 검증 결과 (valid, error)
#[tauri::command]
pub async fn validate_license_key(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = match load_license_state(&app) {
        Some(s) => s,
        None => {
            return Ok(serde_json::json!({
                "valid": false,
                "error": "No license found"
            }));
        }
    };
    let config = LemonSqueezyConfig::load()?;

    let client = reqwest::Client::new();

    let response = client
        .post("https://api.lemonsqueezy.com/v1/licenses/validate")
        .header("Accept", "application/json")
        .form(&[
            ("license_key", state.license_key.as_str()),
            ("instance_id", state.instance_id.as_str()),
        ])
        .send()
        .await;

    match response {
        Ok(resp) => {
            match resp.json::<LsValidateResponse>().await {
                Ok(body) => {
                    if body.valid {
                        let meta = match &body.meta {
                            Some(meta) => meta,
                            None => {
                                return Ok(serde_json::json!({
                                    "valid": false,
                                    "error": "Missing license metadata"
                                }));
                            }
                        };
                        if let Err(error) = config.verify_meta(meta) {
                            return Ok(serde_json::json!({
                                "valid": false,
                                "error": error
                            }));
                        }

                        // 검증 성공 — 상태 업데이트
                        let updated = LicenseState {
                            validated_at: chrono::Utc::now().to_rfc3339(),
                            is_valid: true,
                            ..state
                        };
                        let _ = save_license_state(&app, &updated);

                        Ok(serde_json::json!({
                            "valid": true,
                            "error": null
                        }))
                    } else {
                        // 만료/비활성화
                        let updated = LicenseState {
                            is_valid: false,
                            ..state
                        };
                        let _ = save_license_state(&app, &updated);

                        Ok(serde_json::json!({
                            "valid": false,
                            "error": body.error.unwrap_or_else(|| "License invalid".to_string())
                        }))
                    }
                }
                Err(e) => {
                    eprintln!("[LicenseValidation] Parse error: {}", e);
                    check_grace_period(&state)
                }
            }
        }
        Err(e) => {
            eprintln!("[LicenseValidation] Network error: {}", e);
            check_grace_period(&state)
        }
    }
}

/// 저장된 라이선스 키 인스턴스를 Lemon Squeezy에서 비활성화하고 로컬 상태를 제거합니다.
#[tauri::command]
pub async fn deactivate_license_key(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = match load_license_state(&app) {
        Some(state) => state,
        None => {
            return Ok(serde_json::json!({
                "success": true,
                "error": null
            }));
        }
    };
    let config = LemonSqueezyConfig::load()?;

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.lemonsqueezy.com/v1/licenses/deactivate")
        .header("Accept", "application/json")
        .form(&[
            ("license_key", state.license_key.as_str()),
            ("instance_id", state.instance_id.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Network error: {error}"))?;

    let body: LsDeactivateResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse response: {error}"))?;

    if !body.deactivated {
        return Ok(serde_json::json!({
            "success": false,
            "error": body.error.unwrap_or_else(|| "Deactivation failed".to_string())
        }));
    }

    let meta = match &body.meta {
        Some(meta) => meta,
        None => {
            return Ok(serde_json::json!({
                "success": false,
                "error": "Missing license metadata"
            }));
        }
    };
    if let Err(error) = config.verify_meta(meta) {
        return Ok(serde_json::json!({
            "success": false,
            "error": error
        }));
    }

    clear_license_state(&app)?;

    Ok(serde_json::json!({
        "success": true,
        "error": null
    }))
}

/// 현재 라이선스 상태를 반환합니다 (네트워크 호출 없음).
///
/// # Arguments
/// * `app` - Tauri AppHandle
///
/// # Returns
/// LicenseStatus (isRegistered, licenseKey)
#[tauri::command]
pub async fn get_license_status(app: tauri::AppHandle) -> Result<LicenseStatus, String> {
    let state = load_license_state(&app);
    match state {
        Some(s) if s.is_valid => Ok(LicenseStatus {
            is_registered: true,
            license_key: Some(mask_license_key(&s.license_key)),
        }),
        _ => Ok(LicenseStatus {
            is_registered: false,
            license_key: None,
        }),
    }
}

/// 라이선스 키를 마스킹합니다 (앞 8자만 표시).
///
/// # Arguments
/// * `key` - 비마스킹 라이선스 키
///
/// # Returns
/// 마스킹된 라이선스 키 문자열
fn mask_license_key(key: &str) -> String {
    if key.len() <= 8 {
        return "****".to_string();
    }
    format!("{}…{}", &key[..4], &key[key.len() - 4..])
}

/// Grace period 체크: 마지막 검증 후 7일 이내이면 유효로 간주합니다.
///
/// # Arguments
/// * `state` - 저장된 LicenseState
///
/// # Returns
/// 유효 여부 JSON
fn check_grace_period(state: &LicenseState) -> Result<serde_json::Value, String> {
    if !state.is_valid {
        return Ok(serde_json::json!({
            "valid": false,
            "error": "License previously invalidated"
        }));
    }

    match chrono::DateTime::parse_from_rfc3339(&state.validated_at) {
        Ok(validated_at) => {
            let elapsed = chrono::Utc::now()
                .signed_duration_since(validated_at)
                .num_days();

            if elapsed <= GRACE_PERIOD_DAYS {
                Ok(serde_json::json!({
                    "valid": true,
                    "error": null
                }))
            } else {
                Ok(serde_json::json!({
                    "valid": false,
                    "error": "Grace period expired, please connect to the internet"
                }))
            }
        }
        Err(_) => Ok(serde_json::json!({
            "valid": false,
            "error": "Invalid validation timestamp"
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::{mask_license_key, LemonSqueezyConfig};

    #[test]
    fn parses_required_and_optional_lemon_config() {
        let config = LemonSqueezyConfig::from_values(
            Some("280001".to_string()),
            Some("825436".to_string()),
            Some("1301030".to_string()),
        )
        .expect("config should parse");

        assert_eq!(config.store_id, 280001);
        assert_eq!(config.product_id, 825436);
        assert_eq!(config.variant_id, Some(1301030));
    }

    #[test]
    fn allows_missing_optional_variant_id() {
        let config = LemonSqueezyConfig::from_values(
            Some("280001".to_string()),
            Some("825436".to_string()),
            None,
        )
        .expect("config should parse");

        assert_eq!(config.variant_id, None);
    }

    #[test]
    fn rejects_missing_required_values() {
        let error = LemonSqueezyConfig::from_values(None, Some("825436".to_string()), None)
            .expect_err("missing store id should fail");

        assert!(error.contains("SYNCWATCHER_LEMON_SQUEEZY_STORE_ID"));
    }

    #[test]
    fn masks_license_key_with_prefix_and_suffix() {
        assert_eq!(mask_license_key("abcd1234wxyz9876"), "abcd…9876");
        assert_eq!(mask_license_key("short"), "****");
    }
}
