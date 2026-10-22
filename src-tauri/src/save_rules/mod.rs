//! 규칙 기반 저장(저장 규칙 템플릿).
//!
//! 소스 상대 경로 + 파일 메타데이터 → 타깃 상대 경로를 결정한다.
//! 템플릿이 없는 작업은 기존처럼 원본 상대 경로를 그대로 쓴다.

pub mod classify;
pub mod exif;
pub mod isobmff;
pub mod metadata;
pub mod template;
pub mod types;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::NaiveDateTime;

pub use classify::classify;
pub use metadata::{read_media_metadata, MediaMetadata};
pub use types::{
    CategoryNames, DateSource, MediaCategory, SaveRule, SaveRuleTemplateRecord, VideoTimestampMode,
};

/// 템플릿당 최대 규칙 수.
pub const MAX_RULES_PER_TEMPLATE: usize = 64;
/// 템플릿 이름 최대 길이.
const MAX_NAME_LENGTH: usize = 120;
/// 설명 최대 길이.
const MAX_DESCRIPTION_LENGTH: usize = 1000;
/// 규칙당 최대 확장자 수.
const MAX_EXTENSIONS_PER_RULE: usize = 64;

/// 템플릿 내용을 검증한다 (ID 검증은 호출자가 `validate_task_id`로 수행).
pub fn validate_template(template: &SaveRuleTemplateRecord) -> Result<(), String> {
    if template.name.trim().is_empty() {
        return Err("Save rule template name cannot be empty".to_string());
    }
    if template.name.len() > MAX_NAME_LENGTH {
        return Err(format!(
            "Save rule template name too long (max {MAX_NAME_LENGTH})"
        ));
    }
    if template.description.len() > MAX_DESCRIPTION_LENGTH {
        return Err(format!(
            "Save rule template description too long (max {MAX_DESCRIPTION_LENGTH})"
        ));
    }
    if template.rules.is_empty() {
        return Err("Save rule template needs at least one rule".to_string());
    }
    if template.rules.len() > MAX_RULES_PER_TEMPLATE {
        return Err(format!(
            "Too many rules: {} (max {MAX_RULES_PER_TEMPLATE})",
            template.rules.len()
        ));
    }
    for category in MediaCategory::ALL {
        let name = template.category_names.name_for(category);
        template::validate_template(name, false)
            .map_err(|error| format!("Invalid category name for {}: {error}", category.key()))?;
        if template::tokens_in(name).contains(&template::Token::Category) {
            return Err("Category names must not use the {category} token".to_string());
        }
    }
    for (index, rule) in template.rules.iter().enumerate() {
        let position = index + 1;
        if rule.extensions.len() > MAX_EXTENSIONS_PER_RULE {
            return Err(format!(
                "Rule {position}: too many extensions (max {MAX_EXTENSIONS_PER_RULE})"
            ));
        }
        for extension in &rule.extensions {
            let trimmed = extension.trim().trim_start_matches('.');
            if trimmed.is_empty()
                || trimmed.len() > 16
                || !trimmed
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(format!("Rule {position}: invalid extension '{extension}'"));
            }
        }
        template::validate_template(&rule.folder, true)
            .map_err(|error| format!("Rule {position} folder: {error}"))?;
        if rule.file_name.trim().is_empty() {
            return Err(format!(
                "Rule {position}: file name template cannot be empty"
            ));
        }
        template::validate_template(&rule.file_name, false)
            .map_err(|error| format!("Rule {position} file name: {error}"))?;
    }
    Ok(())
}

