use crate::error::{AppError, AppResult};
use crate::{account_cloud::project_sync_session, database::LocalStore};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

const MAX_NUMBER: i64 = 999_999_999;

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

pub(crate) fn adopt(
    store: &LocalStore,
    organization: &str,
    request: &ReservationRequest,
    response: &ReservationResponse,
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
    tx.commit()?;
    Ok(())
}

// Called by the future business-sync scheduler only after company bootstrap.
// This does not activate shared numbering merely because a cloud account exists.
pub(crate) async fn replenish(
    store: &LocalStore,
    prefix: &str,
    year: i64,
    minimum: i64,
) -> AppResult<()> {
    let organization: Option<String> = store
        .connect()?
        .query_row(
            "SELECT organization_id FROM shared_numbering_binding WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(organization) = organization else {
        return Ok(());
    };
    let session = project_sync_session(store)
        .await?
        .ok_or_else(|| invalid("Reconnectez cet appareil pour recharger ses numéros réservés."))?;
    if session.organization_id != organization || session.role == "read_only" {
        return Err(invalid(
            "Le compte connecté ne peut pas réserver des numéros pour cette entreprise.",
        ));
    }
    let Some(request) = prepare(store, &organization, prefix, year, minimum)? else {
        return Ok(());
    };
    let (status, bytes) = session
        .request(
            reqwest::Method::POST,
            "/api/sync/numbers",
            &[],
            &[("Content-Type", "application/json".into())],
            Some(serde_json::to_vec(&request)?),
            false,
        )
        .await?;
    if !status.is_success() {
        return Err(invalid("La réservation n’a pas été confirmée. La demande sera reprise lors de la prochaine connexion."));
    }
    let response: ReservationResponse = serde_json::from_slice(&bytes)?;
    adopt(store, &organization, &request, &response)
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
        return Err(AppError::Validation(format!("Les numéros réservés pour {prefix}-{year} sont épuisés sur cet appareil. Reconnectez Zentra pour en obtenir de nouveaux. Le brouillon reste disponible.")));
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
