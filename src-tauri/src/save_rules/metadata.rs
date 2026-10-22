//! 파일에서 저장 규칙 토큰에 필요한 촬영 메타데이터를 읽는다.
//!
//! 지원 형식:
//! - 사진: JPEG, TIFF 계열 RAW(ARW/NEF/CR2/DNG/ORF/RW2/PEF 등), RAF, HEIF/HEIC/AVIF
//! - 영상: MP4/MOV/M4V/3GP (`mvhd` 생성 시각), Sony 사이드카 XML(`C0001M01.XML`)의 CreationDate
//!
//! 그 외 형식(CR3, MXF, AVI 등)은 촬영 메타데이터 없이 파일 수정 시각만 쓴다.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};

use super::exif::{parse_exif, ExifFields, Rational};
use super::isobmff::{read_heif_exif, read_mp4_creation_time};
use super::types::VideoTimestampMode;

/// 사진 파일 앞부분에서 먼저 읽을 바이트 수. JPEG APP1은 64KiB를 넘지 못하고,
/// 대부분의 RAW는 IFD0/Exif IFD가 처음 몇 KiB 안에 있다.
const IMAGE_HEAD_READ_FIRST: u64 = 64 * 1024;
/// 첫 읽기에서 EXIF를 찾지 못했을 때 다시 읽을 최대 바이트 수.
const IMAGE_HEAD_READ_LIMIT: u64 = 512 * 1024;
/// 사이드카 XML 최대 읽기 크기.
const SIDECAR_READ_LIMIT: u64 = 64 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MediaMetadata {
    /// 촬영 시각 (현지 시각, 시간대 정보 없음)
    pub captured_at: Option<NaiveDateTime>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub body_serial: Option<String>,
    pub f_number: Option<Rational>,
    pub exposure_time: Option<Rational>,
    pub iso: Option<u32>,
    pub focal_length: Option<Rational>,
}

impl From<ExifFields> for MediaMetadata {
    fn from(fields: ExifFields) -> Self {
        let captured_at = fields
            .date_time_original
            .as_deref()
            .and_then(parse_exif_date_time)
            .or_else(|| fields.date_time.as_deref().and_then(parse_exif_date_time));
        MediaMetadata {
            captured_at,
            make: fields.make,
            model: fields.model,
            body_serial: fields.body_serial,
            f_number: fields.f_number,
            exposure_time: fields.exposure_time,
            iso: fields.iso,
            focal_length: fields.focal_length,
        }
    }
}

/// EXIF 날짜 문자열("YYYY:MM:DD HH:MM:SS")을 파싱한다. 카메라가 쓰는 공백/하이픈 변형도 허용한다.
pub fn parse_exif_date_time(value: &str) -> Option<NaiveDateTime> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with("0000") {
        return None;
    }
    NaiveDateTime::parse_from_str(trimmed, "%Y:%m:%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S"))
        .ok()
}

/// RFC 3339 문자열("2026-10-22T14:03:55+09:00")을 기록된 시간대의 현지 시각으로 돌려준다.
pub fn parse_rfc3339_local(value: &str) -> Option<NaiveDateTime> {
    DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|parsed| parsed.naive_local())
}

/// Sony 사이드카 XML(NonRealTimeMeta)에서 `<CreationDate value="..."/>`를 읽는다.
pub fn parse_sony_sidecar_creation_date(xml: &str) -> Option<NaiveDateTime> {
    let tag_index = xml.find("CreationDate")?;
    let rest = &xml[tag_index..];
    let tag_end = rest.find('>').unwrap_or(rest.len());
    let tag = &rest[..tag_end];
    let value_index = tag.find("value=")?;
    let after = &tag[value_index + "value=".len()..];
    let quote = after.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let inner = &after[1..];
    let close = inner.find(quote)?;
    parse_rfc3339_local(&inner[..close])
}

