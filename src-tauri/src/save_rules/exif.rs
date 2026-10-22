//! 의존성 없는 최소 EXIF 리더.
//!
//! JPEG(APP1 Exif), TIFF 계열 RAW(ARW/NEF/CR2/DNG/ORF/RW2 등), Fuji RAF(내장 JPEG)에서
//! 파일명 규칙에 필요한 필드만 읽는다. 신뢰할 수 없는 외부 미디어이므로
//! 범위를 벗어나는 오프셋은 모두 `None`으로 처리한다.

const EXIF_IFD_POINTER_TAG: u16 = 0x8769;
const MAKE_TAG: u16 = 0x010F;
const MODEL_TAG: u16 = 0x0110;
const DATE_TIME_TAG: u16 = 0x0132;
const EXPOSURE_TIME_TAG: u16 = 0x829A;
const F_NUMBER_TAG: u16 = 0x829D;
const ISO_TAG: u16 = 0x8827;
const DATE_TIME_ORIGINAL_TAG: u16 = 0x9003;
const FOCAL_LENGTH_TAG: u16 = 0x920A;
const BODY_SERIAL_NUMBER_TAG: u16 = 0xA431;

const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5;

/// 허용하는 TIFF 매직: 표준(42), Olympus ORF("RO"/"OR"), Panasonic RW2(0x55).
const TIFF_MAGICS: &[u16] = &[42, 0x4F52, 0x5352, 0x55];
/// IFD 하나에서 읽을 최대 엔트리 수 (손상된 파일 방어).
const MAX_IFD_ENTRIES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rational {
    pub numerator: u32,
    pub denominator: u32,
}

