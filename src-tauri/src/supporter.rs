use serde::Serialize;
use tauri::AppHandle;

use crate::apple_bridge;
use crate::distribution::{channel_policy, detect_distribution_channel, DistributionChannel};
use crate::license_validation;

const APP_STORE_SUPPORTER_PRODUCT_ID: &str = "dev.studiojin.syncwatcher.lifetime_supporter";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupporterStatus {
    pub is_registered: bool,
    pub provider: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupporterPurchaseResponse {
    pub success: bool,
    pub is_registered: bool,
    pub cancelled: bool,
    pub pending: bool,
    pub error: Option<String>,
}

fn supporter_status_for_channel(
    channel: DistributionChannel,
    is_registered: bool,
) -> SupporterStatus {
    let policy = channel_policy(channel);
    SupporterStatus {
        is_registered,
        provider: match policy.purchase_provider {
            crate::distribution::PurchaseProvider::LemonSqueezy => "lemon_squeezy",
            crate::distribution::PurchaseProvider::AppStore => "app_store",
        },
    }
}

pub async fn get_supporter_status_for_app(app: AppHandle) -> Result<SupporterStatus, String> {
    let channel = detect_distribution_channel(Some(&app));
    match channel {
        DistributionChannel::Github => {
            let status = license_validation::get_license_status(app).await?;
            Ok(supporter_status_for_channel(channel, status.is_registered))
        }
        DistributionChannel::AppStore => {
            let status =
                apple_bridge::get_app_store_supporter_status(APP_STORE_SUPPORTER_PRODUCT_ID)?;
            Ok(supporter_status_for_channel(channel, status.active))
        }
    }
}

pub async fn refresh_supporter_status_for_app(app: AppHandle) -> Result<SupporterStatus, String> {
    let channel = detect_distribution_channel(Some(&app));
    match channel {
        DistributionChannel::Github => {
            let result = license_validation::validate_license_key(app.clone()).await?;
            let is_registered = result
                .get("valid")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Ok(supporter_status_for_channel(channel, is_registered))
        }
        DistributionChannel::AppStore => get_supporter_status_for_app(app).await,
    }
}

pub async fn purchase_supporter_for_app(
    app: AppHandle,
) -> Result<SupporterPurchaseResponse, String> {
    let channel = detect_distribution_channel(Some(&app));
    let policy = channel_policy(channel);
    if !policy.supports_storekit_purchase {
        return Err(
            "Supporter purchases on the GitHub build are handled by Lemon Squeezy checkout."
                .to_string(),
        );
    }

    match channel {
        DistributionChannel::Github => Err(
            "Supporter purchases on the GitHub build are handled by Lemon Squeezy checkout."
                .to_string(),
        ),
        DistributionChannel::AppStore => {
            let result =
                apple_bridge::purchase_app_store_supporter(APP_STORE_SUPPORTER_PRODUCT_ID)?;
            Ok(SupporterPurchaseResponse {
                success: result.success,
                is_registered: result.active,
                cancelled: result.cancelled,
                pending: result.pending,
                error: result.error,
            })
        }
    }
}

pub async fn restore_supporter_for_app(
    app: AppHandle,
) -> Result<SupporterPurchaseResponse, String> {
    let channel = detect_distribution_channel(Some(&app));
    let policy = channel_policy(channel);
    if !policy.supports_storekit_restore {
        return Err("Supporter restore is only available for the Mac App Store build.".to_string());
    }

    match channel {
        DistributionChannel::Github => {
            Err("Supporter restore is only available for the Mac App Store build.".to_string())
        }
        DistributionChannel::AppStore => {
            let result = apple_bridge::restore_app_store_supporter(APP_STORE_SUPPORTER_PRODUCT_ID)?;
            Ok(SupporterPurchaseResponse {
                success: result.success,
                is_registered: result.active,
                cancelled: result.cancelled,
                pending: result.pending,
                error: result.error,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::supporter_status_for_channel;
    use crate::distribution::DistributionChannel;

    #[test]
    fn supporter_status_uses_provider_for_distribution_channel() {
        let github = supporter_status_for_channel(DistributionChannel::Github, true);
        assert!(github.is_registered);
        assert_eq!(github.provider, "lemon_squeezy");

        let app_store = supporter_status_for_channel(DistributionChannel::AppStore, false);
        assert!(!app_store.is_registered);
        assert_eq!(app_store.provider, "app_store");
    }
}
