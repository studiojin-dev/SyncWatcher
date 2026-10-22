//! ISO BMFF(MP4/MOV/HEIF) 최소 리더.
//!
//! - MP4/MOV: `moov/mvhd`의 creation_time (1904-01-01 기준 초)
//! - HEIF/HEIC/AVIF: `meta/iinf`에서 `Exif` 아이템을 찾아 `meta/iloc` 위치의 TIFF를 읽는다
//!
//! 박스 헤더만 읽고 본문은 seek으로 건너뛰므로 큰 파일에서도 I/O가 작다.
//! Canon CR3는 `uuid` 박스 안에 전용 구조를 쓰므로 지원하지 않는다.

use std::io::{Read, Seek, SeekFrom};

use super::exif::{parse_tiff, ExifFields};

/// 한 번에 읽어들일 박스 본문 최대 크기.
const MAX_BOX_BODY_BYTES: u64 = 4 * 1024 * 1024;
/// Exif 아이템 최대 크기.
const MAX_EXIF_ITEM_BYTES: u64 = 1024 * 1024;
/// 한 계층에서 살펴볼 박스 최대 개수.
const MAX_BOXES_PER_LEVEL: usize = 256;

/// 1904-01-01T00:00:00Z 와 Unix epoch 사이의 초.
const MAC_EPOCH_OFFSET_SECONDS: u64 = 2_082_844_800;

struct BoxHeader {
    kind: [u8; 4],
    /// 헤더를 포함한 전체 크기. `None`은 파일 끝까지.
    size: Option<u64>,
    header_len: u64,
}

fn read_box_header<R: Read + Seek>(reader: &mut R) -> Option<BoxHeader> {
    let mut head = [0u8; 8];
    reader.read_exact(&mut head).ok()?;
    let size32 = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    let kind = [head[4], head[5], head[6], head[7]];
    match size32 {
        0 => Some(BoxHeader {
            kind,
            size: None,
            header_len: 8,
        }),
        1 => {
            let mut large = [0u8; 8];
            reader.read_exact(&mut large).ok()?;
            let size = u64::from_be_bytes(large);
            if size < 16 {
                return None;
            }
            Some(BoxHeader {
                kind,
                size: Some(size),
                header_len: 16,
            })
        }
        size if size < 8 => None,
        size => Some(BoxHeader {
            kind,
            size: Some(u64::from(size)),
            header_len: 8,
        }),
    }
}

/// `start..end` 범위에서 `kind` 박스를 찾아 (본문 시작, 본문 끝)을 돌려준다.
fn find_box<R: Read + Seek>(
    reader: &mut R,
    start: u64,
    end: Option<u64>,
    kind: &[u8; 4],
) -> Option<(u64, u64)> {
    let mut offset = start;
    for _ in 0..MAX_BOXES_PER_LEVEL {
        if end.is_some_and(|end| offset >= end) {
            return None;
        }
        reader.seek(SeekFrom::Start(offset)).ok()?;
        let header = read_box_header(reader)?;
        let body_start = offset.checked_add(header.header_len)?;
        let body_end = match header.size {
            Some(size) => offset.checked_add(size)?,
            None => end.unwrap_or_else(|| {
                reader
                    .seek(SeekFrom::End(0))
                    .unwrap_or(body_start)
                    .max(body_start)
            }),
        };
        if end.is_some_and(|end| body_end > end) {
            return None;
        }
        if &header.kind == kind {
            return Some((body_start, body_end));
        }
        header.size?;
        offset = body_end;
    }
    None
}

fn read_body<R: Read + Seek>(reader: &mut R, start: u64, end: u64) -> Option<Vec<u8>> {
    let length = end.checked_sub(start)?;
    if length > MAX_BOX_BODY_BYTES {
        return None;
    }
    reader.seek(SeekFrom::Start(start)).ok()?;
    let mut buffer = vec![0u8; usize::try_from(length).ok()?];
    reader.read_exact(&mut buffer).ok()?;
    Some(buffer)
}

/// MP4/MOV의 `mvhd` creation_time을 Unix 초로 돌려준다. 0이면 `None`.
pub fn read_mp4_creation_time<R: Read + Seek>(reader: &mut R) -> Option<u64> {
    let (moov_start, moov_end) = find_box(reader, 0, None, b"moov")?;
    let (mvhd_start, mvhd_end) = find_box(reader, moov_start, Some(moov_end), b"mvhd")?;
    let body = read_body(reader, mvhd_start, mvhd_end.min(mvhd_start + 32))?;
    let version = *body.first()?;
    let raw = match version {
        0 => u64::from(u32::from_be_bytes(body.get(4..8)?.try_into().ok()?)),
        1 => u64::from_be_bytes(body.get(4..12)?.try_into().ok()?),
        _ => return None,
    };
    if raw == 0 {
        return None;
    }
    raw.checked_sub(MAC_EPOCH_OFFSET_SECONDS)
}

