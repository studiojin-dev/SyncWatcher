//! 카메라 카드 식별 보조 근거.
//!
//! 포맷 후 디스크/볼륨 UUID가 바뀐 카드를 다시 찾기 위한 선택적 근거를 수집한다.
//! - 카메라 바디 시리얼: DCIM 최근 이미지의 EXIF BodySerialNumber(0xA431)
//! - 카메라 폴더 구조 시그니처: PRIVATE/* 및 DCIM/###XXXXX 구조
//!
//! 두 값 모두 "카드"가 아니라 "카메라(기종)"를 식별하므로 단독 근거로 쓰지 않는다.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

/// EXIF 탐색 시 파일당 읽는 최대 바이트 수. Sony ARW/JPG의 Exif IFD는 앞부분에 있다.
const EXIF_READ_LIMIT_BYTES: u64 = 256 * 1024;
/// 바디 시리얼을 읽을 최근 이미지 파일 최대 개수.
const MAX_EXIF_FILES: usize = 5;
/// DCIM 하위에서 살펴볼 폴더 최대 개수.
const MAX_DCIM_FOLDERS: usize = 32;
/// 폴더당 살펴볼 항목 최대 개수.
const MAX_ENTRIES_PER_FOLDER: usize = 4096;

const EXIF_IFD_POINTER_TAG: u16 = 0x8769;
const BODY_SERIAL_NUMBER_TAG: u16 = 0xA431;
const EXIF_TYPE_ASCII: u16 = 2;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CameraIdentity {
    pub body_serial: Option<String>,
    pub folder_signature: Option<String>,
}

#[derive(Clone, Copy)]
enum ByteOrder {
    Little,
    Big,
}

fn read_u16(data: &[u8], offset: usize, order: ByteOrder) -> Option<u16> {
    let bytes: [u8; 2] = data.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(match order {
        ByteOrder::Little => u16::from_le_bytes(bytes),
        ByteOrder::Big => u16::from_be_bytes(bytes),
    })
}

fn read_u32(data: &[u8], offset: usize, order: ByteOrder) -> Option<u32> {
    let bytes: [u8; 4] = data.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(match order {
        ByteOrder::Little => u32::from_le_bytes(bytes),
        ByteOrder::Big => u32::from_be_bytes(bytes),
    })
}

struct IfdEntry {
    entry_offset: usize,
    field_type: u16,
    count: u32,
}

fn find_ifd_entry(tiff: &[u8], ifd_offset: usize, tag: u16, order: ByteOrder) -> Option<IfdEntry> {
    let entry_count = usize::from(read_u16(tiff, ifd_offset, order)?);
    for index in 0..entry_count {
        let entry_offset = ifd_offset
            .checked_add(2)?
            .checked_add(index.checked_mul(12)?)?;
        if read_u16(tiff, entry_offset, order)? == tag {
            return Some(IfdEntry {
                entry_offset,
                field_type: read_u16(tiff, entry_offset.checked_add(2)?, order)?,
                count: read_u32(tiff, entry_offset.checked_add(4)?, order)?,
            });
        }
    }
    None
}

/// TIFF 헤더부터 시작하는 바이트에서 BodySerialNumber를 찾는다.
fn parse_tiff_body_serial(tiff: &[u8]) -> Option<String> {
    let order = match tiff.get(0..2)? {
        b"II" => ByteOrder::Little,
        b"MM" => ByteOrder::Big,
        _ => return None,
    };
    if read_u16(tiff, 2, order)? != 42 {
        return None;
    }
    let ifd0 = usize::try_from(read_u32(tiff, 4, order)?).ok()?;
    let exif_pointer = find_ifd_entry(tiff, ifd0, EXIF_IFD_POINTER_TAG, order)?;
    let exif_ifd = usize::try_from(read_u32(
        tiff,
        exif_pointer.entry_offset.checked_add(8)?,
        order,
    )?)
    .ok()?;

    let serial = find_ifd_entry(tiff, exif_ifd, BODY_SERIAL_NUMBER_TAG, order)?;
    if serial.field_type != EXIF_TYPE_ASCII {
        return None;
    }
    let count = usize::try_from(serial.count).ok()?;
    let value_offset = if count <= 4 {
        serial.entry_offset.checked_add(8)?
    } else {
        usize::try_from(read_u32(tiff, serial.entry_offset.checked_add(8)?, order)?).ok()?
    };
    let raw = tiff.get(value_offset..value_offset.checked_add(count)?)?;
    let text = String::from_utf8_lossy(raw);
    let trimmed = text.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }
    Some(trimmed.to_string())
}

