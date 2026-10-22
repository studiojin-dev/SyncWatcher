//! 폴더/파일명 템플릿 토큰 파싱·검증·렌더링.
//!
//! 토큰은 `{name}` 형태이며 대소문자를 구분한다 (`{MM}`=월, `{mm}`=분).
//! 렌더링 결과는 경로 세그먼트 단위로 정리(sanitize)되어 `..`, 절대 경로, 제어 문자가 섞이지 않는다.

use std::path::{Component, Path, PathBuf};

use chrono::{Datelike, NaiveDateTime, Timelike};

use super::metadata::MediaMetadata;
use super::types::{DateSource, MediaCategory, SaveRule};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Token {
    Year4,
    Year2,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    Date,
    Time,
    DateTime,
    Name,
    Ext,
    ExtUpper,
    ExtLower,
    Folder,
    Path,
    Category,
    Make,
    Model,
    Camera,
    Serial,
    Iso,
    FNumber,
    Aperture,
    Shutter,
    Focal,
}

impl Token {
    pub const ALL: [(&'static str, Token); 26] = [
        ("yyyy", Token::Year4),
        ("yy", Token::Year2),
        ("MM", Token::Month),
        ("dd", Token::Day),
        ("HH", Token::Hour),
        ("mm", Token::Minute),
        ("ss", Token::Second),
        ("date", Token::Date),
        ("time", Token::Time),
        ("datetime", Token::DateTime),
        ("name", Token::Name),
        ("ext", Token::Ext),
        ("EXT", Token::ExtUpper),
        ("ext_lower", Token::ExtLower),
        ("folder", Token::Folder),
        ("path", Token::Path),
        ("category", Token::Category),
        ("make", Token::Make),
        ("model", Token::Model),
        ("camera", Token::Camera),
        ("serial", Token::Serial),
        ("iso", Token::Iso),
        ("fnumber", Token::FNumber),
        ("aperture", Token::Aperture),
        ("shutter", Token::Shutter),
        ("focal", Token::Focal),
    ];

    pub fn parse(name: &str) -> Option<Token> {
        Token::ALL
            .iter()
            .find(|(candidate, _)| *candidate == name)
            .map(|(_, token)| *token)
    }

    fn is_date(self) -> bool {
        matches!(
            self,
            Token::Year4
                | Token::Year2
                | Token::Month
                | Token::Day
                | Token::Hour
                | Token::Minute
                | Token::Second
                | Token::Date
                | Token::Time
                | Token::DateTime
        )
    }

    fn is_camera(self) -> bool {
        matches!(
            self,
            Token::Make
                | Token::Model
                | Token::Camera
                | Token::Serial
                | Token::Iso
                | Token::FNumber
                | Token::Aperture
                | Token::Shutter
                | Token::Focal
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Literal(String),
    Token(Token),
}

/// 템플릿 문자열을 파싱한다. 알 수 없는 토큰이나 닫히지 않은 중괄호는 오류.
fn parse_template(template: &str) -> Result<Vec<Segment>, String> {
    let mut segments = Vec::new();
    let mut literal = String::new();
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '{' => {
                let mut name = String::new();
                let mut closed = false;
                for inner in chars.by_ref() {
                    if inner == '}' {
                        closed = true;
                        break;
                    }
                    if inner == '{' {
                        return Err(format!("Nested '{{' in template: {template}"));
                    }
                    name.push(inner);
                }
                if !closed {
                    return Err(format!("Unclosed '{{' in template: {template}"));
                }
                let token = Token::parse(&name)
                    .ok_or_else(|| format!("Unknown template token: {{{name}}}"))?;
                if !literal.is_empty() {
                    segments.push(Segment::Literal(std::mem::take(&mut literal)));
                }
                segments.push(Segment::Token(token));
            }
            '}' => return Err(format!("Unexpected '}}' in template: {template}")),
            _ => literal.push(ch),
        }
    }
    if !literal.is_empty() {
        segments.push(Segment::Literal(literal));
    }
    Ok(segments)
}

/// 템플릿 문자열에서 사용된 토큰 목록.
pub fn tokens_in(template: &str) -> Vec<Token> {
    parse_template(template)
        .map(|segments| {
            segments
                .into_iter()
                .filter_map(|segment| match segment {
                    Segment::Token(token) => Some(token),
                    Segment::Literal(_) => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 규칙이 촬영 메타데이터(EXIF/영상 생성 시각)를 읽어야 하는지.
pub fn needs_capture_metadata(date_source: DateSource, rule: &SaveRule) -> bool {
    let tokens: Vec<Token> = tokens_in(&rule.folder)
        .into_iter()
        .chain(tokens_in(&rule.file_name))
        .collect();
    tokens.iter().any(|token| token.is_camera())
        || (date_source == DateSource::Capture && tokens.iter().any(|token| token.is_date()))
}

const MAX_TEMPLATE_LENGTH: usize = 512;

/// 템플릿 문법을 검증한다 (토큰 이름, 길이, 제어 문자, `..`).
pub fn validate_template(template: &str, allow_separators: bool) -> Result<(), String> {
    if template.len() > MAX_TEMPLATE_LENGTH {
        return Err(format!(
            "Template too long ({} chars, max {MAX_TEMPLATE_LENGTH})",
            template.len()
        ));
    }
    if template.chars().any(|c| c.is_control()) {
        return Err("Template contains control characters".to_string());
    }
    if template.contains("..") {
        return Err("Template must not contain '..'".to_string());
    }
    if !allow_separators && template.contains('/') {
        return Err("File name template must not contain '/'".to_string());
    }
    if template.contains('\\') {
        return Err("Template must not contain '\\'".to_string());
    }
    parse_template(template).map(|_| ())
}

pub struct RenderInput<'a> {
    pub relative_path: &'a Path,
    pub category: MediaCategory,
    pub category_name: &'a str,
    /// 날짜 토큰에 쓸 시각 (이미 DateSource/폴백이 적용된 값)
    pub timestamp: NaiveDateTime,
    pub metadata: &'a MediaMetadata,
}

fn format_rational_decimal(value: super::exif::Rational, max_decimals: usize) -> Option<String> {
    let number = value.as_f64()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    let mut text = format!("{number:.prec$}", prec = max_decimals);
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    Some(text)
}

fn format_shutter(value: super::exif::Rational) -> Option<String> {
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    if number >= 1.0 {
        return format_rational_decimal(value, 1).map(|text| format!("{text}s"));
    }
    if value.numerator == 1 {
        return Some(format!("1-{}", value.denominator));
    }
    let reciprocal = (1.0 / number).round();
    if reciprocal >= 1.0 {
        Some(format!("1-{}", reciprocal as u64))
    } else {
        None
    }
}

/// 원본 확장자(대소문자 유지, 점 없음).
fn original_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

/// 토큰 값 안의 경로 구분자는 폴더 계층을 만들지 못하도록 `_`로 바꾼다.
fn neutralize_separators(value: String) -> String {
    if value.contains('/') || value.contains('\\') {
        value.replace(['/', '\\'], "_")
    } else {
        value
    }
}

fn render_token(token: Token, input: &RenderInput<'_>) -> String {
    let ts = input.timestamp;
    let metadata = input.metadata;
    match token {
        Token::Year4 => format!("{:04}", ts.year()),
        Token::Year2 => format!("{:02}", ts.year().rem_euclid(100)),
        Token::Month => format!("{:02}", ts.month()),
        Token::Day => format!("{:02}", ts.day()),
        Token::Hour => format!("{:02}", ts.hour()),
        Token::Minute => format!("{:02}", ts.minute()),
        Token::Second => format!("{:02}", ts.second()),
        Token::Date => format!("{:04}-{:02}-{:02}", ts.year(), ts.month(), ts.day()),
        Token::Time => format!("{:02}{:02}{:02}", ts.hour(), ts.minute(), ts.second()),
        Token::DateTime => format!(
            "{:04}{:02}{:02}_{:02}{:02}{:02}",
            ts.year(),
            ts.month(),
            ts.day(),
            ts.hour(),
            ts.minute(),
            ts.second()
        ),
        Token::Name => input
            .relative_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        Token::Ext => original_extension(input.relative_path),
        Token::ExtUpper => original_extension(input.relative_path).to_ascii_uppercase(),
        Token::ExtLower => original_extension(input.relative_path).to_ascii_lowercase(),
        Token::Folder => input
            .relative_path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        Token::Path => input
            .relative_path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_default(),
        Token::Category => input.category_name.to_string(),
        Token::Make => metadata.make.clone().unwrap_or_default(),
        Token::Model => metadata.model.clone().unwrap_or_default(),
        Token::Camera => metadata
            .model
            .clone()
            .or_else(|| metadata.make.clone())
            .unwrap_or_default(),
        Token::Serial => metadata.body_serial.clone().unwrap_or_default(),
        Token::Iso => metadata
            .iso
            .map(|iso| format!("ISO{iso}"))
            .unwrap_or_default(),
        Token::FNumber => metadata
            .f_number
            .and_then(|value| format_rational_decimal(value, 1))
            .map(|text| format!("f{text}"))
            .unwrap_or_default(),
        Token::Aperture => metadata
            .f_number
            .and_then(|value| format_rational_decimal(value, 1))
            .unwrap_or_default(),
        Token::Shutter => metadata
            .exposure_time
            .and_then(format_shutter)
            .unwrap_or_default(),
        Token::Focal => metadata
            .focal_length
            .and_then(|value| format_rational_decimal(value, 0))
            .map(|text| format!("{text}mm"))
            .unwrap_or_default(),
    }
}

/// 파일 시스템에 쓸 수 없는 문자를 `_`로 바꾸고 앞뒤 공백·점을 제거한다.
fn sanitize_segment(segment: &str) -> String {
    let replaced: String = segment
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = replaced.trim().trim_matches('.').trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return String::new();
    }
    trimmed.to_string()
}

fn render_segments(segments: &[Segment], input: &RenderInput<'_>) -> String {
    let mut out = String::new();
    for segment in segments {
        match segment {
            Segment::Literal(text) => out.push_str(text),
            // {path}는 원본 폴더 계층 자체이므로 구분자를 유지한다.
            Segment::Token(Token::Path) => out.push_str(&render_token(Token::Path, input)),
            Segment::Token(token) => {
                out.push_str(&neutralize_separators(render_token(*token, input)))
            }
        }
    }
    out
}

/// 폴더 템플릿을 렌더링해 상대 폴더 경로를 만든다. 빈 세그먼트는 제거된다.
pub fn render_folder(template: &str, input: &RenderInput<'_>) -> Result<PathBuf, String> {
    let segments = parse_template(template)?;
    let rendered = render_segments(&segments, input);
    let mut folder = PathBuf::new();
    for raw_segment in rendered.split('/') {
        let clean = sanitize_segment(raw_segment);
        if !clean.is_empty() {
            folder.push(clean);
        }
    }
    Ok(folder)
}

/// 파일명 템플릿을 렌더링한다. 결과에 원본 확장자가 없으면 덧붙이고, 비어 있으면 원본 파일명을 쓴다.
pub fn render_file_name(template: &str, input: &RenderInput<'_>) -> Result<String, String> {
    let segments = parse_template(template)?;
    let rendered = render_segments(&segments, input);
    let original_name = input
        .relative_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let extension = original_extension(input.relative_path);
    // 파일명 템플릿 안의 '/'는 세그먼트가 아니라 금지 문자이므로 통째로 정리한다.
    let mut name = sanitize_segment(&rendered.replace('/', "_"));
    if name.is_empty() || name.trim_start_matches('.').is_empty() {
        return Ok(original_name);
    }
    if !extension.is_empty() {
        let has_extension = name
            .rsplit_once('.')
            .is_some_and(|(stem, ext)| !stem.is_empty() && ext.eq_ignore_ascii_case(&extension));
        if !has_extension {
            name.push('.');
            name.push_str(&extension);
        }
    }
    Ok(name)
}

/// 렌더링된 상대 경로가 타깃 루트 안에 머무는지 검사한다.
pub fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_rules::exif::Rational;
    use chrono::NaiveDate;

    fn timestamp() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 22)
            .unwrap()
            .and_hms_opt(14, 3, 5)
            .unwrap()
    }

    fn metadata() -> MediaMetadata {
        MediaMetadata {
            captured_at: Some(timestamp()),
            make: Some("SONY".to_string()),
            model: Some("ILCE-7RM5".to_string()),
            body_serial: Some("03407347".to_string()),
            f_number: Some(Rational {
                numerator: 28,
                denominator: 10,
            }),
            exposure_time: Some(Rational {
                numerator: 1,
                denominator: 250,
            }),
            iso: Some(400),
            focal_length: Some(Rational {
                numerator: 35,
                denominator: 1,
            }),
        }
    }

    fn input<'a>(path: &'a Path, metadata: &'a MediaMetadata) -> RenderInput<'a> {
        RenderInput {
            relative_path: path,
            category: MediaCategory::Raw,
            category_name: "RAW",
            timestamp: timestamp(),
            metadata,
        }
    }

    #[test]
    fn renders_date_and_file_tokens() {
        let path = PathBuf::from("DCIM/100MSDCF/DSC00001.ARW");
        let metadata = metadata();
        let input = input(&path, &metadata);
        assert_eq!(
            render_folder("{yyyy}/{yyyy}-{MM}-{dd}/{category}", &input).unwrap(),
            PathBuf::from("2026/2026-10-22/RAW")
        );
        assert_eq!(
            render_file_name("{datetime}_{name}.{ext}", &input).unwrap(),
            "20261022_140305_DSC00001.ARW"
        );
        assert_eq!(
            render_file_name("{date}_{time}_{name}.{EXT}", &input).unwrap(),
            "2026-10-22_140305_DSC00001.ARW"
        );
        assert_eq!(
            render_file_name("{name}.{ext_lower}", &input).unwrap(),
            "DSC00001.arw"
        );
        assert_eq!(
            render_folder("{path}", &input).unwrap(),
            PathBuf::from("DCIM/100MSDCF")
        );
        assert_eq!(
            render_folder("{folder}", &input).unwrap(),
            PathBuf::from("100MSDCF")
        );
        assert_eq!(
            render_folder("{yy}{MM}", &input).unwrap(),
            PathBuf::from("2610")
        );
    }

    #[test]
    fn renders_camera_tokens() {
        let path = PathBuf::from("DSC00001.ARW");
        let metadata = metadata();
        let input = input(&path, &metadata);
        assert_eq!(
            render_file_name(
                "{name}_{camera}_{iso}_{fnumber}_{shutter}_{focal}_{serial}",
                &input
            )
            .unwrap(),
            "DSC00001_ILCE-7RM5_ISO400_f2.8_1-250_35mm_03407347.ARW"
        );
        assert_eq!(
            render_file_name("{name}_{aperture}_{make}_{model}", &input).unwrap(),
            "DSC00001_2.8_SONY_ILCE-7RM5.ARW"
        );
    }

    #[test]
    fn missing_metadata_renders_empty_and_keeps_extension() {
        let path = PathBuf::from("C0001.MP4");
        let metadata = MediaMetadata::default();
        let input = input(&path, &metadata);
        assert_eq!(
            render_file_name("{name}_{iso}{camera}", &input).unwrap(),
            "C0001_.MP4"
        );
        // 토큰만 있고 전부 비면 원본 파일명 유지
        assert_eq!(render_file_name("{iso}", &input).unwrap(), "C0001.MP4");
        // 확장자가 다른 대소문자로 이미 있으면 다시 붙이지 않는다
        assert_eq!(render_file_name("{name}.MP4", &input).unwrap(), "C0001.MP4");
        assert_eq!(render_file_name("{name}.mp4", &input).unwrap(), "C0001.mp4");
    }

    #[test]
    fn sanitizes_dangerous_segments() {
        let path = PathBuf::from("a/b.jpg");
        let metadata = MediaMetadata {
            model: Some("../evil:name?/sub".to_string()),
            ..MediaMetadata::default()
        };
        let input = input(&path, &metadata);
        assert_eq!(
            render_folder("{model}/./x//y", &input).unwrap(),
            PathBuf::from("_evil_name__sub/x/y")
        );
        assert_eq!(
            render_file_name("{model}", &input).unwrap(),
            "_evil_name__sub.jpg"
        );
        assert_eq!(render_folder("  /  ", &input).unwrap(), PathBuf::new());
        assert!(is_safe_relative_path(&PathBuf::from("a/b")));
        assert!(!is_safe_relative_path(&PathBuf::from("../b")));
        assert!(!is_safe_relative_path(&PathBuf::from("/a")));
        assert!(!is_safe_relative_path(&PathBuf::new()));
    }

    #[test]
    fn validates_templates() {
        assert!(validate_template("{yyyy}/{category}", true).is_ok());
        assert!(validate_template("{nope}", true).is_err());
        assert!(validate_template("{yyyy", true).is_err());
        assert!(validate_template("a}", true).is_err());
        assert!(validate_template("../x", true).is_err());
        assert!(validate_template("a/b", false).is_err());
        assert!(validate_template("a\\b", true).is_err());
        assert!(validate_template("{{yyyy}}", true).is_err());
        assert!(validate_template(&"x".repeat(600), true).is_err());
    }

    #[test]
    fn detects_capture_metadata_need() {
        let date_rule = SaveRule {
            folder: "{yyyy}".to_string(),
            ..SaveRule::default()
        };
        assert!(needs_capture_metadata(DateSource::Capture, &date_rule));
        assert!(!needs_capture_metadata(DateSource::Modified, &date_rule));
        let camera_rule = SaveRule {
            file_name: "{name}_{iso}".to_string(),
            ..SaveRule::default()
        };
        assert!(needs_capture_metadata(DateSource::Modified, &camera_rule));
        let plain_rule = SaveRule {
            folder: "{category}".to_string(),
            ..SaveRule::default()
        };
        assert!(!needs_capture_metadata(DateSource::Capture, &plain_rule));
    }

    #[test]
    fn shutter_formatting() {
        let input_path = PathBuf::from("x.jpg");
        for (rational, expected) in [
            ((1, 250), "1-250"),
            ((10, 2500), "1-250"),
            ((2, 1), "2s"),
            ((25, 10), "2.5s"),
        ] {
            let metadata = MediaMetadata {
                exposure_time: Some(Rational {
                    numerator: rational.0,
                    denominator: rational.1,
                }),
                ..MediaMetadata::default()
            };
            let input = input(&input_path, &metadata);
            assert_eq!(
                render_file_name("{shutter}", &input).unwrap(),
                format!("{expected}.jpg")
            );
        }
    }
}
