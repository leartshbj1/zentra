//! Initial shared history retains high-water marks even when a numbered draft
//! was deleted. These are bootstrap evidence, never replicated local counters.
use super::*;

pub(super) const MAX_FLOORS: usize = 10_000;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct NumberFloor {
    pub prefix: String,
    pub year: i64,
    pub minimum: i64,
}
pub(super) fn validate(floors: &[NumberFloor]) -> AppResult<()> {
    if floors.len() > MAX_FLOORS {
        return Err(invalid(
            "L'historique dépasse 10 000 séries de numérotation.",
        ));
    }
    let mut previous: Option<(&str, i64)> = None;
    for floor in floors {
        let key = (floor.prefix.as_str(), floor.year);
        if floor.prefix.is_empty()
            || floor.prefix.len() > 12
            || !floor
                .prefix
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
            || !(1900..=9999).contains(&floor.year)
            || !(1..=1_000_000_000).contains(&floor.minimum)
            || previous.is_some_and(|last| last >= key)
        {
            return Err(invalid(
                "Une borne historique de numérotation est invalide.",
            ));
        }
        previous = Some(key);
    }
    Ok(())
}
pub(super) fn freeze(connection: &Connection) -> AppResult<Vec<NumberFloor>> {
    let mut floors = BTreeMap::<(String, i64), i64>::new();
    for (kind, field) in [
        ("quote", "quote_prefix"),
        ("invoice", "invoice_prefix"),
        ("credit_note", "credit_note_prefix"),
        ("sales_order", "sales_order_prefix"),
        ("delivery_note", "delivery_note_prefix"),
        ("supplier_order", "supplier_order_prefix"),
        ("supplier_receipt", "supplier_receipt_prefix"),
        ("supplier_credit_note", "supplier_credit_prefix"),
    ] {
        let mut statement = connection.prepare(&format!("SELECT s.{field},n.year,n.next_value FROM number_sequences n CROSS JOIN settings s WHERE s.id=1 AND n.document_type=?"))?;
        for row in statement.query_map([kind], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })? {
            let (prefix, year, next) = row?;
            floors
                .entry((prefix, year))
                .and_modify(|n| *n = (*n).max(next))
                .or_insert(next);
        }
    }
    let mut statement = connection.prepare("SELECT year,next_value FROM accounting_sequences")?;
    for row in statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))? {
        let (year, next) = row?;
        floors
            .entry(("J".into(), year))
            .and_modify(|n| *n = (*n).max(next))
            .or_insert(next);
    }
    let result = floors
        .into_iter()
        .map(|((prefix, year), minimum)| NumberFloor {
            prefix,
            year,
            minimum,
        })
        .collect::<Vec<_>>();
    validate(&result)?;
    Ok(result)
}

#[test]
fn deleted_drafts_shared_prefixes_and_exhausted_series_keep_their_high_water_marks() {
    let (_directory, store) = super::tests::setup();
    let connection = store.connect().unwrap();
    connection.execute_batch("UPDATE settings SET quote_prefix='F'; INSERT INTO number_sequences VALUES('quote',2026,81),('invoice',2026,13),('credit_note',2025,1000000000); INSERT INTO accounting_sequences VALUES(2024,93);").unwrap();
    let frozen = freeze(&connection).unwrap();
    assert_eq!(
        frozen,
        vec![
            NumberFloor {
                prefix: "A".into(),
                year: 2025,
                minimum: 1_000_000_000
            },
            NumberFloor {
                prefix: "F".into(),
                year: 2026,
                minimum: 81
            },
            NumberFloor {
                prefix: "J".into(),
                year: 2024,
                minimum: 93
            }
        ]
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM quotes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    connection
        .execute(
            "UPDATE number_sequences SET next_value=999 WHERE document_type='quote'",
            [],
        )
        .unwrap();
    assert_eq!(frozen[1].minimum, 81);
}