/// 규칙의 확장자 목록을 소문자·점 없이 정규화한다.
fn normalize_extensions(extensions: &[String]) -> Vec<String> {
    extensions
        .iter()
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

/// 저장 시 템플릿을 정규화한다 (확장자 소문자화, 공백 정리).
pub fn normalize_template(mut template: SaveRuleTemplateRecord) -> SaveRuleTemplateRecord {
    template.name = template.name.trim().to_string();
    template.description = template.description.trim().to_string();
    for rule in &mut template.rules {
        rule.extensions = normalize_extensions(&rule.extensions);
        rule.folder = rule.folder.trim().to_string();
        rule.file_name = rule.file_name.trim().to_string();
        if rule.file_name.is_empty() {
            rule.file_name = types::default_file_name_template();
        }
    }
    template
}

struct CompiledRule {
    categories: Vec<MediaCategory>,
    extensions: Vec<String>,
    folder: String,
    file_name: String,
    needs_capture_metadata: bool,
}

impl CompiledRule {
    fn matches(&self, category: MediaCategory, extension: &str) -> bool {
        (self.categories.is_empty() || self.categories.contains(&category))
            && (self.extensions.is_empty() || self.extensions.iter().any(|e| e == extension))
    }
}

/// 소스 상대 경로를 타깃 상대 경로로 바꾸는 매퍼.
pub struct SaveRuleMapper {
    date_source: DateSource,
    video_timestamp: VideoTimestampMode,
    category_names: CategoryNames,
    rules: Vec<CompiledRule>,
}

/// 하나의 파일에 대한 매핑 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedPath {
    pub target_relative: PathBuf,
    pub category: MediaCategory,
}

impl SaveRuleMapper {
    pub fn new(template: &SaveRuleTemplateRecord) -> Result<Self, String> {
        validate_template(template)?;
        let rules = template
            .rules
            .iter()
            .map(|rule| CompiledRule {
                categories: rule.categories.clone(),
                extensions: normalize_extensions(&rule.extensions),
                folder: rule.folder.clone(),
                file_name: rule.file_name.clone(),
                needs_capture_metadata: template::needs_capture_metadata(
                    template.date_source,
                    rule,
                ),
            })
            .collect();
        Ok(Self {
            date_source: template.date_source,
            video_timestamp: template.video_timestamp,
            category_names: template.category_names.clone(),
            rules,
        })
    }

    /// 파일 하나를 매핑한다. `source_path`는 메타데이터를 읽을 절대 경로, `relative`는 소스 루트 기준 경로.
    /// 어느 규칙에도 맞지 않으면 원본 상대 경로를 그대로 돌려준다.
    pub fn map(
        &self,
        source_path: &Path,
        relative: &Path,
        modified: Option<SystemTime>,
    ) -> MappedPath {
        let category = classify(relative);
        let extension = classify::lowercase_extension(relative);
        let Some(rule) = self
            .rules
            .iter()
            .find(|rule| rule.matches(category, &extension))
        else {
            return MappedPath {
                target_relative: relative.to_path_buf(),
                category,
            };
        };

        let metadata = if rule.needs_capture_metadata {
            read_media_metadata(source_path, self.video_timestamp)
        } else {
            MediaMetadata::default()
        };
        let modified_naive = modified.and_then(metadata::system_time_to_local_naive);
        let timestamp = self.resolve_timestamp(&metadata, modified_naive);

        let input = template::RenderInput {
            relative_path: relative,
            category,
            category_name: self.category_names.name_for(category),
            timestamp,
            metadata: &metadata,
        };
        let folder = template::render_folder(&rule.folder, &input).unwrap_or_default();
        let file_name = template::render_file_name(&rule.file_name, &input).unwrap_or_else(|_| {
            relative
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default()
        });
        let target_relative = folder.join(file_name);
        if !template::is_safe_relative_path(&target_relative) {
            return MappedPath {
                target_relative: relative.to_path_buf(),
                category,
            };
        }
        MappedPath {
            target_relative,
            category,
        }
    }

    fn resolve_timestamp(
        &self,
        metadata: &MediaMetadata,
        modified: Option<NaiveDateTime>,
    ) -> NaiveDateTime {
        let fallback = modified.unwrap_or_else(|| {
            metadata::system_time_to_local_naive(SystemTime::now())
                .unwrap_or_else(|| chrono::DateTime::UNIX_EPOCH.naive_utc())
        });
        match self.date_source {
            DateSource::Capture => metadata.captured_at.unwrap_or(fallback),
            DateSource::Modified => fallback,
        }
    }
}

/// 같은 타깃 경로로 매핑된 파일에 `_2`, `_3` … 접미사를 붙여 충돌을 피한다.
/// 입력 순서가 결정적(정렬된 소스 경로)이면 결과도 결정적이다.
#[derive(Default)]
pub struct CollisionResolver {
    taken: HashMap<PathBuf, PathBuf>,
}

