use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

#[derive(Clone)]
struct Server {
    installation: String,
    calls: Arc<Mutex<Vec<ReservationRequest>>>,
    failures: BTreeSet<(i64, String)>,
    current: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
    role: &'static str,
    effect: Option<(&'static str, LocalStore)>,
}
impl Server {
    fn new(store: &LocalStore) -> Self {
        Self {
            installation: store.installation_id.clone(),
            calls: Default::default(),
            failures: Default::default(),
            current: Arc::new(AtomicBool::new(true)),
            lost: Default::default(),
            role: "owner",
            effect: None,
        }
    }
}
impl Transport for Server {
    fn organization(&self) -> &str {
        "org"
    }
    fn role(&self) -> &str {
        self.role
    }
    fn current(&self, _: &LocalStore) -> AppResult<()> {
        if self.current.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(invalid("Compte changé"))
        }
    }
    async fn reserve(&self, request: &ReservationRequest) -> AppResult<Vec<u8>> {
        self.calls.lock().unwrap().push(request.clone());
        if let Some((effect, store)) = &self.effect {
            match *effect {
                "account" => self.current.store(false, Ordering::Release),
                "restore" => strip_device_ranges(&store.connect()?)?,
                "permission" => {
                    store
                        .connect()?
                        .execute("UPDATE settings SET company_name='revoked'", [])?;
                }
                _ => panic!("Unknown test effect"),
            }
        }
        if self.lost.swap(false, Ordering::AcqRel)
            || self
                .failures
                .contains(&(request.year, request.prefix.clone()))
        {
            return Err(invalid("Réponse perdue"));
        }
        Ok(serde_json::to_vec(
            &json!({"request_id":request.request_id,"organization_id":"org",
            "installation_id":self.installation,"prefix":request.prefix,"year":request.year,
            "start_value":request.minimum,"end_value":request.minimum+request.count-1,
            "created_at":"2026-09-09T00:00:00Z"}),
        )?)
    }
}
fn fixture() -> (tempfile::TempDir, LocalStore) {
    let root = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(root.path().join("profile")).unwrap();
    store.connect().unwrap().execute_batch(
        "INSERT INTO settings(id,onboarding_completed,company_name,currency,created_at,updated_at) VALUES(1,1,'Numbering test','CHF','2026-01-01','2026-01-01');
         INSERT INTO shared_numbering_binding VALUES(1,'org','2026-01-01');"
    ).unwrap();
    (root, store)
}
fn count(store: &LocalStore, sql: &str) -> i64 {
    store
        .connect()
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

#[test]
fn failures_do_not_starve_other_series_across_restart_and_each_pass_is_bounded() {
    tauri::async_runtime::block_on(async {
        let (_root, store) = fixture();
        let mut server = Server::new(&store);
        let (_, series) = active_series(&store, 2026).unwrap().unwrap();
        let ordered = order(&store, "org", series, 2026).unwrap();
        server.failures = ordered.iter().take(9).map(|(key, _)| key.clone()).collect();
        let first = pass(&store, &server, 2026, 8).await.unwrap();
        assert_eq!(first["attempts"], 8);
        assert_eq!(first["confirmed"], 0);
        assert_eq!(first["state"], "attention");
        let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let second = pass(&reopened, &server, 2026, 8).await.unwrap();
        assert_eq!(second["confirmed"], 7);
        assert_eq!(server.calls.lock().unwrap().len(), 16);
        for _ in 0..4 {
            pass(&reopened, &server, 2026, 8).await.unwrap();
        }
        assert_eq!(
            count(
                &reopened,
                "SELECT COUNT(*) FROM device_number_ranges WHERE start_value IS NOT NULL"
            ),
            (ordered.len() - 9) as i64
        );
    });
}

#[test]
fn lost_reply_reuses_durable_request_without_rewinding_consumed_numbers() {
    tauri::async_runtime::block_on(async {
        let (_root, store) = fixture();
        let server = Server::new(&store);
        server.lost.store(true, Ordering::Release);
        let request = prepare(&store, "org", "F", 2026, 10).unwrap().unwrap();
        assert!(receive(&store, &server, &request).await.is_err());
        let reopened = LocalStore::initialize(store.data_dir.clone()).unwrap();
        let retry = prepare(&reopened, "org", "F", 2026, 11).unwrap().unwrap();
        assert_eq!(retry, request);
        receive(&reopened, &server, &retry).await.unwrap();
        let mut connection = reopened.connect().unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(consume(&tx, "F", 2026, 10).unwrap(), Some(10));
        tx.commit().unwrap();
        receive(&reopened, &server, &retry).await.unwrap();
        assert_eq!(
            count(&reopened, "SELECT next_value FROM device_number_ranges"),
            11
        );
    });
}

#[test]
fn late_account_or_restoration_reply_is_not_adopted() {
    tauri::async_runtime::block_on(async {
        for effect in ["account", "restore"] {
            let (_root, store) = fixture();
            let mut server = Server::new(&store);
            server.effect = Some((effect, store.clone()));
            let request = prepare(&store, "org", "F", 2026, 1).unwrap().unwrap();
            assert!(receive(&store, &server, &request).await.is_err());
            assert_eq!(
                count(
                    &store,
                    "SELECT COUNT(*) FROM device_number_ranges WHERE start_value IS NOT NULL"
                ),
                0
            );
        }
    });
}

#[test]
fn local_and_read_only_profiles_make_no_reservation_requests() {
    tauri::async_runtime::block_on(async {
        let (_root, store) = fixture();
        let mut server = Server::new(&store);
        server.role = "read_only";
        assert_eq!(
            pass(&store, &server, 2026, 8).await.unwrap()["state"],
            "read_only"
        );
        store
            .connect()
            .unwrap()
            .execute("DELETE FROM shared_numbering_binding", [])
            .unwrap();
        assert_eq!(
            pass(&store, &server, 2026, 8).await.unwrap()["state"],
            "local"
        );
        assert!(server.calls.lock().unwrap().is_empty());
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM device_number_ranges"),
            0
        );
    });
}

