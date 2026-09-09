use crate::database::LocalStore;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MAX_NUMBER: i64 = 999_999_999;
pub(crate) mod transport;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct ReservationRequest {
    request_id: String,
    prefix: String,
    year: i64,
    minimum: i64,
    count: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ReservationResponse {
    request_id: String,
    organization_id: String,
    installation_id: String,
    prefix: String,
    year: i64,
    start_value: i64,
    end_value: i64,
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.into())
}

fn bound_to(connection: &Connection, organization: &str) -> AppResult<()> {
    let binding: Option<String> = connection
        .query_row(
            "SELECT organization_id FROM shared_numbering_binding WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if binding.as_deref() != Some(organization) {
        return Err(invalid("La numérotation de ces données n’est pas liée à cette entreprise. Terminez son initialisation avant de réserver des numéros."));
    }
    Ok(())
}

// Persist the request before any HTTP call. A retry must use exactly the same
// request, even if the caller's floor has since advanced after local issuance.
pub(crate) fn prepare(
    store: &LocalStore,
    organization: &str,
    prefix: &str,
    year: i64,
    minimum: i64,
) -> AppResult<Option<ReservationRequest>> {
    if prefix.is_empty()
        || prefix.len() > 12
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        || !(1900..=9999).contains(&year)
        || !(1..=MAX_NUMBER).contains(&minimum)
    {
        return Err(invalid("Plage de numérotation invalide."));
    }
    let _lock = store.lock()?;
    let mut connection = store.connect()?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    bound_to(&tx, organization)?;
    let pending = tx.query_row(
        "SELECT request_id,prefix,year,minimum,count FROM device_number_ranges
         WHERE organization_id=? AND installation_id=? AND prefix=? AND year=? AND start_value IS NULL
         ORDER BY rowid LIMIT 1",
        params![organization,store.installation_id,prefix,year],
        |row| Ok(ReservationRequest { request_id:row.get(0)?,prefix:row.get(1)?,year:row.get(2)?,minimum:row.get(3)?,count:row.get(4)? }),
    ).optional()?;
    if pending.is_some() {
        return Ok(pending);
    }
    let available: i64 = tx.query_row(
        "SELECT COALESCE(SUM(MAX(0,end_value-MAX(next_value,?)+1)),0) FROM device_number_ranges
         WHERE organization_id=? AND installation_id=? AND prefix=? AND year=? AND start_value IS NOT NULL",
        params![minimum,organization,store.installation_id,prefix,year], |row| row.get(0),
    )?;
    if available >= 40 {
        return Ok(None);
    }
    let request = ReservationRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        prefix: prefix.into(),
        year,
        minimum,
        count: 200.min(MAX_NUMBER - minimum + 1),
    };
    tx.execute(
        "INSERT INTO device_number_ranges(request_id,organization_id,installation_id,prefix,year,minimum,count) VALUES(?,?,?,?,?,?,?)",
        params![request.request_id,organization,store.installation_id,prefix,year,minimum,request.count],
    )?;
    tx.commit()?;
    Ok(Some(request))
}

#[cfg(test)]
pub(crate) fn adopt(
    store: &LocalStore,
    organization: &str,
    request: &ReservationRequest,
    response: &ReservationResponse,
) -> AppResult<()> {
    adopt_checked(store, organization, request, response, || Ok(()))
}

