//! Lemon Squeezy 라이선스 검증 모듈
//!
//! Lemon Squeezy API를 통해 라이선스 키 활성화 및 검증을 수행합니다.
//! 네트워크 오류 시 캐시된 상태를 사용하며, 앱 데이터 디렉토리에
//! 라이선스 상태를 영구 저장합니다.

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Lemon Squeezy Store ID (하드코딩)
const LEMON_SQUEEZY_STORE_ID: u64 = 280001;

/// Lemon Squeezy Product ID (하드코딩)
const LEMON_SQUEEZY_PRODUCT_ID: u64 = 825436;

/// Grace period: 네트워크 오류 시 마지막 검증 후 7일간 유효
const GRACE_PERIOD_DAYS: i64 = 7;

/// 라이선스 파일명
const LICENSE_STATE_FILE: &str = "license_state.json";

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
    #[serde(default)]
    license_key: Option<LsLicenseKeyInfo>,
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
        // store_id / product_id 검증
        if let Some(meta) = &body.meta {
            if meta.store_id != LEMON_SQUEEZY_STORE_ID {
                return Ok(serde_json::json!({
                    "valid": false,
                    "error": "Invalid store"
                }));
            }
            if meta.product_id != LEMON_SQUEEZY_PRODUCT_ID {
                return Ok(serde_json::json!({
                    "valid": false,
                    "error": "Invalid product"
                }));
            }
        }

        let instance_id = body
            .instance
            .map(|i| i.id)
            .unwrap_or_default();

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
pub async fn validate_license_key(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let state = match load_license_state(&app) {
        Some(s) => s,
        None => {
            return Ok(serde_json::json!({
                "valid": false,
                "error": "No license found"
            }));
        }
    };

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
                        // store_id 검증
                        if let Some(meta) = &body.meta {
                            if meta.store_id != LEMON_SQUEEZY_STORE_ID {
                                return Ok(serde_json::json!({
                                    "valid": false,
                                    "error": "Invalid store"
                                }));
                            }
                            if meta.product_id != LEMON_SQUEEZY_PRODUCT_ID {
                                return Ok(serde_json::json!({
                                    "valid": false,
                                    "error": "Invalid product"
                                }));
                            }
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