fn journal(store: &LocalStore) -> ManualJournalInput {
    store.install_swiss_accounting_starter().unwrap();
    let c = store.connect().unwrap();
    let debit: String = c
        .query_row("SELECT id FROM accounts WHERE code='1020'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let credit: String = c
        .query_row("SELECT id FROM accounts WHERE code='3200'", [], |r| {
            r.get(0)
        })
        .unwrap();
    serde_json::from_value(json!({"entry_date":"2020-03-05","description":"Ancien exercice","currency":"CHF",
        "lines":[{"account_id":debit,"debit_cents":10000},{"account_id":credit,"credit_cents":10000}]})).unwrap()
}
// Test authorization boundary only; production always passes require_write_access.
fn authorize(store: &LocalStore) -> AppResult<()> {
    let name: String =
        store
            .connect()?
            .query_row("SELECT company_name FROM settings", [], |r| r.get(0))?;
    if name == "revoked" {
        Err(invalid("Lecture seule"))
    } else {
        Ok(())
    }
}
async fn post(
    store: &LocalStore,
    input: ManualJournalInput,
    id: &str,
    server: &Server,
) -> AppResult<Value> {
    let server = server.clone();
    post_manual_with(store.clone(), input, id.into(), authorize, |_| async {
        Ok(server)
    })
    .await
}

#[test]
fn old_year_journal_fetches_only_missing_series_and_replays_offline_once() {
    tauri::async_runtime::block_on(async {
        let (_root, store) = fixture();
        let input = journal(&store);
        let server = Server::new(&store);
        let id = uuid::Uuid::new_v4().to_string();
        store
            .connect()
            .unwrap()
            .execute("INSERT INTO accounting_sequences VALUES(2020,820)", [])
            .unwrap();
        let entry = post(&store, input.clone(), &id, &server).await.unwrap();
        assert_eq!(entry["entry"]["number"], "J-2020-000820");
        let calls = server.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            (calls[0].prefix.as_str(), calls[0].year, calls[0].minimum),
            ("J", 2020, 820)
        );
        server.current.store(false, Ordering::Release);
        let cached = post(
            &store,
            input.clone(),
            &uuid::Uuid::new_v4().to_string(),
            &server,
        )
        .await
        .unwrap();
        assert_eq!(cached["entry"]["number"], "J-2020-000821");
        strip_device_ranges(&store.connect().unwrap()).unwrap();
        let replay = post(&store, input, &id, &server).await.unwrap();
        assert_eq!(replay["id"], entry["id"]);
        assert_eq!(server.calls.lock().unwrap().len(), 1);
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM journal_entries WHERE source_type='manual'"
            ),
            2
        );
    });
}