fn adopt_checked(
    store: &LocalStore,
    organization: &str,
    request: &ReservationRequest,
    response: &ReservationResponse,
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<()> {
    if response.request_id != request.request_id
        || response.organization_id != organization
        || response.installation_id != store.installation_id
        || response.prefix != request.prefix
        || response.year != request.year
        || response.start_value < request.minimum
        || response.end_value > MAX_NUMBER
        || response.start_value.checked_add(request.count - 1) != Some(response.end_value)
    {
        return Err(invalid(
            "La plage reçue ne correspond pas à la demande de cet appareil.",
        ));
    }
    let _lock = store.lock()?;
    ensure_current()?;
    let mut connection = store.connect()?;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    bound_to(&tx, organization)?;
    let saved: Option<(Option<i64>,Option<i64>)> = tx.query_row(
        "SELECT start_value,end_value FROM device_number_ranges WHERE request_id=? AND organization_id=?
         AND installation_id=? AND prefix=? AND year=? AND minimum=? AND count=?",
        params![request.request_id,organization,store.installation_id,request.prefix,request.year,request.minimum,request.count],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional()?;
    match saved {
        // Never reinsert a request removed by a restoration or company change.
        None => return Err(invalid("La demande locale n’est plus présente. Relancez la synchronisation pour réserver de nouveaux numéros.")),
        Some((Some(start),Some(end))) if start==response.start_value && end==response.end_value => return Ok(()),
        Some((None,None)) => {},
        _ => return Err(invalid("Une réponse contradictoire a été reçue pour cette réservation.")),
    }
    let overlaps: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM device_number_ranges WHERE organization_id=? AND installation_id=?
         AND prefix=? AND year=? AND start_value<=? AND end_value>=?)",
        params![organization,store.installation_id,request.prefix,request.year,response.end_value,response.start_value],
        |row| row.get(0),
    )?;
    if overlaps {
        return Err(invalid(
            "La plage reçue recoupe des numéros déjà réservés sur cet appareil.",
        ));
    }
    tx.execute(
        "UPDATE device_number_ranges SET start_value=?,end_value=?,next_value=? WHERE request_id=?",
        params![
            response.start_value,
            response.end_value,
            response.start_value,
            request.request_id
        ],
    )?;
    ensure_current()?;
    tx.commit()?;
    Ok(())
}

type NumberSeries = BTreeMap<(i64, String), i64>;

