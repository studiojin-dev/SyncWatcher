//! GitHub DMG 채널의 앱 자체 업데이트 확인.
//!
//! 안정 채널은 `tauri.conf.json`에 설정된 `releases/latest/download/latest.json`
//! 엔드포인트를 그대로 사용한다. 베타 채널은 GitHub Releases API로 draft가 아닌
//! 릴리스 목록을 읽고, `latest.json` 자산이 있는 릴리스 중 semver가 가장 높은 태그의
//! 매니페스트를 엔드포인트로 사용한다. pre-release와 안정 릴리스를 함께 비교하므로
//! 안정 버전이 베타를 추월하면 베타 사용자도 자동으로 안정 버전으로 돌아온다.
//!
//! Mac App Store 빌드에서는 updater 플러그인이 등록되지 않으므로 이 모듈의 명령은
//! 호출되기 전에 배포 채널 정책으로 거부된다(ADR-20260401-0021-MAS).

use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{Manager, Url, Webview};
use tauri_plugin_updater::UpdaterExt;

use crate::config_store::UpdateChannel;
use crate::distribution;

/// GitHub 릴리스 저장소(`owner/repo`). `tauri.conf.json`의 updater 엔드포인트와 같은 저장소다.
pub const GITHUB_RELEASES_REPO: &str = "studiojin-dev/SyncWatcher";
const UPDATER_MANIFEST_ASSET_NAME: &str = "latest.json";
const GITHUB_RELEASES_PAGE_SIZE: u32 = 30;
const GITHUB_API_TIMEOUT: Duration = Duration::from_secs(20);
const UPDATER_CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// 프런트엔드에서 `new Update(metadata)`로 복원할 수 있도록 updater 플러그인의
/// `Metadata`와 같은 camelCase 필드를 노출한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateMetadata {
    pub rid: tauri::ResourceId,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
    /// 실제로 조회한 채널. 베타 해석에 실패해 안정 엔드포인트로 대체한 경우 `stable`이다.
    pub channel: UpdateChannel,
    /// 조회에 사용한 매니페스트 URL(디버깅·로그용).
    pub endpoint: String,
}

/// GitHub Releases API 응답 중 채널 해석에 필요한 필드만 추린 후보.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseCandidate {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub has_updater_manifest: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
}

impl From<GitHubRelease> for ReleaseCandidate {
    fn from(release: GitHubRelease) -> Self {
        let has_updater_manifest = release
            .assets
            .iter()
            .any(|asset| asset.name == UPDATER_MANIFEST_ASSET_NAME);
        ReleaseCandidate {
            tag_name: release.tag_name,
            draft: release.draft,
            prerelease: release.prerelease,
            has_updater_manifest,
        }
    }
}

/// `vX.Y.Z[-pre]` 형태의 릴리스 태그를 semver로 파싱한다. 형식이 다르면 `None`.
pub fn parse_release_tag(tag: &str) -> Option<Version> {
    let trimmed = tag.trim();
    let without_prefix = trimmed.strip_prefix('v').unwrap_or(trimmed);
    Version::parse(without_prefix).ok()
}

/// 베타 채널이 바라볼 릴리스 태그를 고른다.
///
/// - draft 릴리스와 `latest.json`이 없는 릴리스는 제외한다.
/// - semver로 파싱되지 않는 태그는 제외한다.
/// - 남은 후보 중 semver가 가장 높은 태그를 돌려준다. pre-release와 안정 릴리스를 함께
///   비교하므로 `2.2.0`이 나오면 `2.2.0-beta.3`보다 우선한다.
pub fn select_beta_release_tag(releases: &[ReleaseCandidate]) -> Option<String> {
    releases
        .iter()
        .filter(|release| !release.draft && release.has_updater_manifest)
        .filter_map(|release| {
            parse_release_tag(&release.tag_name).map(|version| (version, release.tag_name.clone()))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, tag)| tag)
}

pub fn stable_manifest_url(repo: &str) -> String {
    format!("https://github.com/{repo}/releases/latest/download/{UPDATER_MANIFEST_ASSET_NAME}")
}