fn be_u16(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        data.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn be_u32(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn be_uint(data: &[u8], offset: usize, size: usize) -> Option<u64> {
    let bytes = data.get(offset..offset.checked_add(size)?)?;
    let mut value = 0u64;
    for byte in bytes {
        value = value.checked_shl(8)? | u64::from(*byte);
    }
    Some(value)
}

/// `meta` 본문(FullBox 헤더 제외) 안의 `iinf`에서 item_type == "Exif"인 item_ID를 찾는다.
fn find_exif_item_id(meta: &[u8]) -> Option<u32> {
    let (iinf_start, iinf_end) = find_box_in_slice(meta, b"iinf")?;
    let iinf = meta.get(iinf_start..iinf_end)?;
    let version = *iinf.first()?;
    let (entry_count, mut offset) = if version == 0 {
        (u32::from(be_u16(iinf, 4)?), 6usize)
    } else {
        (be_u32(iinf, 4)?, 8usize)
    };
    for _ in 0..entry_count.min(MAX_BOXES_PER_LEVEL as u32) {
        let size = usize::try_from(be_u32(iinf, offset)?).ok()?;
        if size < 8 {
            return None;
        }
        let kind = iinf.get(offset + 4..offset + 8)?;
        if kind == b"infe" {
            let body = iinf.get(offset + 8..offset.checked_add(size)?)?;
            let infe_version = *body.first()?;
            let (item_id, type_offset) = match infe_version {
                2 => (u32::from(be_u16(body, 4)?), 8usize),
                3 => (be_u32(body, 4)?, 10usize),
                _ => (0, 0),
            };
            if type_offset > 0 && body.get(type_offset..type_offset + 4)? == b"Exif" {
                return Some(item_id);
            }
        }
        offset = offset.checked_add(size)?;
    }
    None
}

fn find_box_in_slice(data: &[u8], kind: &[u8; 4]) -> Option<(usize, usize)> {
    let mut offset = 0usize;
    for _ in 0..MAX_BOXES_PER_LEVEL {
        if offset >= data.len() {
            return None;
        }
        let size = usize::try_from(be_u32(data, offset)?).ok()?;
        let body_start = offset.checked_add(8)?;
        let body_end = if size == 0 {
            data.len()
        } else {
            offset.checked_add(size)?
        };
        if size != 0 && size < 8 || body_end > data.len() {
            return None;
        }
        if data.get(offset + 4..offset + 8)? == kind {
            return Some((body_start, body_end));
        }
        if size == 0 {
            return None;
        }
        offset = body_end;
    }
    None
}

/// `iloc`에서 item_id의 첫 번째 extent (파일 오프셋, 길이)를 찾는다. construction_method 0만 지원.
fn find_item_location(meta: &[u8], item_id: u32) -> Option<(u64, u64)> {
    let (iloc_start, iloc_end) = find_box_in_slice(meta, b"iloc")?;
    let iloc = meta.get(iloc_start..iloc_end)?;
    let version = *iloc.first()?;
    let sizes = *iloc.get(4)?;
    let offset_size = usize::from(sizes >> 4);
    let length_size = usize::from(sizes & 0x0F);
    let sizes2 = *iloc.get(5)?;
    let base_offset_size = usize::from(sizes2 >> 4);
    let index_size = if version >= 1 {
        usize::from(sizes2 & 0x0F)
    } else {
        0
    };
    let (item_count, mut offset) = if version < 2 {
        (u32::from(be_u16(iloc, 6)?), 8usize)
    } else {
        (be_u32(iloc, 6)?, 10usize)
    };

    for _ in 0..item_count.min(4096) {
        let current_id = if version < 2 {
            let value = u32::from(be_u16(iloc, offset)?);
            offset += 2;
            value
        } else {
            let value = be_u32(iloc, offset)?;
            offset += 4;
            value
        };
        let construction_method = if version >= 1 {
            let value = be_u16(iloc, offset)? & 0x0F;
            offset += 2;
            value
        } else {
            0
        };
        offset += 2; // data_reference_index
        let base_offset = be_uint(iloc, offset, base_offset_size)?;
        offset += base_offset_size;
        let extent_count = usize::from(be_u16(iloc, offset)?);
        offset += 2;
        for extent_index in 0..extent_count {
            offset += index_size;
            let extent_offset = be_uint(iloc, offset, offset_size)?;
            offset += offset_size;
            let extent_length = be_uint(iloc, offset, length_size)?;
            offset += length_size;
            if current_id == item_id && extent_index == 0 {
                if construction_method != 0 {
                    return None;
                }
                return Some((base_offset.checked_add(extent_offset)?, extent_length));
            }
        }
    }
    None
}

/// HEIF/HEIC/AVIF에서 Exif 아이템을 찾아 TIFF 필드를 읽는다.
pub fn read_heif_exif<R: Read + Seek>(reader: &mut R) -> Option<ExifFields> {
    let (meta_start, meta_end) = find_box(reader, 0, None, b"meta")?;
    // meta는 FullBox: version(1) + flags(3)
    let body = read_body(reader, meta_start.checked_add(4)?, meta_end)?;
    let item_id = find_exif_item_id(&body)?;
    let (item_offset, item_length) = find_item_location(&body, item_id)?;
    if !(4..=MAX_EXIF_ITEM_BYTES).contains(&item_length) {
        return None;
    }
    let item = read_body(reader, item_offset, item_offset.checked_add(item_length)?)?;
    // Exif 아이템: u32 exif_tiff_header_offset + 그 오프셋 뒤부터 TIFF
    let tiff_offset = usize::try_from(be_u32(&item, 0)?).ok()?;
    let tiff = item.get(4usize.checked_add(tiff_offset)?..)?;
    parse_tiff(tiff)
}

#[cfg(test)]
pub(crate) mod test_support {
    fn push_box(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
        out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
    }

    /// ftyp + mdat(앞) + moov/mvhd(뒤) 구조의 최소 MP4.
    pub fn build_mp4(creation_time_mac: u64, version1: bool, moov_first: bool) -> Vec<u8> {
        let mut out = Vec::new();
        push_box(&mut out, b"ftyp", b"isom\0\0\0\0isomiso2");
        let mut mvhd = Vec::new();
        if version1 {
            mvhd.extend_from_slice(&[1, 0, 0, 0]);
            mvhd.extend_from_slice(&creation_time_mac.to_be_bytes());
            mvhd.extend_from_slice(&creation_time_mac.to_be_bytes());
            mvhd.extend_from_slice(&1000u32.to_be_bytes());
            mvhd.extend_from_slice(&0u64.to_be_bytes());
        } else {
            mvhd.extend_from_slice(&[0, 0, 0, 0]);
            mvhd.extend_from_slice(&(creation_time_mac as u32).to_be_bytes());
            mvhd.extend_from_slice(&(creation_time_mac as u32).to_be_bytes());
            mvhd.extend_from_slice(&1000u32.to_be_bytes());
            mvhd.extend_from_slice(&0u32.to_be_bytes());
        }
        mvhd.resize(mvhd.len() + 80, 0);
        let mut moov = Vec::new();
        push_box(&mut moov, b"mvhd", &mvhd);
        let mdat = vec![0xABu8; 4096];
        if moov_first {
            push_box(&mut out, b"moov", &moov);
            push_box(&mut out, b"mdat", &mdat);
        } else {
            push_box(&mut out, b"mdat", &mdat);
            push_box(&mut out, b"moov", &moov);
        }
        out
    }

    /// ftyp + meta(hdlr, pitm, iinf[infe Exif], iloc) + mdat(Exif 아이템) 구조의 최소 HEIF.
    pub fn build_heif(tiff: &[u8]) -> Vec<u8> {
        let mut exif_item = 0u32.to_be_bytes().to_vec();
        exif_item.extend_from_slice(tiff);

        // 레이아웃을 먼저 계산하기 위해 두 번 생성한다.
        let build = |exif_offset: u32| -> Vec<u8> {
            let mut out = Vec::new();
            push_box(&mut out, b"ftyp", b"heic\0\0\0\0mif1heic");

            let mut meta = vec![0, 0, 0, 0];
            let mut hdlr = vec![0, 0, 0, 0, 0, 0, 0, 0];
            hdlr.extend_from_slice(b"pict");
            hdlr.resize(hdlr.len() + 13, 0);
            push_box(&mut meta, b"hdlr", &hdlr);
            push_box(&mut meta, b"pitm", &[0, 0, 0, 0, 0, 1]);

            let mut iinf = vec![0, 0, 0, 0, 0, 2];
            let mut infe_primary = vec![2, 0, 0, 0];
            infe_primary.extend_from_slice(&1u16.to_be_bytes());
            infe_primary.extend_from_slice(&0u16.to_be_bytes());
            infe_primary.extend_from_slice(b"hvc1");
            infe_primary.push(0);
            push_box(&mut iinf, b"infe", &infe_primary);
            let mut infe_exif = vec![2, 0, 0, 0];
            infe_exif.extend_from_slice(&2u16.to_be_bytes());
            infe_exif.extend_from_slice(&0u16.to_be_bytes());
            infe_exif.extend_from_slice(b"Exif");
            infe_exif.push(0);
            push_box(&mut iinf, b"infe", &infe_exif);
            push_box(&mut meta, b"iinf", &iinf);

            // iloc version 1: offset_size 4, length_size 4, base_offset_size 0, index_size 0
            let mut iloc = vec![1, 0, 0, 0, 0x44, 0x00];
            iloc.extend_from_slice(&1u16.to_be_bytes()); // item_count
            iloc.extend_from_slice(&2u16.to_be_bytes()); // item_ID
            iloc.extend_from_slice(&0u16.to_be_bytes()); // construction_method
            iloc.extend_from_slice(&0u16.to_be_bytes()); // data_reference_index
            iloc.extend_from_slice(&1u16.to_be_bytes()); // extent_count
            iloc.extend_from_slice(&exif_offset.to_be_bytes());
            iloc.extend_from_slice(&(exif_item.len() as u32).to_be_bytes());
            push_box(&mut meta, b"iloc", &iloc);
            push_box(&mut out, b"meta", &meta);

            let mdat_body_offset = out.len() + 8;
            let mut mdat = exif_item.clone();
            mdat.extend_from_slice(&[0x55u8; 256]);
            push_box(&mut out, b"mdat", &mdat);
            out.extend_from_slice(&(mdat_body_offset as u32).to_be_bytes());
            out
        };
        let mut first = build(0);
        let actual_offset =
            u32::from_be_bytes(first[first.len() - 4..].try_into().expect("offset"));
        first.truncate(first.len() - 4);
        let mut out = build(actual_offset);
        out.truncate(out.len() - 4);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{build_heif, build_mp4};
    use super::*;
    use crate::save_rules::exif::test_support::TiffBuilder;
    use std::io::Cursor;

    #[test]
    fn reads_mvhd_creation_time_in_both_versions_and_layouts() {
        let mac_time = MAC_EPOCH_OFFSET_SECONDS + 1_800_000_000;
        for version1 in [false, true] {
            for moov_first in [true, false] {
                let data = build_mp4(mac_time, version1, moov_first);
                let mut cursor = Cursor::new(data);
                assert_eq!(
                    read_mp4_creation_time(&mut cursor),
                    Some(1_800_000_000),
                    "version1={version1} moov_first={moov_first}"
                );
            }
        }
    }

    #[test]
    fn zero_creation_time_is_none() {
        let mut cursor = Cursor::new(build_mp4(0, false, true));
        assert_eq!(read_mp4_creation_time(&mut cursor), None);
    }

    #[test]
    fn truncated_mp4_does_not_panic() {
        let data = build_mp4(MAC_EPOCH_OFFSET_SECONDS + 10, false, false);
        for length in (0..data.len()).step_by(7) {
            let mut cursor = Cursor::new(data[..length].to_vec());
            let _ = read_mp4_creation_time(&mut cursor);
        }
    }

    #[test]
    fn reads_heif_exif_item() {
        let tiff = TiffBuilder {
            little_endian: false,
            model: Some("ILCE-7RM5".to_string()),
            date_time_original: Some("2026:01:02 03:04:05".to_string()),
            iso: Some(100),
            ..TiffBuilder::default()
        }
        .build();
        let heif = build_heif(&tiff);
        let mut cursor = Cursor::new(heif.clone());
        let fields = read_heif_exif(&mut cursor).expect("exif");
        assert_eq!(fields.model.as_deref(), Some("ILCE-7RM5"));
        assert_eq!(
            fields.date_time_original.as_deref(),
            Some("2026:01:02 03:04:05")
        );
        for length in (0..heif.len()).step_by(5) {
            let mut cursor = Cursor::new(heif[..length].to_vec());
            let _ = read_heif_exif(&mut cursor);
        }
    }
}