/// JPEG(APP1 Exif) 또는 TIFF 기반 RAW(ARW 등) 바이트에서 EXIF BodySerialNumber를 읽는다.
/// 신뢰할 수 없는 외부 미디어 데이터이므로 범위를 벗어나면 None을 반환한다.
pub fn parse_exif_body_serial(data: &[u8]) -> Option<String> {
    if data.get(0..2)? != [0xFF, 0xD8] {
        return parse_tiff_body_serial(data);
    }

    let mut offset = 2usize;
    loop {
        if *data.get(offset)? != 0xFF {
            return None;
        }
        let marker = *data.get(offset.checked_add(1)?)?;
        // SOS 이후는 이미지 데이터이므로 탐색을 끝낸다.
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let segment_length = usize::from(read_u16(data, offset.checked_add(2)?, ByteOrder::Big)?);
        if segment_length < 2 {
            return None;
        }
        let payload_start = offset.checked_add(4)?;
        let segment_end = offset.checked_add(2)?.checked_add(segment_length)?;
        if marker == 0xE1 && data.get(payload_start..payload_start.checked_add(6)?)? == b"Exif\0\0"
        {
            let tiff_start = payload_start.checked_add(6)?;
            let tiff = data.get(tiff_start..segment_end.min(data.len()))?;
            if let Some(serial) = parse_tiff_body_serial(tiff) {
                return Some(serial);
            }
        }
        offset = segment_end;
    }
}

fn is_exif_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "arw" | "jpg" | "jpeg"
            )
        })
        .unwrap_or(false)
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(EXIF_READ_LIMIT_BYTES)
        .read_to_end(&mut buffer)
        .ok()?;
    Some(buffer)
}

fn list_directories(path: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };
    entries
        .take(MAX_ENTRIES_PER_FOLDER)
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().to_str().map(ToString::to_string))
        .filter(|name| !name.starts_with('.'))
        .collect()
}

/// 볼륨의 DCIM 이미지(폴더·파일명 역순으로 최대 5개, 파일당 256KiB)에서 카메라 바디 시리얼을 읽는다.
/// 카메라 파일명은 순번이므로 역순이 최근 촬영 순서에 가깝고, 파일마다 stat하지 않아도 된다.
/// 파일 간 시리얼이 다르면 여러 카메라가 섞인 카드이므로 None을 반환한다.
pub fn read_camera_body_serial(mount_point: &Path) -> Option<String> {
    let dcim = mount_point.join("DCIM");
    let mut folders = list_directories(&dcim);
    folders.sort_by(|left, right| right.cmp(left));

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    for folder in folders.into_iter().take(MAX_DCIM_FOLDERS) {
        let Ok(entries) = fs::read_dir(dcim.join(&folder)) else {
            continue;
        };
        let mut images: Vec<std::path::PathBuf> = entries
            .take(MAX_ENTRIES_PER_FOLDER)
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            })
            .map(|entry| entry.path())
            .filter(|path| is_exif_image(path))
            .collect();
        images.sort_by(|left, right| right.cmp(left));
        let remaining = MAX_EXIF_FILES - candidates.len();
        candidates.extend(images.into_iter().take(remaining));
        if candidates.len() >= MAX_EXIF_FILES {
            break;
        }
    }

    let mut found: Option<String> = None;
    for path in candidates {
        let Some(serial) = read_head(&path).and_then(|data| parse_exif_body_serial(&data)) else {
            continue;
        };
        match &found {
            Some(existing) if existing != &serial => return None,
            Some(_) => {}
            None => found = Some(serial),
        }
    }
    found
}

/// DCIM 폴더명("100MSDCF")의 앞 세 자리 번호를 "###"로 정규화한다.
fn normalize_dcim_folder(name: &str) -> String {
    let upper = name.to_ascii_uppercase();
    let prefix = upper.get(0..3).unwrap_or("");
    if prefix.len() == 3 && prefix.chars().all(|c| c.is_ascii_digit()) {
        format!("DCIM/###{}", upper.get(3..).unwrap_or(""))
    } else {
        format!("DCIM/{upper}")
    }
}

/// PRIVATE/DCIM 하위 폴더 이름으로 카메라 폴더 구조 시그니처를 만든다 (순수 함수).
/// 예: "DCIM/###MSDCF|PRIVATE/DATABASE|PRIVATE/M4ROOT|PRIVATE/SONY"
pub fn camera_folder_signature_from_entries(
    private_dirs: &[String],
    dcim_dirs: &[String],
) -> Option<String> {
    let mut tokens: Vec<String> = private_dirs
        .iter()
        .map(|name| format!("PRIVATE/{}", name.to_ascii_uppercase()))
        .chain(dcim_dirs.iter().map(|name| normalize_dcim_folder(name)))
        .collect();
    if !tokens.iter().any(|token| token.starts_with("PRIVATE/")) {
        return None;
    }
    tokens.sort();
    tokens.dedup();
    Some(tokens.join("|"))
}

