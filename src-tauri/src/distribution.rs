use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub const DEFAULT_GITHUB_APP_IDENTIFIER: &str = "dev.studiojin.syncwatcher";
const DISTRIBUTION_CHANNEL_ENV: &str = "SYNCWATCHER_DISTRIBUTION_CHANNEL";
const APP_IDENTIFIER_ENV: &str = "SYNCWATCHER_APP_IDENTIFIER";
const APP_STORE_APP_ID_ENV: &str = "SYNCWATCHER_APP_STORE_APP_ID";
const APP_STORE_COUNTRY_ENV: &str = "SYNCWATCHER_APP_STORE_COUNTRY";
const DEFAULT_APP_STORE_COUNTRY: &str = "us";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DistributionChannel {
    Github,
    AppStore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PurchaseProvider {
    LemonSqueezy,
    AppStore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelPolicy {
    pub purchase_provider: PurchaseProvider,
    pub can_self_update: bool,
    pub supports_license_keys: bool,
    pub supports_external_checkout: bool,
    pub supports_storekit_purchase: bool,
    pub supports_storekit_restore: bool,
    pub requires_security_scoped_bookmarks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionInfo {
    pub channel: DistributionChannel,
    pub purchase_provider: PurchaseProvider,
    pub can_self_update: bool,
    pub app_store_app_id: Option<String>,
    pub app_store_country: String,
    pub app_store_url: Option<String>,
    pub legacy_import_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStoreUpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub store_url: Option<String>,
    pub manual_only: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AppleLookupResponse {
    #[serde(default)]
    results: Vec<AppleLookupResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleLookupResult {
    version: Option<String>,
    track_view_url: Option<String>,
}

fn compile_time_env(name: &str) -> Option<&'static str> {
    match name {
        DISTRIBUTION_CHANNEL_ENV => option_env!("SYNCWATCHER_DISTRIBUTION_CHANNEL"),
        APP_IDENTIFIER_ENV => option_env!("SYNCWATCHER_APP_IDENTIFIER"),
        APP_STORE_APP_ID_ENV => option_env!("SYNCWATCHER_APP_STORE_APP_ID"),
        APP_STORE_COUNTRY_ENV => option_env!("SYNCWATCHER_APP_STORE_COUNTRY"),
        _ => None,
    }
}

fn configured_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .or_else(|| compile_time_env(name).map(ToOwned::to_owned))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn configured_app_identifier() -> String {
    configured_env(APP_IDENTIFIER_ENV).unwrap_or_else(|| DEFAULT_GITHUB_APP_IDENTIFIER.to_string())
}

pub fn configured_app_store_app_id() -> Option<String> {
    configured_env(APP_STORE_APP_ID_ENV)
}

pub fn configured_app_store_country() -> String {
    configured_env(APP_STORE_COUNTRY_ENV).unwrap_or_else(|| DEFAULT_APP_STORE_COUNTRY.to_string())
}

pub fn app_store_url_for(app_id: &str, country: &str) -> String {
    format!(
        "https://apps.apple.com/{}/app/id{}",
        country.to_lowercase(),
        app_id
    )
}

pub fn distribution_channel_for_identifier(identifier: &str) -> DistributionChannel {
    if identifier.trim().ends_with(".appstore") {
        DistributionChannel::AppStore
    } else {
        DistributionChannel::Github
    }
}

pub fn detect_distribution_channel(app: Option<&AppHandle>) -> DistributionChannel {
    if let Some(handle) = app {
        return distribution_channel_for_identifier(handle.config().identifier.as_str());
    }

    if let Some(configured) = configured_env(DISTRIBUTION_CHANNEL_ENV) {
        let normalized = configured.trim().to_ascii_lowercase();
        if normalized == "app_store" || normalized == "appstore" || normalized == "mas" {
            return DistributionChannel::AppStore;
        }
        if normalized == "github" || normalized == "dmg" {
            return DistributionChannel::Github;
        }
    }

    distribution_channel_for_identifier(&configured_app_identifier())
}

pub fn purchase_provider_for(channel: DistributionChannel) -> PurchaseProvider {
    channel_policy(channel).purchase_provider
}

pub fn channel_policy(channel: DistributionChannel) -> ChannelPolicy {
    match channel {
        DistributionChannel::Github => ChannelPolicy {
            purchase_provider: PurchaseProvider::LemonSqueezy,
            can_self_update: true,
            supports_license_keys: true,
            supports_external_checkout: true,
            supports_storekit_purchase: false,
            supports_storekit_restore: false,
            requires_security_scoped_bookmarks: false,
        },
        DistributionChannel::AppStore => ChannelPolicy {
            purchase_provider: PurchaseProvider::AppStore,
            can_self_update: false,
            supports_license_keys: false,
            supports_external_checkout: false,
            supports_storekit_purchase: true,
            supports_storekit_restore: true,
            requires_security_scoped_bookmarks: true,
        },
    }
}

pub fn distribution_info(app: &AppHandle, legacy_import_available: bool) -> DistributionInfo {
    let channel = detect_distribution_channel(Some(app));
    let policy = channel_policy(channel);
    let app_store_app_id = configured_app_store_app_id();
    let app_store_country = configured_app_store_country();
    let app_store_url = app_store_app_id
        .as_deref()
        .map(|app_id| app_store_url_for(app_id, &app_store_country));

    DistributionInfo {
        channel,
        purchase_provider: policy.purchase_provider,
        can_self_update: policy.can_self_update,
        app_store_app_id,
        app_store_country,
        app_store_url,
        legacy_import_available,
    }
}

pub async fn check_app_store_update(app: &AppHandle) -> AppStoreUpdateCheckResult {
    let current_version = app.package_info().version.to_string();
    let channel = detect_distribution_channel(Some(app));
    let policy = channel_policy(channel);

    if policy.can_self_update {
        return AppStoreUpdateCheckResult {
            available: false,
            current_version,
            latest_version: None,
            store_url: None,
            manual_only: false,
            error: Some(
                "App Store update checks are only available for the Mac App Store build."
                    .to_string(),
            ),
        };
    }

    let Some(app_store_app_id) = configured_app_store_app_id() else {
        return AppStoreUpdateCheckResult {
            available: false,
            current_version,
            latest_version: None,
            store_url: None,
            manual_only: true,
            error: Some("Mac App Store app ID is not configured.".to_string()),
        };
    };

    let app_store_country = configured_app_store_country();
    let fallback_store_url = app_store_url_for(&app_store_app_id, &app_store_country);
    let lookup_url = format!(
        "https://itunes.apple.com/lookup?id={}&country={}&entity=macSoftware",
        app_store_app_id, app_store_country
    );

    let response = match reqwest::get(&lookup_url).await {
        Ok(response) => response,
        Err(error) => {
            return AppStoreUpdateCheckResult {
                available: false,
                current_version,
                latest_version: None,
                store_url: Some(fallback_store_url),
                manual_only: true,
                error: Some(format!("Failed to query App Store metadata: {error}")),
            };
        }
    };

    let lookup_payload = match response.json::<AppleLookupResponse>().await {
        Ok(payload) => payload,
        Err(error) => {
            return AppStoreUpdateCheckResult {
                available: false,
                current_version,
                latest_version: None,
                store_url: Some(fallback_store_url),
                manual_only: true,
                error: Some(format!("Failed to decode App Store metadata: {error}")),
            };
        }
    };

    let Some(result) = lookup_payload.results.into_iter().next() else {
        return AppStoreUpdateCheckResult {
            available: false,
            current_version,
            latest_version: None,
            store_url: Some(fallback_store_url),
            manual_only: true,
            error: Some("App Store metadata did not return a matching app.".to_string()),
        };
    };

    let latest_version = result
        .version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let store_url = result
        .track_view_url
        .filter(|value| !value.trim().is_empty())
        .or_else(|| Some(fallback_store_url));
    let available = latest_version
        .as_deref()
        .is_some_and(|remote| compare_version_strings(remote, &current_version).is_gt());

    AppStoreUpdateCheckResult {
        available,
        current_version,
        latest_version,
        store_url,
        manual_only: true,
        error: None,
    }
}

fn compare_version_strings(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let normalize = |value: &str| {
        value
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .filter(|segment| !segment.is_empty())
            .map(|segment| segment.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };

    let left_segments = normalize(left);
    let right_segments = normalize(right);
    let max_len = left_segments.len().max(right_segments.len());

    for index in 0..max_len {
        let left_value = left_segments.get(index).copied().unwrap_or(0);
        let right_value = right_segments.get(index).copied().unwrap_or(0);
        match left_value.cmp(&right_value) {
            Ordering::Equal => continue,
            ordering => return ordering,
        }
    }

    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::{
        channel_policy, compare_version_strings, distribution_channel_for_identifier,
        DistributionChannel, PurchaseProvider,
    };
    use std::cmp::Ordering;

    #[test]
    fn compares_semver_like_versions() {
        assert_eq!(compare_version_strings("1.4.2", "1.4.1"), Ordering::Greater);
        assert_eq!(compare_version_strings("1.4.1", "1.4.1"), Ordering::Equal);
        assert_eq!(compare_version_strings("1.4.0", "1.4.1"), Ordering::Less);
        assert_eq!(compare_version_strings("1.10", "1.9.9"), Ordering::Greater);
    }

    #[test]
    fn detects_distribution_channel_from_identifier() {
        assert_eq!(
            distribution_channel_for_identifier("dev.studiojin.syncwatcher"),
            DistributionChannel::Github
        );
        assert_eq!(
            distribution_channel_for_identifier("dev.studiojin.syncwatcher.appstore"),
            DistributionChannel::AppStore
        );
    }

    #[test]
    fn channel_policy_matches_distribution_constraints() {
        let github = channel_policy(DistributionChannel::Github);
        assert_eq!(github.purchase_provider, PurchaseProvider::LemonSqueezy);
        assert!(github.can_self_update);
        assert!(github.supports_license_keys);
        assert!(github.supports_external_checkout);
        assert!(!github.supports_storekit_purchase);
        assert!(!github.requires_security_scoped_bookmarks);

        let app_store = channel_policy(DistributionChannel::AppStore);
        assert_eq!(app_store.purchase_provider, PurchaseProvider::AppStore);
        assert!(!app_store.can_self_update);
        assert!(!app_store.supports_license_keys);
        assert!(!app_store.supports_external_checkout);
        assert!(app_store.supports_storekit_purchase);
        assert!(app_store.supports_storekit_restore);
        assert!(app_store.requires_security_scoped_bookmarks);
    }
}