impl CollisionResolver {
    pub fn resolve(&mut self, source_relative: &Path, target_relative: PathBuf) -> PathBuf {
        if !self.taken.contains_key(&target_relative) {
            self.taken
                .insert(target_relative.clone(), source_relative.to_path_buf());
            return target_relative;
        }
        let parent = target_relative.parent().map(Path::to_path_buf);
        let stem = target_relative
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let extension = target_relative
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default();
        for index in 2u32.. {
            let candidate_name = format!("{stem}_{index}{extension}");
            let candidate = match &parent {
                Some(parent) => parent.join(&candidate_name),
                None => PathBuf::from(&candidate_name),
            };
            if !self.taken.contains_key(&candidate) {
                self.taken
                    .insert(candidate.clone(), source_relative.to_path_buf());
                return candidate;
            }
        }
        unreachable!("collision resolver exhausted u32 range")
    }
}

/// 기본 제공 템플릿 ID.
pub const PRESET_CAMERA_BY_TYPE: &str = "camera-by-type";
pub const PRESET_CAMERA_BY_DATE_TYPE: &str = "camera-by-date-type";
pub const PRESET_CAMERA_BY_DATE: &str = "camera-by-date";
pub const PRESET_CAMERA_DATED_FILENAMES: &str = "camera-dated-filenames";

fn camera_rules(folder_prefix: &str, file_name: &str) -> Vec<SaveRule> {
    let folder = |category_folder: &str| {
        if folder_prefix.is_empty() {
            category_folder.to_string()
        } else {
            format!("{folder_prefix}/{category_folder}")
        }
    };
    vec![
        SaveRule {
            categories: vec![MediaCategory::Proxy],
            extensions: Vec::new(),
            folder: folder("{category}"),
            file_name: file_name.to_string(),
        },
        SaveRule {
            categories: vec![MediaCategory::Video],
            extensions: Vec::new(),
            folder: folder("{category}"),
            file_name: file_name.to_string(),
        },
        SaveRule {
            categories: vec![MediaCategory::Raw],
            extensions: Vec::new(),
            folder: folder("{category}"),
            file_name: file_name.to_string(),
        },
        SaveRule {
            categories: vec![MediaCategory::Image],
            extensions: Vec::new(),
            folder: folder("{category}"),
            file_name: file_name.to_string(),
        },
        SaveRule {
            categories: vec![MediaCategory::Metadata],
            extensions: Vec::new(),
            folder: folder("{category}"),
            file_name: "{name}.{ext}".to_string(),
        },
        SaveRule {
            categories: vec![MediaCategory::Other],
            extensions: Vec::new(),
            folder: folder("{category}/{path}"),
            file_name: "{name}.{ext}".to_string(),
        },
    ]
}

/// 앱이 제공하는 기본 템플릿들.
pub fn built_in_templates() -> Vec<SaveRuleTemplateRecord> {
    vec![
        SaveRuleTemplateRecord {
            id: PRESET_CAMERA_BY_TYPE.to_string(),
            name: "Camera: by file type".to_string(),
            description: "Proxy / Video / RAW / Photo / Metadata folders, original file names."
                .to_string(),
            built_in: true,
            date_source: DateSource::Capture,
            video_timestamp: VideoTimestampMode::Local,
            category_names: CategoryNames::default(),
            rules: camera_rules("", "{name}.{ext}"),
        },
        SaveRuleTemplateRecord {
            id: PRESET_CAMERA_BY_DATE_TYPE.to_string(),
            name: "Camera: by capture date, then type".to_string(),
            description: "YYYY-MM-DD/<type>/ folders from the capture date, original file names."
                .to_string(),
            built_in: true,
            date_source: DateSource::Capture,
            video_timestamp: VideoTimestampMode::Local,
            category_names: CategoryNames::default(),
            rules: camera_rules("{yyyy}-{MM}-{dd}", "{name}.{ext}"),
        },
        SaveRuleTemplateRecord {
            id: PRESET_CAMERA_BY_DATE.to_string(),
            name: "Camera: by capture date".to_string(),
            description: "YYYY/YYYY-MM-DD/ folders from the capture date, all types together."
                .to_string(),
            built_in: true,
            date_source: DateSource::Capture,
            video_timestamp: VideoTimestampMode::Local,
            category_names: CategoryNames::default(),
            rules: vec![SaveRule {
                categories: Vec::new(),
                extensions: Vec::new(),
                folder: "{yyyy}/{yyyy}-{MM}-{dd}".to_string(),
                file_name: "{name}.{ext}".to_string(),
            }],
        },
        SaveRuleTemplateRecord {
            id: PRESET_CAMERA_DATED_FILENAMES.to_string(),
            name: "Camera: dated folders and file names".to_string(),
            description: "YYYY-MM-DD/<type>/ folders; files renamed to YYYYMMDD_HHMMSS_<original>."
                .to_string(),
            built_in: true,
            date_source: DateSource::Capture,
            video_timestamp: VideoTimestampMode::Local,
            category_names: CategoryNames::default(),
            rules: camera_rules("{yyyy}-{MM}-{dd}", "{datetime}_{name}.{ext}"),
        },
    ]
}