pub fn release_manifest_url(repo: &str, tag: &str) -> String {
    format!("https://github.com/{repo}/releases/download/{tag}/{UPDATER_MANIFEST_ASSET_NAME}")
}

async fn fetch_release_candidates(
    repo: &str,
    user_agent: &str,
) -> Result<Vec<ReleaseCandidate>, String> {
    let client = reqwest::Client::builder()
        .timeout(GITHUB_API_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;
    let url = format!(
        "https://api.github.com/repos/{repo}/releases?per_page={GITHUB_RELEASES_PAGE_SIZE}"
    );
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, user_agent)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("Failed to query GitHub releases: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub releases API returned HTTP {status}"));
    }
    let releases: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse GitHub releases response: {error}"))?;
    Ok(releases.into_iter().map(ReleaseCandidate::from).collect())
}

/// 베타 채널의 매니페스트 URL을 해석한다. 적합한 릴리스가 없으면 `Ok(None)`.
async fn resolve_beta_manifest_url(repo: &str, user_agent: &str) -> Result<Option<String>, String> {
    let releases = fetch_release_candidates(repo, user_agent).await?;
    Ok(select_beta_release_tag(&releases).map(|tag| release_manifest_url(repo, &tag)))
}

/// 현재 배포 채널 정책에 따라 업데이트를 확인하고, 발견한 업데이트를 webview 리소스
/// 테이블에 등록한 뒤 플러그인 호환 메타데이터를 돌려준다. 이후 다운로드·설치는
/// 프런트엔드가 `@tauri-apps/plugin-updater`의 `Update` 객체로 그대로 진행한다.
pub async fn check_for_app_update(
    webview: Webview,
    requested_channel: UpdateChannel,
) -> Result<Option<AppUpdateMetadata>, String> {
    let app = webview.app_handle();
    let distribution_channel = distribution::detect_distribution_channel(Some(app));
    if !distribution::channel_policy(distribution_channel).can_self_update {
        return Err(
            "Self-update is not available for this distribution channel. Use the App Store."
                .to_string(),
        );
    }

    let current_version = app.package_info().version.to_string();
    let user_agent =
        format!("SyncWatcher/{current_version} (+https://github.com/{GITHUB_RELEASES_REPO})");

    let mut effective_channel = requested_channel;
    let mut endpoint_override: Option<String> = None;
    if requested_channel == UpdateChannel::Beta {
        match resolve_beta_manifest_url(GITHUB_RELEASES_REPO, &user_agent).await {
            Ok(Some(url)) => endpoint_override = Some(url),
            Ok(None) => {
                eprintln!(
                    "[AppUpdate] No GitHub release with {UPDATER_MANIFEST_ASSET_NAME} found; falling back to the stable endpoint."
                );
                effective_channel = UpdateChannel::Stable;
            }
            Err(error) => {
                eprintln!(
                    "[AppUpdate] Beta channel resolution failed ({error}); falling back to the stable endpoint."
                );
                effective_channel = UpdateChannel::Stable;
            }
        }
    }

    let mut builder = app.updater_builder().timeout(UPDATER_CHECK_TIMEOUT);
    let endpoint = match endpoint_override {
        Some(url) => {
            let parsed = Url::parse(&url)
                .map_err(|error| format!("Invalid updater endpoint {url}: {error}"))?;
            builder = builder
                .endpoints(vec![parsed])
                .map_err(|error| format!("Rejected updater endpoint {url}: {error}"))?;
            url
        }
        None => stable_manifest_url(GITHUB_RELEASES_REPO),
    };

    eprintln!(
        "[AppUpdate] Checking {effective_channel:?} channel (requested {requested_channel:?}) via {endpoint}"
    );
    let updater = builder
        .build()
        .map_err(|error| format!("Failed to initialise updater: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Update check failed: {error}"))?;

    let Some(update) = update else {
        return Ok(None);
    };

    let date = update
        .raw_json
        .get("pub_date")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned);
    let metadata = AppUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        channel: effective_channel,
        endpoint,
        rid: webview.resources_table().add(update),
    };
    Ok(Some(metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(tag: &str, draft: bool, prerelease: bool, manifest: bool) -> ReleaseCandidate {
        ReleaseCandidate {
            tag_name: tag.to_string(),
            draft,
            prerelease,
            has_updater_manifest: manifest,
        }
    }

    #[test]
    fn parses_release_tags_with_and_without_prefix() {
        assert_eq!(parse_release_tag("v2.1.0"), Some(Version::new(2, 1, 0)));
        assert_eq!(parse_release_tag("2.1.0"), Some(Version::new(2, 1, 0)));
        assert!(parse_release_tag("v2.2.0-beta.1").is_some());
        assert!(parse_release_tag("nightly").is_none());
        assert!(parse_release_tag("v2.2").is_none());
    }

    #[test]
    fn beta_channel_prefers_newest_prerelease_over_older_stable() {
        let releases = vec![
            candidate("v2.2.0-beta.1", false, true, true),
            candidate("v2.1.0", false, false, true),
            candidate("v2.0.0", false, false, true),
        ];
        assert_eq!(
            select_beta_release_tag(&releases).as_deref(),
            Some("v2.2.0-beta.1")
        );
    }

    #[test]
    fn beta_channel_returns_to_stable_once_it_overtakes_prereleases() {
        let releases = vec![
            candidate("v2.2.0-beta.2", false, true, true),
            candidate("v2.2.0", false, false, true),
            candidate("v2.2.0-rc1", false, true, true),
        ];
        assert_eq!(
            select_beta_release_tag(&releases).as_deref(),
            Some("v2.2.0")
        );
    }

    #[test]
    fn beta_channel_orders_prereleases_by_semver_not_creation_order() {
        let releases = vec![
            candidate("v2.2.0-beta.2", false, true, true),
            candidate("v2.2.0-beta.10", false, true, true),
            candidate("v2.2.0-rc1", false, true, true),
        ];
        assert_eq!(
            select_beta_release_tag(&releases).as_deref(),
            Some("v2.2.0-rc1")
        );

        let only_betas = vec![
            candidate("v2.2.0-beta.2", false, true, true),
            candidate("v2.2.0-beta.10", false, true, true),
        ];
        assert_eq!(
            select_beta_release_tag(&only_betas).as_deref(),
            Some("v2.2.0-beta.10")
        );
    }

    #[test]
    fn beta_channel_skips_drafts_manifestless_and_unparseable_releases() {
        let releases = vec![
            candidate("v3.0.0-beta.1", true, true, true),
            candidate("v2.3.0-beta.1", false, true, false),
            candidate("nightly-2026-10-22", false, true, true),
            candidate("v2.2.0-beta.1", false, true, true),
        ];
        assert_eq!(
            select_beta_release_tag(&releases).as_deref(),
            Some("v2.2.0-beta.1")
        );
    }

    #[test]
    fn beta_channel_has_no_target_without_eligible_release() {
        let releases = vec![
            candidate("v3.0.0-beta.1", true, true, true),
            candidate("v2.3.0-beta.1", false, true, false),
        ];
        assert_eq!(select_beta_release_tag(&releases), None);
        assert_eq!(select_beta_release_tag(&[]), None);
    }

    #[test]
    fn manifest_urls_match_github_release_layout() {
        assert_eq!(
            stable_manifest_url("studiojin-dev/SyncWatcher"),
            "https://github.com/studiojin-dev/SyncWatcher/releases/latest/download/latest.json"
        );
        assert_eq!(
            release_manifest_url("studiojin-dev/SyncWatcher", "v2.2.0-beta.1"),
            "https://github.com/studiojin-dev/SyncWatcher/releases/download/v2.2.0-beta.1/latest.json"
        );
    }

    #[test]
    fn release_candidates_detect_updater_manifest_asset() {
        let release = GitHubRelease {
            tag_name: "v2.2.0-beta.1".to_string(),
            draft: false,
            prerelease: true,
            assets: vec![
                GitHubReleaseAsset {
                    name: "Sync.Watcher_2.2.0-beta.1_aarch64.dmg".to_string(),
                },
                GitHubReleaseAsset {
                    name: "latest.json".to_string(),
                },
            ],
        };
        let candidate = ReleaseCandidate::from(release);
        assert!(candidate.has_updater_manifest);
        assert!(candidate.prerelease);
    }
}
