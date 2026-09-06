use crate::{
    error::{AppError, AppResult},
    sales_pdf::helvetica_text_width,
};
use encoding_rs::WINDOWS_1252;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, Stream, StringFormat,
};
use std::collections::BTreeMap;

#[derive(Clone)]
pub(crate) enum FormValue {
    Text(String),
    Check(bool),
}

/// Fill the official AFC form while keeping canonical values and visible widget
/// appearances in agreement. The original form and its layout remain intact.
pub(crate) fn certificate_pdf(
    values: &BTreeMap<String, FormValue>,
    annex: &[String],
) -> AppResult<Vec<u8>> {
    let mut pdf = Document::load_mem(include_bytes!(
        "../assets/swiss-salary-certificate-form11.pdf"
    ))
    .map_err(|e| AppError::Validation(format!("Le formulaire officiel est illisible : {e}")))?;
    let root_id = pdf.trailer.get(b"Root")?.as_reference()?;
    let form_id = pdf
        .get_dictionary(root_id)?
        .get(b"AcroForm")?
        .as_reference()?;
    let fields = pdf
        .dereference(pdf.get_dictionary(form_id)?.get(b"Fields")?)?
        .1
        .as_array()?
        .clone();
    let mut field_ids = BTreeMap::new();
    for reference in fields {
        let id = reference.as_reference()?;
        let name =
            String::from_utf8_lossy(pdf.get_dictionary(id)?.get(b"T")?.as_str()?).into_owned();
        if field_ids.insert(name, id).is_some() {
            return Err(AppError::Validation(
                "Le formulaire contient des champs ambigus.".into(),
            ));
        }
    }
    if values.keys().any(|key| !field_ids.contains_key(key)) {
        return Err(AppError::Validation(
            "Une rubrique du certificat est inconnue.".into(),
        ));
    }
    let font_id = pdf.add_object(dictionary! {"Type"=>"Font", "Subtype"=>"Type1", "BaseFont"=>"Helvetica", "Encoding"=>"WinAnsiEncoding"});
    let mut complete_values = values.clone();
    for (name, id) in &field_ids {
        if pdf.get_dictionary(*id)?.get(b"FT")?.as_name()? == b"Tx" {
            complete_values
                .entry(name.clone())
                .or_insert_with(|| FormValue::Text(String::new()));
        }
    }
    for (name, value) in &complete_values {
        let id = field_ids[name];
        let original = pdf.get_dictionary(id)?.clone();
        match value {
            FormValue::Check(checked) => {
                let appearances = original.get(b"AP")?.as_dict()?.get(b"N")?.as_dict()?;
                let state = if *checked {
                    appearances
                        .iter()
                        .find(|(key, _)| key.as_slice() != b"Off")
                        .map(|(key, _)| key.clone())
                        .ok_or_else(|| AppError::Validation("Case officielle invalide.".into()))?
                } else {
                    b"Off".to_vec()
                };
                let rect = original.get(b"Rect")?.as_array()?;
                let width = rect[2].as_float()? - rect[0].as_float()?;
                let height = rect[3].as_float()? - rect[1].as_float()?;
                let mut drawing = String::new();
                if *checked {
                    let side = (width.min(height) - 6.0).max(2.0);
                    let x = (width - side) / 2.0;
                    let y = (height - side) / 2.0;
                    drawing = format!(
                        "q 0 G 0.8 w {x} {y} m {} {} l S {x} {} m {} {y} l S Q",
                        x + side,
                        y + side,
                        y + side,
                        x + side
                    );
                }
                let appearance=pdf.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Form","BBox"=>vec![0.into(),0.into(),Object::Real(width),Object::Real(height)]},drawing.into_bytes()));
                let mut normal = appearances.clone();
                normal.set(state.clone(), appearance);
                let field = pdf.get_dictionary_mut(id)?;
                field.set("V", Object::Name(state.clone()));
                field.set("AS", Object::Name(state));
                field.set("AP", dictionary! {"N"=>normal});
            }
            FormValue::Text(value) => {
                if value.len() > 1500 || value.chars().any(|c| c.is_control() && c != '\n') {
                    return Err(AppError::Validation(
                        "Une rubrique du certificat contient un texte invalide ou trop long."
                            .into(),
                    ));
                }
                let rect = original.get(b"Rect")?.as_array()?;
                let number = |i: usize| -> AppResult<f32> { Ok(rect[i].as_float()?) };
                let width = number(2)? - number(0)?;
                let height = number(3)? - number(1)?;
                let multiline = name.starts_with("TextMehrzeilig");
                let mut size = if multiline { 9.0 } else { 8.5 };
                if !multiline && !value.is_empty() {
                    let measured = helvetica_text_width(value, size, false);
                    if measured > width - 5.0 {
                        size *= (width - 5.0) / measured;
                    }
                    if size < 6.5 {
                        return Err(AppError::Validation("Un texte dépasse la place disponible sur le formulaire. Raccourcissez les coordonnées ou les libellés.".into()));
                    }
                }
                let mut lines = vec![];
                for line in value.split('\n') {
                    let mut current = String::new();
                    for word in line.split_whitespace() {
                        let candidate = if current.is_empty() {
                            word.to_owned()
                        } else {
                            format!("{current} {word}")
                        };
                        if multiline
                            && !current.is_empty()
                            && helvetica_text_width(&candidate, size, false) > width - 5.0
                        {
                            lines.push(current);
                            current = word.into();
                        } else {
                            current = candidate;
                        }
                    }
                    lines.push(current);
                }
                if lines.len() as f32 * size * 1.18 > height - 2.0 {
                    return Err(AppError::Validation(
                        "Les coordonnées dépassent la place disponible sur le formulaire.".into(),
                    ));
                }
                let mut ops = vec![
                    Operation::new("q", vec![]),
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec![Object::Name(b"FZ".to_vec()), size.into()]),
                    Operation::new("g", vec![0.into()]),
                ];
                let numeric = name.starts_with("DezZahl");
                for (index, line) in lines.iter().enumerate() {
                    let (encoded, _, invalid) = WINDOWS_1252.encode(line);
                    if invalid {
                        return Err(AppError::Validation("Un caractère ne peut pas être imprimé dans ce formulaire. Utilisez sa transcription latine.".into()));
                    }
                    let x = if numeric {
                        (width - 3.0 - helvetica_text_width(line, size, false)).max(2.0)
                    } else {
                        2.0
                    };
                    let y = if multiline {
                        height - size - 2.0 - index as f32 * size * 1.18
                    } else {
                        (height - size) / 2.0 + 1.0
                    };
                    ops.push(Operation::new(
                        "Tm",
                        vec![1.into(), 0.into(), 0.into(), 1.into(), x.into(), y.into()],
                    ));
                    ops.push(Operation::new(
                        "Tj",
                        vec![Object::String(encoded.into_owned(), StringFormat::Literal)],
                    ));
                }
                ops.push(Operation::new("ET", vec![]));
                ops.push(Operation::new("Q", vec![]));
                let content = Content { operations: ops }.encode()?;
                let appearance = pdf.add_object(Stream::new(dictionary! { "Type"=>"XObject", "Subtype"=>"Form", "BBox"=>vec![0.into(),0.into(),Object::Real(width),Object::Real(height)], "Resources"=>dictionary!{"Font"=>dictionary!{"FZ"=>font_id}} }, content));
                let mut unicode = vec![0xfe, 0xff];
                for unit in value.encode_utf16() {
                    unicode.extend_from_slice(&unit.to_be_bytes());
                }
                let field = pdf.get_dictionary_mut(id)?;
                field.set("V", Object::String(unicode, StringFormat::Hexadecimal));
                field.set("AP", dictionary! {"N"=>appearance});
                field.remove(b"AA");
            }
        }
    }
    pdf.get_dictionary_mut(form_id)?
        .set("NeedAppearances", false);
    pdf.get_dictionary_mut(root_id)?.remove(b"OpenAction");
    if !annex.is_empty() {
        let mut lines = vec![];
        for paragraph in annex {
            let mut current = String::new();
            for word in paragraph.split_whitespace() {
                if helvetica_text_width(word, 10.0, false) > 505.0 {
                    return Err(AppError::Validation(
                        "Un mot de l’annexe est trop long. Ajoutez des espaces.".into(),
                    ));
                }
                let candidate = if current.is_empty() {
                    word.into()
                } else {
                    format!("{current} {word}")
                };
                if helvetica_text_width(&candidate, 10.0, false) > 505.0 {
                    lines.push(current);
                    current = word.into();
                } else {
                    current = candidate;
                }
            }
            lines.push(current);
            lines.push(String::new());
        }
        if lines.len() > 850 {
            return Err(AppError::Validation(
                "Le détail du certificat dépasse 17 pages d’annexe. Regroupez les libellés.".into(),
            ));
        }
        let pages_id = pdf.get_dictionary(root_id)?.get(b"Pages")?.as_reference()?;
        let mut kids = pdf
            .get_dictionary(pages_id)?
            .get(b"Kids")?
            .as_array()?
            .clone();
        let old_count = pdf.get_dictionary(pages_id)?.get(b"Count")?.as_i64()?;
        let mut added = 0;
        for (index, chunk) in lines.chunks(50).enumerate() {
            let mut ops = vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(b"FZ".to_vec()), 10.into()]),
            ];
            for (line_index, line) in chunk.iter().enumerate() {
                let (encoded, _, invalid) = WINDOWS_1252.encode(line);
                if invalid {
                    return Err(AppError::Validation(
                        "Un caractère de l’annexe nécessite une transcription latine.".into(),
                    ));
                }
                ops.push(Operation::new(
                    "Tm",
                    vec![
                        1.into(),
                        0.into(),
                        0.into(),
                        1.into(),
                        45.into(),
                        Object::Real(790.0 - line_index as f32 * 14.0),
                    ],
                ));
                ops.push(Operation::new(
                    "Tj",
                    vec![Object::String(encoded.into_owned(), StringFormat::Literal)],
                ));
            }
            ops.push(Operation::new(
                "Tm",
                vec![1.into(), 0.into(), 0.into(), 1.into(), 45.into(), 35.into()],
            ));
            ops.push(Operation::new(
                "Tj",
                vec![Object::string_literal(format!(
                    "Annexe - page {}",
                    index + 1
                ))],
            ));
            ops.push(Operation::new("ET", vec![]));
            let content = pdf.add_object(Stream::new(
                dictionary! {},
                Content { operations: ops }.encode()?,
            ));
            let page=pdf.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"MediaBox"=>vec![0.into(),0.into(),595.into(),842.into()],"Contents"=>content,"Resources"=>dictionary!{"Font"=>dictionary!{"FZ"=>font_id}}});
            kids.push(page.into());
            added += 1;
        }
        pdf.get_dictionary_mut(pages_id)?.set("Kids", kids);
        pdf.get_dictionary_mut(pages_id)?
            .set("Count", old_count + added);
    }
    let mut bytes = Vec::new();
    pdf.save_to(&mut bytes)?;
    Ok(bytes)
}