/// 미리보기용 샘플 파일.
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SaveRulePreviewEntry {
    pub source_path: String,
    pub target_path: String,
    pub category: MediaCategory,
}

/// 실제 파일 없이 고정 샘플 메타데이터로 템플릿을 미리 렌더링한다.
pub fn preview_template(
    template: &SaveRuleTemplateRecord,
) -> Result<Vec<SaveRulePreviewEntry>, String> {
    use chrono::NaiveDate;

    validate_template(template)?;
    let captured = NaiveDate::from_ymd_opt(2026, 10, 22)
        .and_then(|date| date.and_hms_opt(14, 3, 55))
        .ok_or_else(|| "invalid sample date".to_string())?;
    let camera = MediaMetadata {
        captured_at: Some(captured),
        make: Some("SONY".to_string()),
        model: Some("ILCE-7RM5".to_string()),
        body_serial: Some("03407347".to_string()),
        f_number: Some(exif::Rational {
            numerator: 28,
            denominator: 10,
        }),
        exposure_time: Some(exif::Rational {
            numerator: 1,
            denominator: 250,
        }),
        iso: Some(400),
        focal_length: Some(exif::Rational {
            numerator: 35,
            denominator: 1,
        }),
    };
    let video = MediaMetadata {
        captured_at: Some(captured),
        ..MediaMetadata::default()
    };
    let none = MediaMetadata::default();
    let samples: [(&str, &MediaMetadata); 7] = [
        ("DCIM/100MSDCF/DSC00001.ARW", &camera),
        ("DCIM/100MSDCF/DSC00001.JPG", &camera),
        ("DCIM/100MSDCF/DSC00002.HIF", &camera),
        ("PRIVATE/M4ROOT/CLIP/C0001.MP4", &video),
        ("PRIVATE/M4ROOT/SUB/C0001S03.MP4", &video),
        ("PRIVATE/M4ROOT/CLIP/C0001M01.XML", &none),
        ("notes/shotlist.pdf", &none),
    ];

    let compiled = SaveRuleMapper::new(template)?;
    let mut resolver = CollisionResolver::default();
    let mut entries = Vec::new();
    for (sample, metadata) in samples {
        let relative = PathBuf::from(sample);
        let category = classify(&relative);
        let extension = classify::lowercase_extension(&relative);
        let target = match compiled
            .rules
            .iter()
            .find(|rule| rule.matches(category, &extension))
        {
            None => relative.clone(),
            Some(rule) => {
                let timestamp = compiled.resolve_timestamp(metadata, Some(captured));
                let input = template::RenderInput {
                    relative_path: &relative,
                    category,
                    category_name: compiled.category_names.name_for(category),
                    timestamp,
                    metadata,
                };
                let folder = template::render_folder(&rule.folder, &input)?;
                let file_name = template::render_file_name(&rule.file_name, &input)?;
                let candidate = folder.join(file_name);
                if template::is_safe_relative_path(&candidate) {
                    candidate
                } else {
                    relative.clone()
                }
            }
        };
        let target = resolver.resolve(&relative, target);
        entries.push(SaveRulePreviewEntry {
            source_path: sample.to_string(),
            target_path: target.to_string_lossy().to_string(),
            category,
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_rules::exif::test_support::TiffBuilder;

    fn template_with_rules(rules: Vec<SaveRule>) -> SaveRuleTemplateRecord {
        SaveRuleTemplateRecord {
            id: "t".to_string(),
            name: "Test".to_string(),
            description: String::new(),
            built_in: false,
            date_source: DateSource::Capture,
            video_timestamp: VideoTimestampMode::Local,
            category_names: CategoryNames::default(),
            rules,
        }
    }

    #[test]
    fn built_in_templates_validate_and_preview() {
        for template in built_in_templates() {
            validate_template(&template).expect("built-in template must be valid");
            let preview = preview_template(&template).expect("preview");
            assert_eq!(preview.len(), 7);
        }
        let by_date_type = built_in_templates()
            .into_iter()
            .find(|t| t.id == PRESET_CAMERA_BY_DATE_TYPE)
            .unwrap();
        let preview = preview_template(&by_date_type).unwrap();
        assert_eq!(preview[0].target_path, "2026-10-22/RAW/DSC00001.ARW");
        assert_eq!(preview[3].target_path, "2026-10-22/Video/C0001.MP4");
        assert_eq!(preview[4].target_path, "2026-10-22/Proxy/C0001S03.MP4");
        assert_eq!(preview[5].target_path, "2026-10-22/Metadata/C0001M01.XML");
        assert_eq!(
            preview[6].target_path,
            "2026-10-22/Other/notes/shotlist.pdf"
        );

        let dated = built_in_templates()
            .into_iter()
            .find(|t| t.id == PRESET_CAMERA_DATED_FILENAMES)
            .unwrap();
        let preview = preview_template(&dated).unwrap();
        assert_eq!(
            preview[0].target_path,
            "2026-10-22/RAW/20261022_140355_DSC00001.ARW"
        );
    }

    #[test]
    fn mapper_reads_exif_from_file_and_falls_back_to_mtime() {
        let dir = tempfile::TempDir::new().unwrap();
        let source_root = dir.path();
        let raw_dir = source_root.join("DCIM/100MSDCF");
        std::fs::create_dir_all(&raw_dir).unwrap();
        let raw = raw_dir.join("DSC00001.ARW");
        std::fs::write(
            &raw,
            TiffBuilder {
                little_endian: true,
                model: Some("ILCE-7RM5".to_string()),
                date_time_original: Some("2025:03:04 05:06:07".to_string()),
                iso: Some(200),
                ..TiffBuilder::default()
            }
            .build(),
        )
        .unwrap();
        let other = source_root.join("readme.txt");
        std::fs::write(&other, b"hi").unwrap();

        let template = template_with_rules(vec![
            SaveRule {
                categories: vec![MediaCategory::Raw],
                extensions: Vec::new(),
                folder: "{yyyy}-{MM}-{dd}/{category}".to_string(),
                file_name: "{name}_{model}_{iso}.{ext}".to_string(),
            },
            SaveRule {
                categories: vec![MediaCategory::Other],
                extensions: Vec::new(),
                folder: "{yyyy}/misc".to_string(),
                file_name: "{name}.{ext}".to_string(),
            },
        ]);
        let mapper = SaveRuleMapper::new(&template).unwrap();
        let modified = std::fs::metadata(&raw).unwrap().modified().ok();
        let mapped = mapper.map(&raw, Path::new("DCIM/100MSDCF/DSC00001.ARW"), modified);
        assert_eq!(
            mapped.target_relative,
            PathBuf::from("2025-03-04/RAW/DSC00001_ILCE-7RM5_ISO200.ARW")
        );
        assert_eq!(mapped.category, MediaCategory::Raw);

        let modified_other = std::fs::metadata(&other).unwrap().modified().unwrap();
        let year = metadata::system_time_to_local_naive(modified_other)
            .unwrap()
            .format("%Y")
            .to_string();
        let mapped_other = mapper.map(&other, Path::new("readme.txt"), Some(modified_other));
        assert_eq!(
            mapped_other.target_relative,
            PathBuf::from(format!("{year}/misc/readme.txt"))
        );
    }

    #[test]
    fn unmatched_files_mirror_original_path() {
        let template = template_with_rules(vec![SaveRule {
            categories: vec![MediaCategory::Raw],
            extensions: Vec::new(),
            folder: "RAW".to_string(),
            file_name: "{name}.{ext}".to_string(),
        }]);
        let mapper = SaveRuleMapper::new(&template).unwrap();
        let mapped = mapper.map(
            Path::new("/nonexistent/docs/a.txt"),
            Path::new("docs/a.txt"),
            None,
        );
        assert_eq!(mapped.target_relative, PathBuf::from("docs/a.txt"));
    }

    #[test]
    fn extension_match_wins_before_category_match_by_order() {
        let template = template_with_rules(vec![
            SaveRule {
                categories: Vec::new(),
                extensions: vec![".XML".to_string()],
                folder: "sidecars".to_string(),
                file_name: "{name}.{ext}".to_string(),
            },
            SaveRule {
                categories: vec![MediaCategory::Metadata],
                extensions: Vec::new(),
                folder: "meta".to_string(),
                file_name: "{name}.{ext}".to_string(),
            },
        ]);
        let mapper = SaveRuleMapper::new(&template).unwrap();
        assert_eq!(
            mapper
                .map(
                    Path::new("/x/C0001M01.XML"),
                    Path::new("C0001M01.XML"),
                    None
                )
                .target_relative,
            PathBuf::from("sidecars/C0001M01.XML")
        );
        assert_eq!(
            mapper
                .map(Path::new("/x/a.xmp"), Path::new("a.xmp"), None)
                .target_relative,
            PathBuf::from("meta/a.xmp")
        );
    }

    #[test]
    fn collision_resolver_adds_numeric_suffix() {
        let mut resolver = CollisionResolver::default();
        assert_eq!(
            resolver.resolve(Path::new("a/DSC.JPG"), PathBuf::from("Photo/DSC.JPG")),
            PathBuf::from("Photo/DSC.JPG")
        );
        assert_eq!(
            resolver.resolve(Path::new("b/DSC.JPG"), PathBuf::from("Photo/DSC.JPG")),
            PathBuf::from("Photo/DSC_2.JPG")
        );
        assert_eq!(
            resolver.resolve(Path::new("c/DSC.JPG"), PathBuf::from("Photo/DSC.JPG")),
            PathBuf::from("Photo/DSC_3.JPG")
        );
        assert_eq!(
            resolver.resolve(Path::new("noext"), PathBuf::from("noext")),
            PathBuf::from("noext")
        );
        assert_eq!(
            resolver.resolve(Path::new("x/noext"), PathBuf::from("noext")),
            PathBuf::from("noext_2")
        );
    }

    #[test]
    fn validation_rejects_bad_templates() {
        let mut template = template_with_rules(vec![SaveRule::default()]);
        template.name = "  ".to_string();
        assert!(validate_template(&template).is_err());

        let mut template = template_with_rules(Vec::new());
        template.name = "x".to_string();
        assert!(validate_template(&template).is_err());

        let template = template_with_rules(vec![SaveRule {
            folder: "{unknown}".to_string(),
            ..SaveRule::default()
        }]);
        assert!(validate_template(&template).is_err());

        let template = template_with_rules(vec![SaveRule {
            file_name: "a/{name}".to_string(),
            ..SaveRule::default()
        }]);
        assert!(validate_template(&template).is_err());

        let template = template_with_rules(vec![SaveRule {
            extensions: vec!["bad ext".to_string()],
            ..SaveRule::default()
        }]);
        assert!(validate_template(&template).is_err());

        let mut template = template_with_rules(vec![SaveRule::default()]);
        template.category_names.raw = "{category}".to_string();
        assert!(validate_template(&template).is_err());
    }

    #[test]
    fn normalize_template_cleans_extensions_and_defaults() {
        let template = normalize_template(template_with_rules(vec![SaveRule {
            extensions: vec![" .ARW ".to_string(), String::new()],
            folder: " RAW ".to_string(),
            file_name: "  ".to_string(),
            ..SaveRule::default()
        }]));
        assert_eq!(template.rules[0].extensions, vec!["arw".to_string()]);
        assert_eq!(template.rules[0].folder, "RAW");
        assert_eq!(template.rules[0].file_name, "{name}.{ext}");
    }
}