impl Rational {
    pub fn as_f64(self) -> Option<f64> {
        if self.denominator == 0 {
            return None;
        }
        Some(f64::from(self.numerator) / f64::from(self.denominator))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExifFields {
    pub make: Option<String>,
    pub model: Option<String>,
    pub body_serial: Option<String>,
    pub date_time_original: Option<String>,
    pub date_time: Option<String>,
    pub exposure_time: Option<Rational>,
    pub f_number: Option<Rational>,
    pub iso: Option<u32>,
    pub focal_length: Option<Rational>,
}

impl ExifFields {
    fn is_empty(&self) -> bool {
        self == &ExifFields::default()
    }
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

struct Entry {
    tag: u16,
    field_type: u16,
    count: u32,
    /// 엔트리의 값/오프셋 필드 위치 (entry + 8)
    value_field_offset: usize,
}

fn type_size(field_type: u16) -> Option<usize> {
    match field_type {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

fn value_offset(tiff: &[u8], entry: &Entry, order: ByteOrder) -> Option<usize> {
    let size = type_size(entry.field_type)?;
    let total = size.checked_mul(usize::try_from(entry.count).ok()?)?;
    if total <= 4 {
        Some(entry.value_field_offset)
    } else {
        usize::try_from(read_u32(tiff, entry.value_field_offset, order)?).ok()
    }
}

fn read_ascii(tiff: &[u8], entry: &Entry, order: ByteOrder) -> Option<String> {
    if entry.field_type != TYPE_ASCII {
        return None;
    }
    let count = usize::try_from(entry.count).ok()?;
    let offset = value_offset(tiff, entry, order)?;
    let raw = tiff.get(offset..offset.checked_add(count)?)?;
    let text = String::from_utf8_lossy(raw);
    let trimmed = text.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }
    Some(trimmed.to_string())
}

fn read_rational(tiff: &[u8], entry: &Entry, order: ByteOrder) -> Option<Rational> {
    if entry.field_type != TYPE_RATIONAL || entry.count == 0 {
        return None;
    }
    let offset = value_offset(tiff, entry, order)?;
    Some(Rational {
        numerator: read_u32(tiff, offset, order)?,
        denominator: read_u32(tiff, offset.checked_add(4)?, order)?,
    })
}

fn read_unsigned(tiff: &[u8], entry: &Entry, order: ByteOrder) -> Option<u32> {
    if entry.count == 0 {
        return None;
    }
    let offset = value_offset(tiff, entry, order)?;
    match entry.field_type {
        TYPE_SHORT => read_u16(tiff, offset, order).map(u32::from),
        TYPE_LONG => read_u32(tiff, offset, order),
        _ => None,
    }
}

fn for_each_entry(
    tiff: &[u8],
    ifd_offset: usize,
    order: ByteOrder,
    mut visit: impl FnMut(&Entry),
) -> Option<()> {
    let entry_count = usize::from(read_u16(tiff, ifd_offset, order)?).min(MAX_IFD_ENTRIES);
    for index in 0..entry_count {
        let entry_offset = ifd_offset
            .checked_add(2)?
            .checked_add(index.checked_mul(12)?)?;
        let entry = Entry {
            tag: read_u16(tiff, entry_offset, order)?,
            field_type: read_u16(tiff, entry_offset.checked_add(2)?, order)?,
            count: read_u32(tiff, entry_offset.checked_add(4)?, order)?,
            value_field_offset: entry_offset.checked_add(8)?,
        };
        visit(&entry);
    }
    Some(())
}

/// TIFF 헤더부터 시작하는 바이트에서 필드를 읽는다.
pub fn parse_tiff(tiff: &[u8]) -> Option<ExifFields> {
    let order = match tiff.get(0..2)? {
        b"II" => ByteOrder::Little,
        b"MM" => ByteOrder::Big,
        _ => return None,
    };
    if !TIFF_MAGICS.contains(&read_u16(tiff, 2, order)?) {
        return None;
    }
    let ifd0 = usize::try_from(read_u32(tiff, 4, order)?).ok()?;

    let mut fields = ExifFields::default();
    let mut exif_ifd: Option<usize> = None;
    for_each_entry(tiff, ifd0, order, |entry| match entry.tag {
        MAKE_TAG => fields.make = read_ascii(tiff, entry, order),
        MODEL_TAG => fields.model = read_ascii(tiff, entry, order),
        DATE_TIME_TAG => fields.date_time = read_ascii(tiff, entry, order),
        EXIF_IFD_POINTER_TAG => {
            exif_ifd = read_u32(tiff, entry.value_field_offset, order)
                .and_then(|value| usize::try_from(value).ok());
        }
        _ => {}
    })?;

    if let Some(exif_ifd) = exif_ifd {
        for_each_entry(tiff, exif_ifd, order, |entry| match entry.tag {
            DATE_TIME_ORIGINAL_TAG => fields.date_time_original = read_ascii(tiff, entry, order),
            EXPOSURE_TIME_TAG => fields.exposure_time = read_rational(tiff, entry, order),
            F_NUMBER_TAG => fields.f_number = read_rational(tiff, entry, order),
            ISO_TAG => fields.iso = read_unsigned(tiff, entry, order),
            FOCAL_LENGTH_TAG => fields.focal_length = read_rational(tiff, entry, order),
            BODY_SERIAL_NUMBER_TAG => fields.body_serial = read_ascii(tiff, entry, order),
            _ => {}
        });
    }

    if fields.is_empty() {
        None
    } else {
        Some(fields)
    }
}

/// JPEG 바이트의 APP1 Exif 세그먼트에서 필드를 읽는다.
pub fn parse_jpeg(data: &[u8]) -> Option<ExifFields> {
    if data.get(0..2)? != [0xFF, 0xD8] {
        return None;
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
        // 패딩 0xFF 또는 길이 없는 마커(RSTn, SOI, TEM)는 건너뛴다.
        if marker == 0xFF {
            offset = offset.checked_add(1)?;
            continue;
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 || marker == 0xD8 {
            offset = offset.checked_add(2)?;
            continue;
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
            if let Some(fields) = parse_tiff(tiff) {
                return Some(fields);
            }
        }
        offset = segment_end;
    }
}

/// Fuji RAF: 헤더 84..88 바이트에 내장 JPEG 오프셋이 있다.
pub fn parse_raf(data: &[u8]) -> Option<ExifFields> {
    if data.get(0..16)? != b"FUJIFILMCCD-RAW " {
        return None;
    }
    let jpeg_offset = usize::try_from(read_u32(data, 84, ByteOrder::Big)?).ok()?;
    parse_jpeg(data.get(jpeg_offset..)?)
}

/// JPEG·TIFF·RAF 중 형식을 자동 판별해 EXIF 필드를 읽는다.
pub fn parse_exif(data: &[u8]) -> Option<ExifFields> {
    if data.get(0..2)? == [0xFF, 0xD8] {
        return parse_jpeg(data);
    }
    if data.starts_with(b"FUJIFILMCCD-RAW ") {
        return parse_raf(data);
    }
    parse_tiff(data)
}

#[cfg(test)]
pub(crate) mod test_support {
    /// 테스트용 최소 TIFF 생성기. IFD0(Make/Model/ExifIFD) + Exif IFD(여러 태그).
    #[derive(Default)]
    pub struct TiffBuilder {
        pub little_endian: bool,
        pub make: Option<String>,
        pub model: Option<String>,
        pub body_serial: Option<String>,
        pub date_time_original: Option<String>,
        pub f_number: Option<(u32, u32)>,
        pub exposure_time: Option<(u32, u32)>,
        pub focal_length: Option<(u32, u32)>,
        pub iso: Option<u16>,
    }

    struct Field {
        tag: u16,
        field_type: u16,
        count: u32,
        /// 4바이트 이하면 인라인, 아니면 데이터 블록에 저장
        payload: Vec<u8>,
    }

    impl TiffBuilder {
        fn put16(&self, value: u16) -> [u8; 2] {
            if self.little_endian {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            }
        }

        fn put32(&self, value: u32) -> [u8; 4] {
            if self.little_endian {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            }
        }

        fn ascii(tag: u16, value: &str) -> Field {
            let mut payload = value.as_bytes().to_vec();
            payload.push(0);
            Field {
                tag,
                field_type: 2,
                count: payload.len() as u32,
                payload,
            }
        }

        fn rational(&self, tag: u16, value: (u32, u32)) -> Field {
            let mut payload = self.put32(value.0).to_vec();
            payload.extend_from_slice(&self.put32(value.1));
            Field {
                tag,
                field_type: 5,
                count: 1,
                payload,
            }
        }

        fn short(&self, tag: u16, value: u16) -> Field {
            Field {
                tag,
                field_type: 3,
                count: 1,
                payload: self.put16(value).to_vec(),
            }
        }

        /// IFD를 `ifd_offset`에 쓰고, 큰 값은 `data`의 끝에 붙인다.
        fn write_ifd(
            &self,
            out: &mut Vec<u8>,
            ifd_offset: usize,
            fields: &[Field],
            next_data_offset: &mut usize,
        ) {
            assert_eq!(out.len(), ifd_offset);
            out.extend_from_slice(&self.put16(fields.len() as u16));
            let mut deferred: Vec<(usize, &Field)> = Vec::new();
            for field in fields {
                out.extend_from_slice(&self.put16(field.tag));
                out.extend_from_slice(&self.put16(field.field_type));
                out.extend_from_slice(&self.put32(field.count));
                if field.payload.len() <= 4 {
                    let mut inline = [0u8; 4];
                    inline[..field.payload.len()].copy_from_slice(&field.payload);
                    out.extend_from_slice(&inline);
                } else {
                    out.extend_from_slice(&self.put32(*next_data_offset as u32));
                    deferred.push((*next_data_offset, field));
                    *next_data_offset += field.payload.len();
                    // 2바이트 정렬
                    if *next_data_offset % 2 == 1 {
                        *next_data_offset += 1;
                    }
                }
            }
            out.extend_from_slice(&self.put32(0));
            for (offset, field) in deferred {
                while out.len() < offset {
                    out.push(0);
                }
                out.extend_from_slice(&field.payload);
            }
            while out.len() < *next_data_offset {
                out.push(0);
            }
        }

        pub fn build(&self) -> Vec<u8> {
            let mut ifd0_fields = Vec::new();
            if let Some(make) = &self.make {
                ifd0_fields.push(Self::ascii(0x010F, make));
            }
            if let Some(model) = &self.model {
                ifd0_fields.push(Self::ascii(0x0110, model));
            }
            let mut exif_fields = Vec::new();
            if let Some(value) = self.exposure_time {
                exif_fields.push(self.rational(0x829A, value));
            }
            if let Some(value) = self.f_number {
                exif_fields.push(self.rational(0x829D, value));
            }
            if let Some(value) = self.iso {
                exif_fields.push(self.short(0x8827, value));
            }
            if let Some(value) = &self.date_time_original {
                exif_fields.push(Self::ascii(0x9003, value));
            }
            if let Some(value) = self.focal_length {
                exif_fields.push(self.rational(0x920A, value));
            }
            if let Some(value) = &self.body_serial {
                exif_fields.push(Self::ascii(0xA431, value));
            }

            // 레이아웃: 헤더(8) | IFD0 | IFD0 데이터 | Exif IFD | Exif 데이터
            let ifd0_offset = 8usize;
            let ifd0_size = 2 + 12 * (ifd0_fields.len() + 1) + 4;
            let ifd0_data_size: usize = ifd0_fields
                .iter()
                .filter(|f| f.payload.len() > 4)
                .map(|f| f.payload.len() + f.payload.len() % 2)
                .sum();
            let exif_ifd_offset = ifd0_offset + ifd0_size + ifd0_data_size;

            let mut out = Vec::new();
            out.extend_from_slice(if self.little_endian { b"II" } else { b"MM" });
            out.extend_from_slice(&self.put16(42));
            out.extend_from_slice(&self.put32(ifd0_offset as u32));

            let exif_pointer = Field {
                tag: 0x8769,
                field_type: 4,
                count: 1,
                payload: self.put32(exif_ifd_offset as u32).to_vec(),
            };
            ifd0_fields.push(exif_pointer);
            ifd0_fields.sort_by_key(|f| f.tag);
            let mut next_data = ifd0_offset + ifd0_size;
            self.write_ifd(&mut out, ifd0_offset, &ifd0_fields, &mut next_data);
            assert_eq!(out.len(), exif_ifd_offset);

            exif_fields.sort_by_key(|f| f.tag);
            let exif_size = 2 + 12 * exif_fields.len() + 4;
            let mut next_data = exif_ifd_offset + exif_size;
            self.write_ifd(&mut out, exif_ifd_offset, &exif_fields, &mut next_data);
            out
        }

        pub fn build_jpeg(&self) -> Vec<u8> {
            let tiff = self.build();
            let mut data = vec![0xFF, 0xD8];
            // 앞에 다른 APP 세그먼트(JFIF) 하나
            data.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00]);
            let length = (tiff.len() + 8) as u16;
            data.extend_from_slice(&[0xFF, 0xE1]);
            data.extend_from_slice(&length.to_be_bytes());
            data.extend_from_slice(b"Exif\0\0");
            data.extend_from_slice(&tiff);
            data.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02]);
            data
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::TiffBuilder;
    use super::*;

    fn sample(little_endian: bool) -> TiffBuilder {
        TiffBuilder {
            little_endian,
            make: Some("SONY".to_string()),
            model: Some("ILCE-7RM5".to_string()),
            body_serial: Some("03407347".to_string()),
            date_time_original: Some("2026:10:22 14:03:55".to_string()),
            f_number: Some((28, 10)),
            exposure_time: Some((1, 250)),
            focal_length: Some((35, 1)),
            iso: Some(400),
        }
    }

    #[test]
    fn parses_tiff_fields_both_byte_orders() {
        for little_endian in [true, false] {
            let fields = parse_tiff(&sample(little_endian).build()).expect("fields");
            assert_eq!(fields.make.as_deref(), Some("SONY"));
            assert_eq!(fields.model.as_deref(), Some("ILCE-7RM5"));
            assert_eq!(fields.body_serial.as_deref(), Some("03407347"));
            assert_eq!(
                fields.date_time_original.as_deref(),
                Some("2026:10:22 14:03:55")
            );
            assert_eq!(
                fields.f_number,
                Some(Rational {
                    numerator: 28,
                    denominator: 10
                })
            );
            assert_eq!(
                fields.exposure_time,
                Some(Rational {
                    numerator: 1,
                    denominator: 250
                })
            );
            assert_eq!(fields.iso, Some(400));
            assert_eq!(fields.focal_length.and_then(Rational::as_f64), Some(35.0));
        }
    }

    #[test]
    fn parses_jpeg_app1_segment() {
        let fields = parse_exif(&sample(true).build_jpeg()).expect("fields");
        assert_eq!(fields.model.as_deref(), Some("ILCE-7RM5"));
        assert_eq!(fields.iso, Some(400));
    }

    #[test]
    fn parses_raf_embedded_jpeg() {
        let jpeg = sample(false).build_jpeg();
        let mut raf = b"FUJIFILMCCD-RAW 0201FF129502".to_vec();
        raf.resize(84, 0);
        let jpeg_offset = 160u32;
        raf.extend_from_slice(&jpeg_offset.to_be_bytes());
        raf.resize(jpeg_offset as usize, 0);
        raf.extend_from_slice(&jpeg);
        let fields = parse_exif(&raf).expect("fields");
        assert_eq!(fields.make.as_deref(), Some("SONY"));
    }

    #[test]
    fn truncated_or_corrupt_data_returns_none_or_partial() {
        let tiff = sample(true).build();
        for length in 0..tiff.len() {
            // 어떤 길이에서도 패닉하지 않아야 한다.
            let _ = parse_exif(&tiff[..length]);
        }
        let mut bad_magic = tiff.clone();
        bad_magic[2] = 0x99;
        bad_magic[3] = 0x99;
        assert_eq!(parse_tiff(&bad_magic), None);
        let mut bad_ifd = tiff.clone();
        bad_ifd[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(parse_tiff(&bad_ifd), None);
        assert_eq!(parse_exif(&[0xFF, 0xD8, 0xFF, 0xDA]), None);
    }

    #[test]
    fn accepts_orf_and_rw2_magic() {
        let mut orf = sample(true).build();
        orf[2..4].copy_from_slice(&0x4F52u16.to_le_bytes());
        assert!(parse_tiff(&orf).is_some());
        let mut rw2 = sample(true).build();
        rw2[2..4].copy_from_slice(&0x55u16.to_le_bytes());
        assert!(parse_tiff(&rw2).is_some());
    }
}