fn active_series(
    store: &LocalStore,
    current_year: i64,
) -> AppResult<Option<(String, NumberSeries)>> {
    let connection = store.connect()?;
    let organization: Option<String> = connection
        .query_row(
            "SELECT organization_id FROM shared_numbering_binding WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(organization) = organization else {
        return Ok(None);
    };
    let mut series = NumberSeries::new();
    let mut journal_years = BTreeSet::new();
    // These identifiers are fixed application schema identifiers, never input.
    for (kind, table, date, prefix, start) in [
        (
            "quote",
            "quotes",
            "issue_date",
            "quote_prefix",
            "quote_start_number",
        ),
        (
            "invoice",
            "invoices",
            "issue_date",
            "invoice_prefix",
            "invoice_start_number",
        ),
        (
            "credit_note",
            "invoices",
            "issue_date",
            "credit_note_prefix",
            "credit_note_start_number",
        ),
        (
            "sales_order",
            "sales_orders",
            "order_date",
            "sales_order_prefix",
            "sales_order_start_number",
        ),
        (
            "delivery_note",
            "delivery_notes",
            "delivery_date",
            "delivery_note_prefix",
            "delivery_note_start_number",
        ),
        (
            "supplier_order",
            "supplier_orders",
            "order_date",
            "supplier_order_prefix",
            "supplier_order_start_number",
        ),
        (
            "supplier_receipt",
            "supplier_receipts",
            "receipt_date",
            "supplier_receipt_prefix",
            "supplier_receipt_start_number",
        ),
        (
            "supplier_credit_note",
            "supplier_credit_notes",
            "document_date",
            "supplier_credit_prefix",
            "supplier_credit_start_number",
        ),
    ] {
        let (prefix, start): (String, i64) = connection.query_row(
            &format!("SELECT {prefix},{start} FROM settings WHERE id=1"),
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut years: BTreeSet<i64> = [current_year - 1, current_year, current_year + 1]
            .into_iter()
            .collect();
        let mut statement = connection.prepare(&format!("SELECT DISTINCT CAST(substr({date},1,4) AS INTEGER) FROM {table} WHERE number IS NULL AND {date} IS NOT NULL"))?;
        years.extend(
            statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        );
        for year in years
            .into_iter()
            .filter(|year| (1900..=9999).contains(year))
        {
            let floor: i64 = connection
                .query_row(
                    "SELECT next_value FROM number_sequences WHERE document_type=? AND year=?",
                    params![kind, year],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(start);
            series
                .entry((year, prefix.clone()))
                .and_modify(|value| *value = (*value).max(floor))
                .or_insert(floor);
            journal_years.insert(year);
        }
    }
    for year in journal_years {
        let floor: i64 = connection
            .query_row(
                "SELECT next_value FROM accounting_sequences WHERE year=?",
                params![year],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(1);
        series
            .entry((year, "J".into()))
            .and_modify(|value| *value = (*value).max(floor))
            .or_insert(floor);
    }
    Ok(Some((organization, series)))
}

// No binding is created automatically. Company bootstrap must first publish
// its historical numbering floors before enabling this mode on any device.
pub(crate) fn consume(
    tx: &Transaction<'_>,
    prefix: &str,
    year: i64,
    minimum: i64,
) -> AppResult<Option<i64>> {
    let organization: Option<String> = tx
        .query_row(
            "SELECT organization_id FROM shared_numbering_binding WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(organization) = organization else {
        return Ok(None);
    };
    let installation: String =
        tx.query_row("SELECT zentra_installation_id()", [], |row| row.get(0))?;
    let range: Option<(String, i64, i64)> = tx
        .query_row(
            "SELECT request_id,next_value,MAX(next_value,?) FROM device_number_ranges
         WHERE organization_id=? AND installation_id=? AND prefix=? AND year=?
           AND start_value IS NOT NULL AND end_value>=MAX(next_value,?)
         ORDER BY start_value,request_id LIMIT 1",
            params![minimum, organization, installation, prefix, year, minimum],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((request, previous, next)) = range else {
        return Err(AppError::NumberRangeRequired {
            organization,
            prefix: prefix.into(),
            year,
            minimum,
        });
    };
    let updated = tx.execute(
        "UPDATE device_number_ranges SET next_value=? WHERE request_id=? AND next_value=?",
        params![next + 1, request, previous],
    )?;
    if updated != 1 {
        return Err(AppError::Validation(
            "La réservation du numéro a changé. Relancez l’opération.".into(),
        ));
    }
    Ok(Some(next))
}

// A backup may preserve the shared-company binding, never a device's unused
// numbers or its in-flight request. Replaying an old backup must acquire a new
// server reservation even when it is restored to the original installation.
pub(crate) fn strip_device_ranges(connection: &Connection) -> AppResult<()> {
    let present: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_number_ranges')", [], |row| row.get(0))?;
    if present {
        connection.execute("DELETE FROM device_number_ranges", [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_startup_migrates_schema_58_without_changing_existing_documents() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("profile");
        let store = LocalStore::initialize(path.clone()).unwrap();
        let connection = store.connect().unwrap();
        connection.execute_batch(
            "DROP TABLE device_number_ranges;
             DROP TABLE shared_numbering_binding;
             PRAGMA user_version=58;
             INSERT INTO clients(id,name,created_at,updated_at)
               VALUES('upgrade-client','Client fictif','2026-09-07','2026-09-07');
             INSERT INTO projects(id,client_id,name,created_at,updated_at)
               VALUES('upgrade-project','upgrade-client','Projet fictif','2026-09-07','2026-09-07');
             INSERT INTO quotes(id,client_id,project_id,number,title,issue_date,total_cents,created_at,updated_at)
               VALUES('upgrade-quote','upgrade-client','upgrade-project','D-2026-000041','Devis fictif','2026-09-07',108100,'2026-09-07','2026-09-07');
             INSERT INTO invoices(id,client_id,project_id,quote_id,number,title,status,issue_date,total_cents,paid_cents,notes,created_at,updated_at)
               VALUES('upgrade-invoice','upgrade-client','upgrade-project','upgrade-quote','F-2026-000012','Facture fictive','partiellement_payee','2026-09-07',108100,30000,'Ligne 1
Ligne 2','2026-09-07','2026-09-07');
             INSERT INTO payments(id,invoice_id,date,amount_cents,created_at,updated_at)
               VALUES('upgrade-payment','upgrade-invoice','2026-09-07',30000,'2026-09-07','2026-09-07');
             INSERT INTO number_sequences VALUES('quote',2026,42),('invoice',2026,13);
             INSERT INTO accounting_sequences VALUES(2026,3);"
        ).unwrap();
        let document = store.attachments_dir.join("upgrade-document.txt");
        std::fs::write(&document, b"Document fictif conserve").unwrap();
        drop(connection);
        drop(store);

        // Use the actual startup entry point, not just the migration SQL. The
        // dispatch match once rejected schema 58 before reaching its SQL step.
        for _ in 0..2 {
            let reopened = LocalStore::initialize(path.clone()).unwrap();
            let connection = reopened.connect().unwrap();
            assert_eq!(
                connection
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                crate::schema::SCHEMA_VERSION
            );
            assert_eq!(
                connection
                    .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            let foreign_key_errors: i64 = connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(foreign_key_errors, 0);
            let values: (String, String, i64, i64, String) = connection.query_row(
                "SELECT quote_id,number,total_cents,paid_cents,notes FROM invoices WHERE id='upgrade-invoice'", [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
            ).unwrap();
            assert_eq!(
                values,
                (
                    "upgrade-quote".into(),
                    "F-2026-000012".into(),
                    108100,
                    30000,
                    "Ligne 1\nLigne 2".into()
                )
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT SUM(amount_cents) FROM payments WHERE invoice_id='upgrade-invoice'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                30000
            );
            assert_eq!(connection.query_row("SELECT next_value FROM number_sequences WHERE document_type='invoice' AND year=2026", [], |row| row.get::<_, i64>(0)).unwrap(), 13);
            assert_eq!(
                connection
                    .query_row(
                        "SELECT next_value FROM accounting_sequences WHERE year=2026",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                3
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM shared_numbering_binding", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap(),
                0
            );
            assert_eq!(
                connection
                    .query_row("SELECT COUNT(*) FROM device_number_ranges", [], |row| row
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                0
            );
            assert_eq!(
                std::fs::read(&document).unwrap(),
                b"Document fictif conserve"
            );
        }
    }

    #[test]
    fn background_planner_does_nothing_until_company_bootstrap() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        assert!(active_series(&store, 2026).unwrap().is_none());
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM device_number_ranges", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }

    #[test]
    fn background_planner_covers_year_boundary_drafts_and_shared_prefix_floors() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        bind(&store);
        let connection = store.connect().unwrap();
        connection.execute("INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Recette','2026-09-08','2026-09-08')",[]).unwrap();
        connection
            .execute(
                "UPDATE settings SET quote_prefix='COMMUN',invoice_prefix='COMMUN'",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO quotes(id,title,issue_date,created_at,updated_at) VALUES('draft','Devis futur','2030-01-05','2026-09-08','2026-09-08')",[]).unwrap();
        connection
            .execute(
                "INSERT INTO number_sequences VALUES('quote',2026,200),('invoice',2026,700)",
                [],
            )
            .unwrap();
        connection
            .execute("INSERT INTO accounting_sequences VALUES(2030,820)", [])
            .unwrap();
        let (organization, series) = active_series(&store, 2026).unwrap().unwrap();
        assert_eq!(organization, "org");
        assert_eq!(series[&(2026, "COMMUN".into())], 700);
        for year in [2025, 2026, 2027, 2030] {
            assert!(series.contains_key(&(year, "COMMUN".into())));
        }
        assert_eq!(series[&(2030, "J".into())], 820);
        assert!(!series.keys().any(|(year, _)| *year == 2024));
        // Planning is read-only; only an authenticated transport prepares ranges.
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM device_number_ranges", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }

    fn bind(store: &LocalStore) {
        store
            .connect()
            .unwrap()
            .execute(
                "INSERT OR IGNORE INTO shared_numbering_binding VALUES(1,'org','2026-09-08')",
                [],
            )
            .unwrap();
    }

    fn reply(store: &LocalStore, request: &ReservationRequest, start: i64) -> ReservationResponse {
        ReservationResponse {
            request_id: request.request_id.clone(),
            organization_id: "org".into(),
            installation_id: store.installation_id.clone(),
            prefix: request.prefix.clone(),
            year: request.year,
            start_value: start,
            end_value: start + request.count - 1,
        }
    }

    #[test]
    fn lost_response_is_replayed_after_restart_and_duplicate_response_never_rewinds_consumption() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("profile");
        let source = LocalStore::initialize(path.clone()).unwrap();
        bind(&source);
        let first = prepare(&source, "org", "F", 2026, 100).unwrap().unwrap();
        let response = reply(&source, &first, 301);
        // The server reserved numbers, but the network lost its response.
        drop(source);
        let reopened = LocalStore::initialize(path).unwrap();
        let retry = prepare(&reopened, "org", "F", 2026, 250).unwrap().unwrap();
        assert_eq!(retry, first);
        adopt(&reopened, "org", &retry, &response).unwrap();
        let mut connection = reopened.connect().unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 250).unwrap(), Some(301));
        tx.commit().unwrap();
        adopt(&reopened, "org", &first, &response).unwrap();
        assert_eq!(
            consume(&connection.transaction().unwrap(), "F", 2026, 250).unwrap(),
            Some(302)
        );
        assert!(prepare(&reopened, "org", "F", 2026, 250).unwrap().is_none());
    }

    #[test]
    fn restoration_during_http_does_not_resurrect_the_old_request() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        bind(&store);
        let request = prepare(&store, "org", "F", 2026, 1).unwrap().unwrap();
        let response = reply(&store, &request, 1);
        let archive = store
            .create_backup(None, env!("CARGO_PKG_VERSION"))
            .unwrap();
        store
            .restore_backup(&archive, env!("CARGO_PKG_VERSION"))
            .unwrap();
        assert!(adopt(&store, "org", &request, &response).is_err());
        let next = prepare(&store, "org", "F", 2026, 1).unwrap().unwrap();
        assert_ne!(next.request_id, request.request_id);
    }

    #[test]
    fn company_change_and_malformed_or_contradictory_responses_never_adopt_numbers() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        bind(&store);
        let request = prepare(&store, "org", "F", 2026, 100).unwrap().unwrap();
        let response = reply(&store, &request, 101);
        let mut bad = response.clone();
        bad.organization_id = "other".into();
        assert!(adopt(&store, "org", &request, &bad).is_err());
        let mut bad = response.clone();
        bad.installation_id = "other".into();
        assert!(adopt(&store, "org", &request, &bad).is_err());
        let mut bad = response.clone();
        bad.end_value += 1;
        assert!(adopt(&store, "org", &request, &bad).is_err());
        assert!(adopt(&store, "org", &request, &reply(&store, &request, 99)).is_err());
        let mut bad = response.clone();
        bad.start_value = i64::MAX;
        bad.end_value = i64::MAX;
        assert!(adopt(&store, "org", &request, &bad).is_err());
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE shared_numbering_binding SET organization_id='other'",
                [],
            )
            .unwrap();
        assert!(adopt(&store, "org", &request, &response).is_err());
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE shared_numbering_binding SET organization_id='org'",
                [],
            )
            .unwrap();
        adopt(&store, "org", &request, &response).unwrap();
        assert!(adopt(&store, "org", &request, &reply(&store, &request, 501)).is_err());
    }

    #[test]
    fn low_water_mark_prepares_one_range_and_rejects_overlap_even_with_consumed_numbers() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        reserve(&store, 1, 100);
        assert!(prepare(&store, "org", "F", 2026, 61).unwrap().is_none());
        let request = prepare(&store, "org", "F", 2026, 62).unwrap().unwrap();
        assert_eq!(
            prepare(&store, "org", "F", 2026, 65).unwrap().unwrap(),
            request
        );
        // Issuance after preparation can consume all of the first range.
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE device_number_ranges SET next_value=101 WHERE start_value=1",
                [],
            )
            .unwrap();
        assert!(adopt(&store, "org", &request, &reply(&store, &request, 100)).is_err());
        adopt(&store, "org", &request, &reply(&store, &request, 101)).unwrap();
        assert!(prepare(&store, "org", "F", 2026, 62).unwrap().is_none());
    }

    #[test]
    fn concurrent_preparation_on_two_connections_has_only_one_durable_request() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("profile");
        let first = LocalStore::initialize(path.clone()).unwrap();
        bind(&first);
        let second = LocalStore::initialize(path).unwrap();
        let a = std::thread::spawn(move || prepare(&first, "org", "F", 2026, 1).unwrap().unwrap());
        let b = std::thread::spawn(move || prepare(&second, "org", "F", 2026, 1).unwrap().unwrap());
        assert_eq!(a.join().unwrap(), b.join().unwrap());
    }

    #[test]
    fn invalid_requests_and_uninitialized_company_never_reserve_and_limit_is_exact() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        assert!(prepare(&store, "org", "F", 2026, 1).is_err());
        bind(&store);
        for (prefix, year, minimum) in [
            ("", 2026, 1),
            ("f", 2026, 1),
            ("F/", 2026, 1),
            ("F", 1899, 1),
            ("F", 2026, 0),
            ("F", 2026, MAX_NUMBER + 1),
        ] {
            assert!(prepare(&store, "org", prefix, year, minimum).is_err());
        }
        let request = prepare(&store, "org", "F", 2026, MAX_NUMBER)
            .unwrap()
            .unwrap();
        assert_eq!(request.count, 1);
        adopt(
            &store,
            "org",
            &request,
            &reply(&store, &request, MAX_NUMBER),
        )
        .unwrap();
        let mut connection = store.connect().unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(
            consume(&tx, "F", 2026, MAX_NUMBER).unwrap(),
            Some(MAX_NUMBER)
        );
        tx.commit().unwrap();
        assert!(consume(&connection.transaction().unwrap(), "F", 2026, MAX_NUMBER).is_err());
    }

    fn reserve(store: &LocalStore, start: i64, count: i64) {
        let connection = store.connect().unwrap();
        connection
            .execute(
                "INSERT OR IGNORE INTO shared_numbering_binding VALUES(1,'org','2026-09-08')",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO device_number_ranges(request_id,organization_id,installation_id,prefix,year,minimum,count,start_value,end_value,next_value) VALUES(?,'org',?,'F',2026,1,?,?,?,?)", params![uuid::Uuid::new_v4().to_string(),store.installation_id,count,start,start+count-1,start]).unwrap();
    }

    #[test]
    fn only_committed_documents_consume_device_numbers_and_exhaustion_never_falls_back() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        reserve(&store, 101, 2);
        let mut connection = store.connect().unwrap();
        {
            let tx = connection.transaction().unwrap();
            assert_eq!(consume(&tx, "F", 2026, 1).unwrap(), Some(101));
            // Roll back the document and its consumption together.
        }
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 1).unwrap(), Some(101));
        tx.commit().unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 1).unwrap(), Some(102));
        tx.commit().unwrap();
        let tx = connection.transaction().unwrap();
        assert!(consume(&tx, "F", 2026, 1)
            .unwrap_err()
            .to_string()
            .contains("épuisés"));
        assert!(consume(&tx, "D", 2026, 1).is_err());
        assert!(consume(&tx, "F", 2027, 1).is_err());
    }

    #[test]
    fn restoration_cannot_reuse_a_reserved_range_on_the_same_or_another_computer() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        reserve(&source, 201, 100);
        let archive = source
            .create_backup(None, env!("CARGO_PKG_VERSION"))
            .unwrap();
        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        for store in [&source, &destination] {
            store
                .restore_backup(&archive, env!("CARGO_PKG_VERSION"))
                .unwrap();
            let mut connection = store.connect().unwrap();
            let tx = connection.transaction().unwrap();
            assert_eq!(
                tx.query_row("SELECT COUNT(*) FROM device_number_ranges", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
                0
            );
            assert!(consume(&tx, "F", 2026, 1).is_err());
        }
    }

    #[test]
    fn ranges_are_bound_to_the_company_device_prefix_and_floor() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
        reserve(&store, 101, 100);
        let mut connection = store.connect().unwrap();
        connection
            .execute(
                "UPDATE device_number_ranges SET installation_id='another-device'",
                [],
            )
            .unwrap();
        assert!(consume(&connection.transaction().unwrap(), "F", 2026, 1).is_err());
        connection.execute("UPDATE device_number_ranges SET installation_id=?,organization_id='another-company'", params![store.installation_id]).unwrap();
        assert!(consume(&connection.transaction().unwrap(), "F", 2026, 1).is_err());
        connection
            .execute("UPDATE device_number_ranges SET organization_id='org'", [])
            .unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 180).unwrap(), Some(180));
        tx.commit().unwrap();
        assert_eq!(
            consume(&connection.transaction().unwrap(), "F", 2026, 1).unwrap(),
            Some(181)
        );
    }

    #[test]
    fn an_unshared_company_keeps_its_existing_numbering_behavior() {
        let temporary = tempfile::tempdir().unwrap();
        let store = LocalStore::initialize(temporary.path().into()).unwrap();
        let mut connection = store.connect().unwrap();
        assert_eq!(
            consume(&connection.transaction().unwrap(), "F", 2026, 1).unwrap(),
            None
        );
    }
}
