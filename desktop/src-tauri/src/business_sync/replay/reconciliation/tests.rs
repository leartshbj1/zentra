use super::*;
use crate::business_sync::outgoing;
use serde_json::json;
use std::fs;
use uuid::Uuid;

const LARGE: i64 = 9_007_199_254_740_993;
fn client(c: &Connection, id: &str, name: &str, rowid: i64) {
    c.execute("INSERT INTO clients(rowid,id,name,created_at,updated_at) VALUES(?1,?2,?3,'2026-09-09','2026-09-09')",params![rowid,id,name]).unwrap();
}
fn pending(store: &LocalStore) -> outgoing::Prepared {
    outgoing::prepare_next(store, "org-replay", "owner")
        .unwrap()
        .unwrap()
}
fn changes(p: &outgoing::Prepared) -> Vec<RowChange> {
    p.manifest
        .chunks
        .iter()
        .enumerate()
        .flat_map(|(i, _)| {
            let raw: Value =
                serde_json::from_slice(&fs::read(p.folder.join(format!("{i:04}.json"))).unwrap())
                    .unwrap();
            raw["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| RowChange {
                    table: c["table"].as_str().unwrap().into(),
                    key_json: c["key_json"].as_str().unwrap().into(),
                    before_json: c["before_json"].as_str().map(str::to_owned),
                    after_json: c["after_json"].as_str().map(str::to_owned),
                    canonical_rowid: c["source_rowid"].as_str().unwrap().parse().unwrap(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}
fn acknowledgement(p: &outgoing::Prepared) -> Acknowledgement {
    Acknowledgement {
        transaction_id: p.manifest.transaction_id.clone(),
        first_sequence: p.manifest.first_sequence.parse().unwrap(),
        last_sequence: p.manifest.last_sequence.parse().unwrap(),
        change_count: p.manifest.change_count,
    }
}
fn capture(store: &LocalStore) -> String {
    store
        .connect()
        .unwrap()
        .query_row("SELECT generation FROM business_sync_binding", [], |r| {
            r.get(0)
        })
        .unwrap()
}
fn journal(store: &LocalStore) -> Vec<(i64, String)> {
    let c = store.connect().unwrap();
    let result=c.prepare("SELECT sequence,json_array(generation,transaction_id,organization_id,installation_id,table_name,row_key_json,operation,before_json,after_json,source_rowid,base_revision) FROM business_sync_changes ORDER BY sequence").unwrap()
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    result
}
fn merged_store(prepared: &Prepared) -> &LocalStore {
    &prepared.native.as_ref().unwrap().store
}
fn copy_cache(prepared: &Prepared, store: &LocalStore, context: &Context) {
    let root = store
        .data_dir
        .join("business-canonical")
        .join(&context.generation);
    fs::create_dir_all(&root).unwrap();
    let mut cache = Connection::open(root.join(format!(
        "{}-{}.sqlite",
        context.base_revision + 1,
        context.target_state_sha256
    )))
    .unwrap();
    rusqlite::backup::Backup::new(&prepared.model.connection, &mut cache)
        .unwrap()
        .run_to_completion(256, std::time::Duration::from_millis(1), None)
        .unwrap();
}

#[test]
fn own_commit_rebases_later_updates_and_insert_delete_reinsert_without_touching_evidence() {
    let (_root, store, mut context) = super::super::tests::setup_with(|_| {});
    let (_canonical_root, canonical) = super::super::tests::copy_receiver(&store);
    client(&store.connect().unwrap(), "own", "First", 1);
    let p = pending(&store);
    let ack = acknowledgement(&p);
    let mut remote = changes(&p);
    for change in &mut remote {
        if change.table == "clients" {
            change.canonical_rowid = LARGE;
        }
    }
    client(&canonical.connect().unwrap(), "own", "First", LARGE);
    context.target_state_sha256 = state_fingerprint(&canonical.connect().unwrap()).unwrap();
    let mut c = store.connect().unwrap();
    let tx = c.transaction().unwrap();
    tx.execute(
        "UPDATE clients SET name='After the upload' WHERE id='own'",
        [],
    )
    .unwrap();
    client(&tx, "later", "Later", 2);
    tx.commit().unwrap();
    let tx = c.transaction().unwrap();
    tx.execute("DELETE FROM clients WHERE id='later'", [])
        .unwrap();
    client(&tx, "later", "Recreated", 2);
    tx.commit().unwrap();
    drop(c);
    let original = journal(&store);
    let before = state_fingerprint(&store.connect().unwrap()).unwrap();
    let prepared = prepare(
        &store,
        &context,
        &capture(&store),
        Some(&ack),
        remote.into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(prepared.model.conflict_count, 0);
    let result = merged_store(&prepared).connect().unwrap();
    let rows = result
        .prepare("SELECT id,name,rowid FROM clients ORDER BY id")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            ("later".into(), "Recreated".into(), LARGE + 1),
            ("own".into(), "After the upload".into(), LARGE)
        ]
    );
    assert_eq!(journal(merged_store(&prepared)), original);
    assert_eq!(journal(&store), original);
    assert_eq!(
        state_fingerprint(&store.connect().unwrap()).unwrap(),
        before
    );
    assert_eq!(
        result
            .query_row("SELECT COUNT(*) FROM business_sync_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(prepared.summary()["acknowledged"], false);
    assert_eq!(prepared.summary()["installed"], false);
}

#[test]
fn preceding_remote_commit_then_own_commit_preserves_old_aliases_and_new_local_edits() {
    let (_root, store, mut context) = super::super::tests::setup_with(|_| {});
    let (_remote_root, remote) = super::super::tests::copy_receiver(&store);
    client(&store.connect().unwrap(), "own", "Own", 1);
    let own = pending(&store);
    client(&remote.connect().unwrap(), "remote", "Remote", 1);
    let received = pending(&remote);
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let first = prepare(
        &store,
        &context,
        &capture(&store),
        None,
        changes(&received).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    let working = merged_store(&first);
    assert_eq!(
        working
            .connect()
            .unwrap()
            .query_row("SELECT rowid FROM clients WHERE id='own'", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    copy_cache(&first, working, &context);
    // New native transactions contain the new positions while old evidence
    // retains its original source_rowid and base_revision.
    working
        .connect()
        .unwrap()
        .execute(
            "UPDATE clients SET name='Edited after rebase' WHERE id='own'",
            [],
        )
        .unwrap();
    client(&working.connect().unwrap(), "new", "New edit", 3);
    client(&remote.connect().unwrap(), "own", "Own", LARGE);
    let second_context = Context {
        fingerprint_version: 2,
        organization: context.organization.clone(),
        generation: context.generation.clone(),
        base_revision: 2,
        source_state_sha256: context.target_state_sha256.clone(),
        target_state_sha256: state_fingerprint(&remote.connect().unwrap()).unwrap(),
    };
    let mut canonical = changes(&own);
    for change in &mut canonical {
        change.canonical_rowid = LARGE;
    }
    let evidence = journal(working);
    let second = prepare(
        working,
        &second_context,
        &capture(working),
        Some(&acknowledgement(&own)),
        canonical.into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(second.model.conflict_count, 0);
    let c = merged_store(&second).connect().unwrap();
    assert_eq!(
        c.query_row("SELECT rowid,name FROM clients WHERE id='own'", [], |r| Ok(
            (r.get::<_, i64>(0)?, r.get::<_, String>(1)?)
        ))
        .unwrap(),
        (LARGE, "Edited after rebase".into())
    );
    assert_eq!(
        c.query_row("SELECT rowid FROM clients WHERE id='new'", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        LARGE + 1
    );
    assert_eq!(journal(merged_store(&second)), evidence);
    assert_eq!(journal(working), evidence);
    assert_eq!(journal(&store).len(), 1);
}

#[test]
fn conflicting_transaction_rolls_back_its_other_rows_and_never_prepares_an_installation() {
    let (_root, store, mut context) =
        super::super::tests::setup_with(|s| client(&s.connect().unwrap(), "common", "Original", 1));
    let (_remote_root, remote) = super::super::tests::copy_receiver(&store);
    let mut c = store.connect().unwrap();
    let tx = c.transaction().unwrap();
    client(&tx, "transaction-sibling", "Should roll back", 2);
    tx.execute(
        "UPDATE clients SET name='Local confidential edit' WHERE id='common'",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    remote
        .connect()
        .unwrap()
        .execute(
            "UPDATE clients SET name='Remote confidential edit' WHERE id='common'",
            [],
        )
        .unwrap();
    let p = pending(&remote);
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let original = journal(&store);
    let before = state_fingerprint(&store.connect().unwrap()).unwrap();
    let prepared = prepare(
        &store,
        &context,
        &capture(&store),
        None,
        changes(&p).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(prepared.model.conflict_count, 1);
    assert!(prepared.native.is_none());
    assert_eq!(
        prepared
            .model
            .connection
            .query_row(
                "SELECT COUNT(*) FROM merged_rows WHERE row_key_json='[\"transaction-sibling\"]'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let status = prepared.summary().to_string();
    assert!(!status.contains("confidential"));
    assert_eq!(journal(&store), original);
    assert_eq!(
        state_fingerprint(&store.connect().unwrap()).unwrap(),
        before
    );
}

#[test]
fn rejects_partial_acknowledgement_and_wrong_source_hash() {
    let (_root, store, mut context) = super::super::tests::setup_with(|_| {});
    let mut c = store.connect().unwrap();
    let tx = c.transaction().unwrap();
    client(&tx, "first", "First", 1);
    client(&tx, "second", "Second", 2);
    tx.commit().unwrap();
    let p = pending(&store);
    context.target_state_sha256 = state_fingerprint(&c).unwrap();
    let mut ack = acknowledgement(&p);
    ack.last_sequence -= 1;
    ack.change_count -= 1;
    assert!(prepare(
        &store,
        &context,
        &capture(&store),
        Some(&ack),
        changes(&p).into_iter().map(Ok),
        || Ok(())
    )
    .is_err());
    context.source_state_sha256 = "a".repeat(64);
    assert!(prepare(
        &store,
        &context,
        &capture(&store),
        Some(&acknowledgement(&p)),
        changes(&p).into_iter().map(Ok),
        || Ok(())
    )
    .is_err());
    assert_eq!(journal(&store).len(), 2);
}

#[test]
fn issued_invoice_payments_stock_effects_and_audit_replay_with_native_guards() {
    let (_root, store, mut context) = super::super::tests::setup_with(|s| {
        s.install_swiss_accounting_starter().unwrap();
    });
    let customer=store.create_record("clients",json!({"name":"Client fictif","address_line1":"Rue 1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
    let first = pending(&store);
    context.target_state_sha256 = state_fingerprint(&store.connect().unwrap()).unwrap();
    let saved=store.save_document_with_items(crate::models::SaveDocumentWithItemsInput {
        entity:"invoices".into(),id:None,data:json!({"client_id":customer["id"],"title":"Recette de fusion","service_date_from":"2026-09-08","service_date_to":"2026-09-08","currency":"CHF"}),
        items:vec![json!({"description":"Prestation fictive","quantity":1,"unit":"forfait","unit_price_cents":100_000,"discount_bp":0,"vat_bp":0})],
    }).unwrap();
    let invoice = saved["document"]["id"].as_str().unwrap();
    store
        .issue_invoice(invoice, Some("2026-09-08".into()), None)
        .unwrap();
    let payment = crate::models::RecordPaymentInput {
        request_id: Uuid::new_v4().to_string(),
        invoice_id: invoice.into(),
        amount_cents: 30_000,
        date: Some("2026-09-08".into()),
        method: Some("Banque".into()),
        reference: None,
        notes: None,
    };
    store.record_payment(payment.clone()).unwrap();
    let item=store.create_record("catalog_items",json!({"kind":"product","name":"Matériel fictif","unit":"piece","sales_price_cents":1000,"track_stock":true})).unwrap();
    store.record_stock_entry(serde_json::from_value(json!({"request_id":Uuid::new_v4().to_string(),"catalog_item_id":item["id"],"quantity_milli":10000,"reason":"Stock fictif","date":"2026-09-08"})).unwrap()).unwrap();
    store.record_stock_exit(serde_json::from_value(json!({"request_id":Uuid::new_v4().to_string(),"catalog_item_id":item["id"],"quantity_milli":2500,"reason":"Sortie fictive","date":"2026-09-08"})).unwrap()).unwrap();
    let evidence = journal(&store);
    let original = state_fingerprint(&store.connect().unwrap()).unwrap();
    let prepared = prepare(
        &store,
        &context,
        &capture(&store),
        Some(&acknowledgement(&first)),
        changes(&first).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    let merged = merged_store(&prepared);
    let c = merged.connect().unwrap();
    assert_eq!(state_fingerprint(&c).unwrap(), original);
    crate::audit::verify_audit_chain(&c).unwrap();
    let balances=c.prepare("SELECT journal_entry_id,SUM(debit_cents),SUM(credit_cents) FROM journal_lines GROUP BY journal_entry_id").unwrap().query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(balances.len(), 2);
    assert!(balances.iter().all(|(_, debit, credit)| debit == credit));
    assert!(balances.iter().any(|(_, debit, _)| *debit == 30_000));
    assert!(c
        .execute(
            "UPDATE invoices SET title='Forbidden rewrite' WHERE id=?1",
            [invoice]
        )
        .is_err());
    assert_eq!(
        c.query_row(
            "SELECT SUM(quantity_delta_milli) FROM stock_movements",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        7500
    );
    assert_eq!(
        merged.get_accounting_continuity().unwrap()["total_missing"],
        0
    );
    merged.record_payment(payment).unwrap();
    assert_eq!(
        journal(merged),
        evidence,
        "A repeated payment remains idempotent after guarded replay"
    );
    assert_eq!(journal(&store), evidence);
    assert_eq!(
        state_fingerprint(&store.connect().unwrap()).unwrap(),
        original
    );
}

#[test]
fn pending_project_keeps_its_device_timer_and_remote_task_closure_is_rejected() {
    let (_root, store, mut context) = super::super::tests::setup_with(|_| {});
    let (_remote_root, remote) = super::super::tests::copy_receiver(&store);
    let project = store
        .create_record("projects", json!({"name":"Travail hors ligne"}))
        .unwrap();
    store.connect().unwrap().execute("INSERT INTO active_timers(id,project_id,started_at,note) VALUES(1,?1,'2026-09-09T08:00:00Z','Travail local')",[project["id"].as_str().unwrap()]).unwrap();
    client(&remote.connect().unwrap(), "remote", "Remote", 1);
    let p = pending(&remote);
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let timer = store.get_active_timer().unwrap();
    let prepared = prepare(
        &store,
        &context,
        &capture(&store),
        None,
        changes(&p).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(merged_store(&prepared).get_active_timer().unwrap(), timer);
    assert_eq!(store.get_active_timer().unwrap(), timer);

    let mut project_id = String::new();
    let mut task_id = String::new();
    let (_root, store, mut context) = super::super::tests::setup_with(|s| {
        let project = s
            .create_record("projects", json!({"name":"Projet initial"}))
            .unwrap();
        project_id = project["id"].as_str().unwrap().into();
        let task = s
            .save_project_task(
                serde_json::from_value(json!({"project_id":project_id,"title":"Intervention"}))
                    .unwrap(),
            )
            .unwrap();
        task_id = task["id"].as_str().unwrap().into();
    });
    let (_remote_root, remote) = super::super::tests::copy_receiver(&store);
    store.connect().unwrap().execute("INSERT INTO active_timers(id,project_id,task_id,started_at,note) VALUES(1,?1,?2,'2026-09-09T08:00:00Z','Travail local')",params![project_id,task_id]).unwrap();
    client(&store.connect().unwrap(), "pending", "Local client", 1);
    remote.set_project_task_status(&task_id, "done").unwrap();
    let p = pending(&remote);
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let original = state_fingerprint(&store.connect().unwrap()).unwrap();
    let timer = store.get_active_timer().unwrap();
    let error = prepare(
        &store,
        &context,
        &capture(&store),
        None,
        changes(&p).into_iter().map(Ok),
        || Ok(()),
    )
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("active timer"), "{error}");
    assert_eq!(store.get_active_timer().unwrap(), timer);
    assert_eq!(
        state_fingerprint(&store.connect().unwrap()).unwrap(),
        original
    );
}

#[test]
fn damaged_or_missing_canonical_alias_cache_cannot_replace_the_working_state() {
    let (_root, store, mut context) = super::super::tests::setup_with(|_| {});
    let (_remote_root, remote) = super::super::tests::copy_receiver(&store);
    client(&store.connect().unwrap(), "own", "Own", 1);
    let own = pending(&store);
    client(&remote.connect().unwrap(), "remote", "Remote", 1);
    let received = pending(&remote);
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let first = prepare(
        &store,
        &context,
        &capture(&store),
        None,
        changes(&received).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    let working = merged_store(&first);
    client(&remote.connect().unwrap(), "own", "Own", 2);
    let next = Context {
        fingerprint_version: 2,
        organization: context.organization.clone(),
        generation: context.generation.clone(),
        base_revision: 2,
        source_state_sha256: context.target_state_sha256.clone(),
        target_state_sha256: state_fingerprint(&remote.connect().unwrap()).unwrap(),
    };
    let canonical = || {
        changes(&own).into_iter().map(|mut r| {
            r.canonical_rowid = 2;
            Ok(r)
        })
    };
    // Without the aliases, original rowid=1 cannot explain the remapped rowid=2.
    assert!(prepare(
        working,
        &next,
        &capture(working),
        Some(&acknowledgement(&own)),
        canonical(),
        || Ok(())
    )
    .is_err());
    copy_cache(&first, working, &context);
    let path = working
        .data_dir
        .join("business-canonical")
        .join(&context.generation)
        .join(format!("2-{}.sqlite", context.target_state_sha256));
    let cache = Connection::open(&path).unwrap();
    cache
        .execute("UPDATE row_aliases SET canonical_rowid=3", [])
        .unwrap();
    drop(cache);
    assert!(prepare(
        working,
        &next,
        &capture(working),
        Some(&acknowledgement(&own)),
        canonical(),
        || Ok(())
    )
    .is_err());
    assert_eq!(
        working
            .connect()
            .unwrap()
            .query_row("SELECT rowid FROM clients WHERE id='own'", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(journal(working), journal(&store));
}

#[test]
fn writes_after_the_read_cutoff_remain_local_and_do_not_change_the_prepared_snapshot() {
    let (_root, store, mut context) = super::super::tests::setup_with(|_| {});
    let (_remote_root, remote) = super::super::tests::copy_receiver(&store);
    client(&store.connect().unwrap(), "own", "Own", 1);
    client(&remote.connect().unwrap(), "remote", "Remote", 1);
    let received = pending(&remote);
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let cutoff = state_fingerprint(&store.connect().unwrap()).unwrap();
    let calls = std::cell::Cell::new(0);
    let prepared = prepare(
        &store,
        &context,
        &capture(&store),
        None,
        changes(&received).into_iter().map(Ok),
        || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                client(
                    &store.connect().unwrap(),
                    "during-preparation",
                    "New local work",
                    2,
                );
            }
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(prepared.model.current_sha256, cutoff);
    assert_eq!(journal(merged_store(&prepared)).len(), 1);
    assert_eq!(journal(&store).len(), 2);
    assert_ne!(
        state_fingerprint(&store.connect().unwrap()).unwrap(),
        cutoff
    );
    assert_eq!(
        merged_store(&prepared)
            .connect()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM clients WHERE id='during-preparation'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connect()
            .unwrap()
            .query_row(
                "SELECT name FROM clients WHERE id='during-preparation'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "New local work"
    );
    assert_eq!(prepared.summary()["installed"], false);
}

#[test]
fn even_a_matching_received_hash_cannot_bypass_issued_invoice_guards_in_reconciliation() {
    let mut invoice_id = String::new();
    let (_root, store, mut context) = super::super::tests::setup_with(|s| {
        s.install_swiss_accounting_starter().unwrap();
        let customer=s.create_record("clients",json!({"name":"Client fictif","address_line1":"Rue 1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
        let invoice=s.save_document_with_items(crate::models::SaveDocumentWithItemsInput {
            entity:"invoices".into(),id:None,data:json!({"client_id":customer["id"],"title":"Prestation","currency":"CHF","service_date_from":"2026-09-08","service_date_to":"2026-09-08"}),
            items:vec![json!({"description":"Service","quantity":1,"unit":"forfait","unit_price_cents":10000,"discount_bp":0,"vat_bp":0})],
        }).unwrap();
        invoice_id = invoice["document"]["id"].as_str().unwrap().into();
        s.issue_invoice(&invoice_id, Some("2026-09-08".into()), None)
            .unwrap();
    });
    let (_oracle_root, oracle) = super::super::tests::copy_receiver(&store);
    client(&store.connect().unwrap(), "local", "Local pending", 2);
    let c = oracle.connect().unwrap();
    let key = json!([invoice_id]).to_string();
    let rule = &policy().unwrap().tables["invoices"];
    let (rowid, before) = current(&c, "invoices", rule, &key).unwrap().unwrap();
    let after: String = c
        .query_row(
            "SELECT json_set(?1,'$.title','Forbidden rewrite')",
            [&before],
            |r| r.get(0),
        )
        .unwrap();
    let change = RowChange {
        table: "invoices".into(),
        key_json: key,
        before_json: Some(before),
        after_json: Some(after),
        canonical_rowid: rowid,
    };
    context.target_state_sha256 =
        super::super::tests::expected_hash(&oracle, std::slice::from_ref(&change));
    let original = state_fingerprint(&store.connect().unwrap()).unwrap();
    let evidence = journal(&store);
    let error = prepare(
        &store,
        &context,
        &capture(&store),
        None,
        [Ok(change)],
        || Ok(()),
    )
    .err()
    .unwrap();
    assert!(
        matches!(error, AppError::Database(_)),
        "Native invoice guard must reject the rewrite: {error}"
    );
    assert_eq!(
        state_fingerprint(&store.connect().unwrap()).unwrap(),
        original
    );
    assert_eq!(journal(&store), evidence);
}
