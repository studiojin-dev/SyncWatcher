//! 상대 경로(확장자·폴더 구조)로 미디어 카테고리를 분류한다.
//!
//! 카메라 제조사별 프록시 규칙:
//! - Sony: `PRIVATE/M4ROOT/SUB/C0001S03.MP4` (SUB 폴더, `S0n` 접미사)
//! - GoPro: `*.LRV`, DJI: `*.LRF`
//! - Canon/Panasonic 등: `PROXY`/`PROXIES` 폴더

use std::path::Path;

use super::types::MediaCategory;

const RAW_EXTENSIONS: &[&str] = &[
    "arw", "srf", "sr2", "cr2", "cr3", "crw", "nef", "nrw", "dng", "raf", "orf", "rw2", "pef",
    "srw", "x3f", "3fr", "fff", "iiq", "mos", "mrw", "erf", "kdc", "dcr", "rwl", "gpr",
];

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jpe", "heif", "heic", "hif", "avif", "png", "tif", "tiff", "webp", "bmp",
    "gif", "psd",
];

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "m4v", "mxf", "avi", "mts", "m2ts", "mkv", "3gp", "braw", "r3d", "insv", "360",
    "wmv", "mpg", "mpeg",
];

const PROXY_EXTENSIONS: &[&str] = &["lrv", "lrf"];

const METADATA_EXTENSIONS: &[&str] = &[
    "xml", "xmp", "thm", "bim", "bdm", "mpl", "cpi", "cpl", "ind", "inp", "mdt", "pdb", "srt",
    "idx",
];

const PROXY_DIR_NAMES: &[&str] = &["SUB", "PROXY", "PROXIES"];

/// 확장자를 소문자로 돌려준다 (점 없음).
pub fn lowercase_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default()
}

fn has_proxy_directory(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    parent.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| {
                let upper = name.to_ascii_uppercase();
                PROXY_DIR_NAMES.contains(&upper.as_str())
            })
            .unwrap_or(false)
    })
}

/// Sony 프록시 파일명: `C0001S03.MP4`처럼 스템이 `S0<숫자>`로 끝난다.
fn has_sony_proxy_suffix(path: &Path) -> bool {
    let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() >= 4
        && bytes[bytes.len() - 3].eq_ignore_ascii_case(&b'S')
        && bytes[bytes.len() - 2] == b'0'
        && bytes[bytes.len() - 1].is_ascii_digit()
}

pub fn classify(relative_path: &Path) -> MediaCategory {
    let extension = lowercase_extension(relative_path);
    let extension = extension.as_str();

    if PROXY_EXTENSIONS.contains(&extension) {
        return MediaCategory::Proxy;
    }
    if VIDEO_EXTENSIONS.contains(&extension) {
        if has_proxy_directory(relative_path) || has_sony_proxy_suffix(relative_path) {
            return MediaCategory::Proxy;
        }
        return MediaCategory::Video;
    }
    if RAW_EXTENSIONS.contains(&extension) {
        return MediaCategory::Raw;
    }
    if IMAGE_EXTENSIONS.contains(&extension) {
        return MediaCategory::Image;
    }
    if METADATA_EXTENSIONS.contains(&extension) {
        return MediaCategory::Metadata;
    }
    MediaCategory::Other
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn category(path: &str) -> MediaCategory {
        classify(&PathBuf::from(path))
    }

    #[test]
    fn classifies_sony_card_layout() {
        assert_eq!(category("DCIM/100MSDCF/DSC00001.ARW"), MediaCategory::Raw);
        assert_eq!(category("DCIM/100MSDCF/DSC00001.JPG"), MediaCategory::Image);
        assert_eq!(category("DCIM/100MSDCF/DSC00001.HIF"), MediaCategory::Image);
        assert_eq!(
            category("PRIVATE/M4ROOT/CLIP/C0001.MP4"),
            MediaCategory::Video
        );
        assert_eq!(
            category("PRIVATE/M4ROOT/SUB/C0001S03.MP4"),
            MediaCategory::Proxy
        );
        assert_eq!(
            category("PRIVATE/M4ROOT/CLIP/C0001M01.XML"),
            MediaCategory::Metadata
        );
        assert_eq!(
            category("PRIVATE/M4ROOT/MEDIAPRO.XML"),
            MediaCategory::Metadata
        );
        assert_eq!(
            category("PRIVATE/SONY/SONYCARD.IND"),
            MediaCategory::Metadata
        );
    }

    #[test]
    fn classifies_other_vendors() {
        assert_eq!(category("DCIM/100GOPRO/GH010001.LRV"), MediaCategory::Proxy);
        assert_eq!(category("DCIM/100MEDIA/DJI_0001.LRF"), MediaCategory::Proxy);
        assert_eq!(category("CLIPS/PROXY/A001.MOV"), MediaCategory::Proxy);
        assert_eq!(category("DCIM/100CANON/IMG_0001.CR3"), MediaCategory::Raw);
        assert_eq!(category("DCIM/100CANON/MVI_0001.MOV"), MediaCategory::Video);
        assert_eq!(category("readme"), MediaCategory::Other);
        assert_eq!(category("notes.pdf"), MediaCategory::Other);
    }

    #[test]
    fn sony_suffix_requires_video_extension() {
        assert_eq!(category("DCIM/DSC0S03.JPG"), MediaCategory::Image);
        assert_eq!(category("C0001S03.MP4"), MediaCategory::Proxy);
        assert_eq!(category("S03.MP4"), MediaCategory::Video);
    }
}
