//! Fixed, licensed font subsets. No installed font or network access is needed.
use crate::error::{AppError, AppResult};
use encoding_rs::WINDOWS_1252;
use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use std::collections::BTreeSet;

struct EmbeddedFont {
    name: &'static str,
    bytes: &'static [u8],
    widths: [u16; 256],
    bbox: [i32; 4],
    ascent: i32,
    descent: i32,
    cap_height: i32,
    italic_angle: f32,
    flags: i32,
    stem_v: i32,
}
#[path = "document_embedded_font_data.rs"]
mod data;

pub(super) fn width(index: usize, byte: u8) -> f32 {
    data::FONTS[index - 12].widths[byte as usize] as f32
}

fn unicode_map() -> Vec<u8> {
    let mut mappings = vec![];
    for byte in 32u8..=255 {
        let input = [byte];
        let (text, error) = WINDOWS_1252.decode_without_bom_handling(&input);
        if !error {
            if let Some(character) = text.chars().next().filter(|c| !c.is_control()) {
                mappings.push(format!("<{byte:02X}> <{:04X}>\n", character as u32));
            }
        }
    }
    let mut map = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /ZentraWinAnsi def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n");
    for chunk in mappings.chunks(100) {
        map.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for mapping in chunk {
            map.push_str(mapping);
        }
        map.push_str("endbfchar\n");
    }
    map.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    map.into_bytes()
}

pub(super) fn add_used(
    pdf: &mut Document,
    resources: &mut Dictionary,
    used: &BTreeSet<usize>,
) -> AppResult<()> {
    // Each variant is included at most once, and only when actually used by a
    // page, a footer or its page number. Legacy standard-font PDFs stay small.
    for index in used.iter().copied().filter(|index| *index >= 12) {
        let font = data::FONTS.get(index - 12).ok_or_else(|| {
            AppError::Validation("Choisissez une police disponible dans l’atelier.".into())
        })?;
        let file = pdf.add_object(Stream::new(
            dictionary! { "Length1" => font.bytes.len() as i64 },
            font.bytes.to_vec(),
        ));
        let descriptor = pdf.add_object(dictionary! {
            "Type" => "FontDescriptor", "FontName" => font.name,
            "Flags" => font.flags, "FontBBox" => font.bbox.iter().map(|v| Object::Integer(*v as i64)).collect::<Vec<_>>(),
            "ItalicAngle" => font.italic_angle, "Ascent" => font.ascent,
            "Descent" => font.descent, "CapHeight" => font.cap_height,
            "StemV" => font.stem_v, "FontFile2" => file,
        });
        let unicode = pdf.add_object(Stream::new(dictionary! {}, unicode_map()));
        let id = pdf.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => font.name,
            "Encoding" => "WinAnsiEncoding", "FirstChar" => 0, "LastChar" => 255,
            "Widths" => font.widths.iter().map(|v| Object::Integer(*v as i64)).collect::<Vec<_>>(),
            "FontDescriptor" => descriptor, "ToUnicode" => unicode,
        });
        resources.set(format!("C{index}"), id);
    }
    Ok(())
}