pub fn read_camera_folder_signature(mount_point: &Path) -> Option<String> {
    camera_folder_signature_from_entries(
        &list_directories(&mount_point.join("PRIVATE")),
        &list_directories(&mount_point.join("DCIM")),
    )
}

/// 두 폴더 시그니처가 같은 카메라 계열로 보이는지 판단한다.
/// 포맷 직후에는 DCIM이 없으므로 PRIVATE 구조는 같아야 하고,
/// DCIM 구조는 양쪽에 모두 있을 때만 비교한다.
pub fn camera_folder_signatures_match(left: &str, right: &str) -> bool {
    fn split(signature: &str) -> (Vec<&str>, Vec<&str>) {
        signature
            .split('|')
            .filter(|token| !token.is_empty())
            .partition(|token| token.starts_with("PRIVATE/"))
    }
    let (left_private, left_dcim) = split(left);
    let (right_private, right_dcim) = split(right);
    if left_private.is_empty() || left_private != right_private {
        return false;
    }
    left_dcim.is_empty() || right_dcim.is_empty() || left_dcim == right_dcim
}

pub fn probe_camera_identity(mount_point: &Path) -> CameraIdentity {
    CameraIdentity {
        body_serial: read_camera_body_serial(mount_point),
        folder_signature: read_camera_folder_signature(mount_point),
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    /// BodySerialNumber를 담은 최소 TIFF 바이트를 만든다.
    pub fn build_tiff_with_body_serial(serial: &str, little_endian: bool) -> Vec<u8> {
        let put16 = |value: u16| {
            if little_endian {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            }
        };
        let put32 = |value: u32| {
            if little_endian {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            }
        };
        let mut serial_bytes = serial.as_bytes().to_vec();
        serial_bytes.push(0);

        let mut data = Vec::new();
        data.extend_from_slice(if little_endian { b"II" } else { b"MM" });
        data.extend_from_slice(&put16(42));
        data.extend_from_slice(&put32(8));
        // IFD0 @8: 엔트리 1개 (ExifIFD 포인터)
        data.extend_from_slice(&put16(1));
        data.extend_from_slice(&put16(0x8769));
        data.extend_from_slice(&put16(4));
        data.extend_from_slice(&put32(1));
        data.extend_from_slice(&put32(26));
        data.extend_from_slice(&put32(0));
        // Exif IFD @26: 엔트리 1개 (BodySerialNumber)
        data.extend_from_slice(&put16(1));
        data.extend_from_slice(&put16(0xA431));
        data.extend_from_slice(&put16(2));
        data.extend_from_slice(&put32(serial_bytes.len() as u32));
        if serial_bytes.len() <= 4 {
            let mut inline = serial_bytes.clone();
            inline.resize(4, 0);
            data.extend_from_slice(&inline);
            data.extend_from_slice(&put32(0));
        } else {
            data.extend_from_slice(&put32(44));
            data.extend_from_slice(&put32(0));
            data.extend_from_slice(&serial_bytes);
        }
        data
    }

    pub fn wrap_tiff_in_jpeg(tiff: &[u8]) -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8];
        // 앞에 APP0(JFIF) 세그먼트를 둬서 세그먼트 탐색을 검증한다.
        data.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x07, b'J', b'F', b'I', b'F', 0x00]);
        let length = (2 + 6 + tiff.len()) as u16;
        data.extend_from_slice(&[0xFF, 0xE1]);
        data.extend_from_slice(&length.to_be_bytes());
        data.extend_from_slice(b"Exif\0\0");
        data.extend_from_slice(tiff);
        data.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);
        data
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{build_tiff_with_body_serial, wrap_tiff_in_jpeg};
    use super::*;

    #[test]
    fn parses_body_serial_from_little_and_big_endian_tiff() {
        let little = build_tiff_with_body_serial("03407347", true);
        assert_eq!(parse_exif_body_serial(&little).as_deref(), Some("03407347"));
        let big = build_tiff_with_body_serial("03407347", false);
        assert_eq!(parse_exif_body_serial(&big).as_deref(), Some("03407347"));
    }

    #[test]
    fn parses_inline_short_body_serial() {
        let tiff = build_tiff_with_body_serial("A12", true);
        assert_eq!(parse_exif_body_serial(&tiff).as_deref(), Some("A12"));
    }

    #[test]
    fn parses_body_serial_from_jpeg_app1() {
        let jpeg = wrap_tiff_in_jpeg(&build_tiff_with_body_serial("03407347", true));
        assert_eq!(parse_exif_body_serial(&jpeg).as_deref(), Some("03407347"));
    }

    #[test]
    fn rejects_truncated_or_corrupt_data_without_panicking() {
        let tiff = build_tiff_with_body_serial("03407347", true);
        for length in 0..tiff.len() {
            assert_eq!(
                parse_exif_body_serial(&tiff[..length]),
                None,
                "len {length}"
            );
        }
        let mut bad_offset = tiff.clone();
        bad_offset[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(parse_exif_body_serial(&bad_offset), None);
        let mut bad_exif_pointer = tiff.clone();
        bad_exif_pointer[18..22].copy_from_slice(&(tiff.len() as u32).to_le_bytes());
        assert_eq!(parse_exif_body_serial(&bad_exif_pointer), None);
        let mut bad_serial_type = tiff.clone();
        bad_serial_type[30..32].copy_from_slice(&7u16.to_le_bytes());
        assert_eq!(parse_exif_body_serial(&bad_serial_type), None);
        assert_eq!(
            parse_exif_body_serial(&[0xFF, 0xD8, 0xFF, 0xE1, 0x00]),
            None
        );
        assert_eq!(parse_exif_body_serial(b"not an image"), None);
    }

    #[test]
    fn reads_body_serial_from_dcim_images() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("DCIM/100MSDCF");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("DSC00001.ARW"),
            build_tiff_with_body_serial("03407347", true),
        )
        .unwrap();
        fs::write(
            folder.join("DSC00002.JPG"),
            wrap_tiff_in_jpeg(&build_tiff_with_body_serial("03407347", true)),
        )
        .unwrap();
        fs::write(folder.join("C0001.MP4"), b"ignored").unwrap();

        assert_eq!(
            read_camera_body_serial(temp.path()).as_deref(),
            Some("03407347")
        );
    }

    #[test]
    fn body_serial_is_none_for_empty_or_mixed_cards() {
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(read_camera_body_serial(empty.path()), None);

        let mixed = tempfile::tempdir().unwrap();
        let folder = mixed.path().join("DCIM/100MSDCF");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("A.ARW"),
            build_tiff_with_body_serial("111", true),
        )
        .unwrap();
        fs::write(
            folder.join("B.ARW"),
            build_tiff_with_body_serial("222", true),
        )
        .unwrap();
        assert_eq!(read_camera_body_serial(mixed.path()), None);
    }

    #[test]
    fn builds_folder_signature_with_normalized_dcim_numbers() {
        let signature = camera_folder_signature_from_entries(
            &[
                "SONY".to_string(),
                "M4ROOT".to_string(),
                "DATABASE".to_string(),
            ],
            &["101MSDCF".to_string(), "100MSDCF".to_string()],
        );
        assert_eq!(
            signature.as_deref(),
            Some("DCIM/###MSDCF|PRIVATE/DATABASE|PRIVATE/M4ROOT|PRIVATE/SONY")
        );
        assert_eq!(
            camera_folder_signature_from_entries(&[], &["100MSDCF".to_string()]),
            None
        );
    }

    #[test]
    fn reads_folder_signature_from_freshly_formatted_card_layout() {
        let temp = tempfile::tempdir().unwrap();
        for dir in [
            "PRIVATE/SONY/PRO",
            "PRIVATE/DATABASE",
            "PRIVATE/M4ROOT/CLIP",
        ] {
            fs::create_dir_all(temp.path().join(dir)).unwrap();
        }
        assert_eq!(
            read_camera_folder_signature(temp.path()).as_deref(),
            Some("PRIVATE/DATABASE|PRIVATE/M4ROOT|PRIVATE/SONY")
        );
    }

    #[test]
    fn folder_signatures_match_across_format_but_not_across_camera_families() {
        let used = "DCIM/###MSDCF|PRIVATE/DATABASE|PRIVATE/M4ROOT|PRIVATE/SONY";
        let fresh = "PRIVATE/DATABASE|PRIVATE/M4ROOT|PRIVATE/SONY";
        assert!(camera_folder_signatures_match(used, fresh));
        assert!(camera_folder_signatures_match(fresh, used));
        assert!(!camera_folder_signatures_match(
            used,
            "DCIM/###CANON|PRIVATE/DATABASE|PRIVATE/M4ROOT|PRIVATE/SONY"
        ));
        assert!(!camera_folder_signatures_match(used, "PRIVATE/AVCHD"));
        assert!(!camera_folder_signatures_match("", ""));
    }
}
