//! 저장 규칙 템플릿 데이터 모델.
//!
//! 템플릿은 규칙 목록이며, 각 규칙은 파일 분류(카테고리)·확장자 조건과
//! 타깃 폴더/파일명 템플릿으로 이루어진다. 첫 번째로 일치하는 규칙이 적용되고,
//! 어느 규칙에도 맞지 않는 파일은 원본 상대 경로 그대로 복사된다.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 카메라 미디어 파일 분류.
#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Hash, PartialOrd, Ord,
)]
#[serde(rename_all = "lowercase")]
pub enum MediaCategory {
    /// 저해상도 프록시 영상 (Sony M4ROOT/SUB, GoPro LRV, DJI LRF 등)
    Proxy,
    /// 원본 동영상
    Video,
    /// RAW 사진
    Raw,
    /// JPG/HEIF 등 일반 사진 결과물
    Image,
    /// XML/XMP/THM 등 사이드카 메타데이터
    Metadata,
    /// 그 외
    Other,
}

impl MediaCategory {
    pub const ALL: [MediaCategory; 6] = [
        MediaCategory::Proxy,
        MediaCategory::Video,
        MediaCategory::Raw,
        MediaCategory::Image,
        MediaCategory::Metadata,
        MediaCategory::Other,
    ];

    pub fn key(self) -> &'static str {
        match self {
            MediaCategory::Proxy => "proxy",
            MediaCategory::Video => "video",
            MediaCategory::Raw => "raw",
            MediaCategory::Image => "image",
            MediaCategory::Metadata => "metadata",
            MediaCategory::Other => "other",
        }
    }
}

/// `{category}` 토큰이 렌더링될 때 쓰는 카테고리별 폴더 이름.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryNames {
    #[serde(default = "default_proxy_name")]
    pub proxy: String,
    #[serde(default = "default_video_name")]
    pub video: String,
    #[serde(default = "default_raw_name")]
    pub raw: String,
    #[serde(default = "default_image_name")]
    pub image: String,
    #[serde(default = "default_metadata_name")]
    pub metadata: String,
    #[serde(default = "default_other_name")]
    pub other: String,
}

fn default_proxy_name() -> String {
    "Proxy".to_string()
}
fn default_video_name() -> String {
    "Video".to_string()
}
fn default_raw_name() -> String {
    "RAW".to_string()
}
fn default_image_name() -> String {
    "Photo".to_string()
}
fn default_metadata_name() -> String {
    "Metadata".to_string()
}
fn default_other_name() -> String {
    "Other".to_string()
}

impl Default for CategoryNames {
    fn default() -> Self {
        Self {
            proxy: default_proxy_name(),
            video: default_video_name(),
            raw: default_raw_name(),
            image: default_image_name(),
            metadata: default_metadata_name(),
            other: default_other_name(),
        }
    }
}

impl CategoryNames {
    pub fn name_for(&self, category: MediaCategory) -> &str {
        match category {
            MediaCategory::Proxy => &self.proxy,
            MediaCategory::Video => &self.video,
            MediaCategory::Raw => &self.raw,
            MediaCategory::Image => &self.image,
            MediaCategory::Metadata => &self.metadata,
            MediaCategory::Other => &self.other,
        }
    }
}

/// 날짜 토큰의 기준 시각.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum DateSource {
    /// 촬영 시각(EXIF DateTimeOriginal, MP4 생성 시각, Sony 사이드카 XML). 없으면 수정 시각.
    #[default]
    Capture,
    /// 파일 시스템 수정 시각만 사용.
    Modified,
}

/// MP4/MOV `mvhd` 생성 시각의 해석 방식.
///
/// 규격상 UTC이지만 많은 카메라가 현지 시각을 그대로 기록하므로 기본값은 `Local`이다.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum VideoTimestampMode {
    /// 기록된 값을 현지 시각으로 그대로 사용.
    #[default]
    Local,
    /// 기록된 값을 UTC로 보고 이 Mac의 시간대로 변환.
    Utc,
}

/// 하나의 저장 규칙: 조건(카테고리·확장자)과 폴더/파일명 템플릿.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveRule {
    /// 비어 있으면 모든 카테고리에 일치.
    #[serde(default)]
    pub categories: Vec<MediaCategory>,
    /// 비어 있으면 모든 확장자에 일치. 점 없이 대소문자 무관.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// 타깃 루트 기준 폴더 템플릿. 비어 있으면 타깃 루트 바로 아래.
    #[serde(default)]
    pub folder: String,
    /// 파일명 템플릿. 원본 확장자가 빠져 있으면 자동으로 덧붙인다.
    #[serde(default = "default_file_name_template")]
    pub file_name: String,
}

pub fn default_file_name_template() -> String {
    "{name}.{ext}".to_string()
}

impl Default for SaveRule {
    fn default() -> Self {
        Self {
            categories: Vec::new(),
            extensions: Vec::new(),
            folder: String::new(),
            file_name: default_file_name_template(),
        }
    }
}

/// 저장 규칙 템플릿 레코드 (`save_rule_templates.yaml`에 저장).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveRuleTemplateRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 앱이 제공하는 기본 템플릿 여부. 편집은 가능하지만 삭제하면 초기화 시 복원된다.
    #[serde(default)]
    pub built_in: bool,
    #[serde(default)]
    pub date_source: DateSource,
    #[serde(default)]
    pub video_timestamp: VideoTimestampMode,
    #[serde(default)]
    pub category_names: CategoryNames,
    #[serde(default)]
    pub rules: Vec<SaveRule>,
}

impl SaveRuleTemplateRecord {
    /// 템플릿 전체가 카메라 메타데이터(EXIF 등)를 필요로 하는지.
    pub fn needs_capture_metadata(&self) -> bool {
        self.rules
            .iter()
            .any(|rule| super::template::needs_capture_metadata(self.date_source, rule))
    }
}