pub fn system_time_to_local_naive(time: SystemTime) -> Option<NaiveDateTime> {
    let datetime: DateTime<Utc> = time.into();
    Some(datetime.with_timezone(&Local).naive_local())
}

fn read_head(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(limit).read_to_end(&mut buffer).ok()?;
    Some(buffer)
}

/// 64KiB만 먼저 읽고, EXIF가 그 뒤에 있는 드문 파일만 512KiB까지 다시 읽는다.
fn read_image_exif(path: &Path) -> Option<ExifFields> {
    let head = read_head(path, IMAGE_HEAD_READ_FIRST)?;
    if let Some(fields) = parse_exif(&head) {
        return Some(fields);
    }
    if (head.len() as u64) < IMAGE_HEAD_READ_FIRST {
        return None;
    }
    read_head(path, IMAGE_HEAD_READ_LIMIT).and_then(|data| parse_exif(&data))
}

fn lowercase_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Sony 영상 `C0001.MP4` 옆의 `C0001M01.XML` 경로.
/// 프록시 `SUB/C0001S03.MP4`는 원본 클립의 사이드카 `../CLIP/C0001M01.XML`을 쓴다.
fn sony_sidecar_path(path: &Path) -> Option<std::path::PathBuf> {
    let stem = path.file_stem()?.to_str()?;
    let parent = path.parent()?;
    let mut candidates = vec![
        parent.join(format!("{stem}M01.XML")),
        parent.join(format!("{stem}M01.xml")),
    ];
    let bytes = stem.as_bytes();
    let is_proxy_stem = bytes.len() >= 4
        && bytes[bytes.len() - 3].eq_ignore_ascii_case(&b"S"[0])
        && bytes[bytes.len() - 2] == b'0'
        && bytes[bytes.len() - 1].is_ascii_digit();
    if is_proxy_stem {
        let base = &stem[..stem.len() - 3];
        if let Some(grandparent) = parent.parent() {
            candidates.push(grandparent.join("CLIP").join(format!("{base}M01.XML")));
            candidates.push(grandparent.join("CLIP").join(format!("{base}M01.xml")));
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Sony 사이드카 XML 자체의 CreationDate를 촬영 시각으로 쓴다 (클립과 같은 날짜 폴더로 가도록).
fn read_xml_sidecar_captured_at(path: &Path) -> Option<NaiveDateTime> {
    let bytes = read_head(path, SIDECAR_READ_LIMIT)?;
    let xml = String::from_utf8(bytes).ok()?;
    parse_sony_sidecar_creation_date(&xml)
}

fn read_video_captured_at(path: &Path, mode: VideoTimestampMode) -> Option<NaiveDateTime> {
    if let Some(sidecar) = sony_sidecar_path(path) {
        if let Some(captured_at) = read_head(&sidecar, SIDECAR_READ_LIMIT)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|xml| parse_sony_sidecar_creation_date(&xml))
        {
            return Some(captured_at);
        }
    }
    let mut file = File::open(path).ok()?;
    let unix_seconds = read_mp4_creation_time(&mut file)?;
    let seconds = i64::try_from(unix_seconds).ok()?;
    match mode {
        VideoTimestampMode::Local => DateTime::from_timestamp(seconds, 0).map(|dt| dt.naive_utc()),
        VideoTimestampMode::Utc => Utc
            .timestamp_opt(seconds, 0)
            .single()
            .map(|dt| dt.with_timezone(&Local).naive_local()),
    }
}

/// 파일 확장자에 따라 촬영 메타데이터를 읽는다. 읽을 수 없으면 빈 메타데이터.
pub fn read_media_metadata(path: &Path, video_mode: VideoTimestampMode) -> MediaMetadata {
    let extension = lowercase_extension(path);
    match extension.as_str() {
        "jpg" | "jpeg" | "jpe" | "tif" | "tiff" | "arw" | "srf" | "sr2" | "nef" | "nrw" | "cr2"
        | "dng" | "orf" | "rw2" | "pef" | "srw" | "erf" | "mrw" | "raf" | "3fr" | "fff" | "iiq"
        | "mos" | "kdc" | "dcr" | "rwl" | "gpr" => read_image_exif(path)
            .map(MediaMetadata::from)
            .unwrap_or_default(),
        "heif" | "heic" | "hif" | "avif" => File::open(path)
            .ok()
            .and_then(|mut file| read_heif_exif(&mut file))
            .map(MediaMetadata::from)
            .unwrap_or_default(),
        "mp4" | "mov" | "m4v" | "3gp" | "lrv" | "lrf" => MediaMetadata {
            captured_at: read_video_captured_at(path, video_mode),
            ..MediaMetadata::default()
        },
        "xml" => MediaMetadata {
            captured_at: read_xml_sidecar_captured_at(path),
            ..MediaMetadata::default()
        },
        _ => MediaMetadata::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_rules::exif::test_support::TiffBuilder;
    use crate::save_rules::isobmff::test_support::build_mp4;
    use chrono::NaiveDate;

    #[test]
    fn parses_exif_date_variants() {
        let expected = NaiveDate::from_ymd_opt(2026, 10, 22)
            .unwrap()
            .and_hms_opt(14, 3, 55)
            .unwrap();
        assert_eq!(parse_exif_date_time("2026:10:22 14:03:55"), Some(expected));
        assert_eq!(parse_exif_date_time("2026-10-22 14:03:55"), Some(expected));
        assert_eq!(parse_exif_date_time("0000:00:00 00:00:00"), None);
        assert_eq!(parse_exif_date_time("    "), None);
    }

    #[test]
    fn parses_sony_sidecar_creation_date_as_local_wall_clock() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta xmlns="urn:schemas-professionalDisc:nonRealTimeMeta:ver.2.20">
  <Duration value="300"/>
  <CreationDate value="2026-10-22T14:03:55+09:00"/>
</NonRealTimeMeta>"#;
        let expected = NaiveDate::from_ymd_opt(2026, 10, 22)
            .unwrap()
            .and_hms_opt(14, 3, 55)
            .unwrap();
        assert_eq!(parse_sony_sidecar_creation_date(xml), Some(expected));
        assert_eq!(parse_sony_sidecar_creation_date("<CreationDate/>"), None);
    }

    #[test]
    fn reads_image_metadata_from_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("DSC00001.ARW");
        std::fs::write(
            &path,
            TiffBuilder {
                little_endian: true,
                model: Some("ILCE-7RM5".to_string()),
                date_time_original: Some("2026:10:22 14:03:55".to_string()),
                iso: Some(800),
                f_number: Some((40, 10)),
                ..TiffBuilder::default()
            }
            .build(),
        )
        .unwrap();
        let metadata = read_media_metadata(&path, VideoTimestampMode::Local);
        assert_eq!(metadata.model.as_deref(), Some("ILCE-7RM5"));
        assert_eq!(metadata.iso, Some(800));
        assert_eq!(
            metadata.captured_at,
            NaiveDate::from_ymd_opt(2026, 10, 22)
                .unwrap()
                .and_hms_opt(14, 3, 55)
        );
    }

    #[test]
    fn video_prefers_sony_sidecar_over_mvhd() {
        let dir = tempfile::TempDir::new().unwrap();
        let clip = dir.path().join("C0001.MP4");
        // mvhd: 2026-01-01T00:00:00Z
        let unix = 1_767_225_600u64;
        std::fs::write(&clip, build_mp4(unix + 2_082_844_800, false, false)).unwrap();
        let without_sidecar = read_media_metadata(&clip, VideoTimestampMode::Local);
        assert_eq!(
            without_sidecar.captured_at,
            NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
        );

        std::fs::write(
            dir.path().join("C0001M01.XML"),
            r#"<NonRealTimeMeta><CreationDate value="2026-10-22T14:03:55+09:00"/></NonRealTimeMeta>"#,
        )
        .unwrap();
        let with_sidecar = read_media_metadata(&clip, VideoTimestampMode::Local);
        assert_eq!(
            with_sidecar.captured_at,
            NaiveDate::from_ymd_opt(2026, 10, 22)
                .unwrap()
                .and_hms_opt(14, 3, 55)
        );
    }

    #[test]
    fn reads_exif_segment_located_past_first_64kib() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("DSC00002.JPG");
        let tiff = TiffBuilder {
            little_endian: true,
            model: Some("ILCE-7RM5".to_string()),
            date_time_original: Some("2026:10:22 14:03:55".to_string()),
            ..TiffBuilder::default()
        }
        .build();
        // 합쳐서 64KiB를 넘는 APP2(ICC) 세그먼트들 뒤에 APP1 Exif가 오는 JPEG.
        let mut jpeg = vec![0xFF, 0xD8];
        let icc_len = 60_000u16;
        for _ in 0..2 {
            jpeg.extend_from_slice(&[0xFF, 0xE2]);
            jpeg.extend_from_slice(&icc_len.to_be_bytes());
            jpeg.resize(jpeg.len() + usize::from(icc_len) - 2, 0);
        }
        jpeg.extend_from_slice(&[0xFF, 0xE1]);
        jpeg.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        jpeg.extend_from_slice(b"Exif\0\0");
        jpeg.extend_from_slice(&tiff);
        jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);
        assert!(jpeg.len() > 64 * 1024);
        std::fs::write(&path, &jpeg).unwrap();

        let metadata = read_media_metadata(&path, VideoTimestampMode::Local);
        assert_eq!(metadata.model.as_deref(), Some("ILCE-7RM5"));
        assert_eq!(
            metadata.captured_at,
            NaiveDate::from_ymd_opt(2026, 10, 22)
                .unwrap()
                .and_hms_opt(14, 3, 55)
        );
    }

    #[test]
    fn proxy_and_sidecar_share_the_clip_creation_date() {
        let dir = tempfile::TempDir::new().unwrap();
        let clip_dir = dir.path().join("PRIVATE/M4ROOT/CLIP");
        let sub_dir = dir.path().join("PRIVATE/M4ROOT/SUB");
        std::fs::create_dir_all(&clip_dir).unwrap();
        std::fs::create_dir_all(&sub_dir).unwrap();
        let unix = 1_767_225_600u64;
        std::fs::write(
            sub_dir.join("C0001S03.MP4"),
            build_mp4(unix + 2_082_844_800, false, false),
        )
        .unwrap();
        let sidecar = clip_dir.join("C0001M01.XML");
        std::fs::write(
            &sidecar,
            r#"<NonRealTimeMeta><CreationDate value="2026-10-22T14:03:55+09:00"/></NonRealTimeMeta>"#,
        )
        .unwrap();
        let expected = NaiveDate::from_ymd_opt(2026, 10, 22)
            .unwrap()
            .and_hms_opt(14, 3, 55);
        let proxy = read_media_metadata(&sub_dir.join("C0001S03.MP4"), VideoTimestampMode::Local);
        assert_eq!(proxy.captured_at, expected);
        let xml = read_media_metadata(&sidecar, VideoTimestampMode::Local);
        assert_eq!(xml.captured_at, expected);
        std::fs::write(clip_dir.join("MEDIAPRO.XML"), "<MediaProfile/>").unwrap();
        assert_eq!(
            read_media_metadata(&clip_dir.join("MEDIAPRO.XML"), VideoTimestampMode::Local)
                .captured_at,
            None
        );
    }

    #[test]
    fn unsupported_extension_yields_empty_metadata() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, b"hello").unwrap();
        assert_eq!(
            read_media_metadata(&path, VideoTimestampMode::Local),
            MediaMetadata::default()
        );
    }
}