#[test]
fn interrupted_reservation_preserves_journal_and_retry_commits_once() {
    tauri::async_runtime::block_on(async {
        let (_root, store) = fixture();
        let input = journal(&store);
        let server = Server::new(&store);
        let id = uuid::Uuid::new_v4().to_string();
        server.lost.store(true, Ordering::Release);
        assert!(post(&store, input.clone(), &id, &server).await.is_err());
        assert_eq!(count(&store, "SELECT COUNT(*) FROM journal_entries"), 0);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM accounting_sequences"),
            0
        );
        post(&store, input.clone(), &id, &server).await.unwrap();
        post(&store, input, &id, &server).await.unwrap();
        let calls = server.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], calls[1]);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM journal_entries"), 1);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM audit_log WHERE action='post' AND entity_type='journal_entry'"), 1);
        assert_eq!(
            count(
                &store,
                "SELECT SUM(debit_cents-credit_cents) FROM journal_lines"
            ),
            0
        );
    });
}

#[test]
fn closed_year_does_not_reserve_or_change_the_journal() {
    tauri::async_runtime::block_on(async {
        let (_root, store) = fixture();
        let input = journal(&store);
        store.connect().unwrap().execute_batch("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES('closed','Exercice clos','2020-01-01','2020-12-31','closed','2021-01-01','2021-01-01')").unwrap();
        let server = Server::new(&store);
        let error = post(&store, input, &uuid::Uuid::new_v4().to_string(), &server)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("clôtur"));
        assert!(server.calls.lock().unwrap().is_empty());
        assert_eq!(count(&store, "SELECT COUNT(*) FROM journal_entries"), 0);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM device_number_ranges"),
            0
        );
    });
}

#[test]
fn invalid_or_unlicensed_journal_never_fetches_and_revocation_after_fetch_never_posts() {
    tauri::async_runtime::block_on(async {
        let (_root, store) = fixture();
        let input = journal(&store);
        let mut server = Server::new(&store);
        let mut invalid_input = input.clone();
        invalid_input.lines[0].debit_cents += 1;
        assert!(post(
            &store,
            invalid_input,
            &uuid::Uuid::new_v4().to_string(),
            &server
        )
        .await
        .is_err());
        assert!(server.calls.lock().unwrap().is_empty());
        // The real command authorization refuses an unlicensed profile when this
        // build embeds its public key. Development builds may omit enforcement.
        if option_env!("HELVICHANTIER_LICENSE_PUBLIC_KEY_B64URL").is_some() {
            let no_license = post_manual_with(
                store.clone(),
                input.clone(),
                uuid::Uuid::new_v4().to_string(),
                LocalStore::require_write_access,
                |_| async { Ok(server.clone()) },
            )
            .await;
            assert!(no_license.is_err());
            assert!(server.calls.lock().unwrap().is_empty());
        }
        server.effect = Some(("permission", store.clone()));
        assert!(
            post(&store, input, &uuid::Uuid::new_v4().to_string(), &server)
                .await
                .is_err()
        );
        assert_eq!(server.calls.lock().unwrap().len(), 1);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM journal_entries"), 0);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM accounting_sequences"),
            0
        );
    });
}
