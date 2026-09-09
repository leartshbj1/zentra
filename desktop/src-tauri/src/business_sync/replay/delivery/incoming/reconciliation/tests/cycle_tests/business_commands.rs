//! Exercise real business commands through reception, guarded installation and
//! reconciliation. The receipt server is simulated; this is not an HTTPS test.
use super::*;

fn journal(store: &LocalStore) -> Vec<String> {
    store.connect().unwrap().prepare("SELECT json_array(sequence,generation,transaction_id,organization_id,installation_id,table_name,row_key_json,operation,before_json,after_json,source_rowid,base_revision) FROM business_sync_changes ORDER BY sequence")
        .unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

async fn receive(
    target: &LocalStore,
    source: &LocalStore,
    prepared: &outgoing::Prepared,
    before: &str,
    after: &str,
) -> Value {
    let (folder, header) = stage_from(target, source, prepared, before, after);
    let server = transport(target, folder, header);
    let result = cycle::pass(target.clone(), server.clone(), true)
        .await
        .unwrap();
    assert_eq!(result["state"], "installed", "{result}");
    assert!(!server
        .transport
        .calls
        .lock()
        .unwrap()
        .contains(&"send".into()));
    result
}

#[test]
fn issued_invoice_and_payment_reach_a_second_profile_with_an_offline_project_edit() {
    tauri::async_runtime::block_on(async {
        let (_source_root, source, initial) = replay::tests::setup_with(|s| {
            s.install_swiss_accounting_starter().unwrap();
            let client = s.create_record("clients", json!({"name":"Client recette partagée","address_line1":"Rue fictive 1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
            s.create_record(
                "projects",
                json!({"name":"Projet initial","client_id":client["id"]}),
            )
            .unwrap();
            s.save_document_with_items(crate::models::SaveDocumentWithItemsInput {
                entity: "invoices".into(), id: None,
                data: json!({"client_id":client["id"],"title":"Facture de recette","service_date_from":"2026-09-08","service_date_to":"2026-09-08","currency":"CHF"}),
                items: vec![json!({"description":"Prestation fictive","quantity":1,"unit":"forfait","unit_price_cents":100_000,"discount_bp":0,"vat_bp":0})],
            }).unwrap();
        });
        let (_receiver_root, receiver) = replay::tests::copy_receiver(&source);
        assert_ne!(source.installation_id, receiver.installation_id);
        let invoice: String = source
            .connect()
            .unwrap()
            .query_row("SELECT id FROM invoices", [], |r| r.get(0))
            .unwrap();
        let project: String = source
            .connect()
            .unwrap()
            .query_row("SELECT id FROM projects", [], |r| r.get(0))
            .unwrap();

        source
            .issue_invoice(&invoice, Some("2026-09-08".into()), None)
            .unwrap();
        assert_eq!(pending(&source), 1);
        let issued = outgoing::prepare_next(&source, "org-replay", "owner")
            .unwrap()
            .unwrap();
        let after_issue = replay::state_fingerprint(&source.connect().unwrap()).unwrap();
        receive(
            &receiver,
            &source,
            &issued,
            &initial.source_state_sha256,
            &after_issue,
        )
        .await;
        let confirmed = receive(
            &source,
            &source,
            &issued,
            &initial.source_state_sha256,
            &after_issue,
        )
        .await;
        assert_eq!(confirmed["detail"]["acknowledged"], true);
        assert_eq!(pending(&source), 0);
        assert_eq!(pending(&receiver), 0);
        assert_eq!(
            replay::state_fingerprint(&receiver.connect().unwrap()).unwrap(),
            after_issue
        );

        // This ordinary command also adds an audit branch. It stays pending
        // while the other installation records a payment against the invoice.
        receiver
            .update_record(
                "projects",
                &project,
                json!({"name":"Projet modifié hors ligne"}),
            )
            .unwrap();
        let offline_evidence = journal(&receiver);
        assert!(!offline_evidence.is_empty());
        let payment = crate::models::RecordPaymentInput {
            request_id: Uuid::new_v4().to_string(),
            invoice_id: invoice.clone(),
            amount_cents: 30_000,
            date: Some("2026-09-09".into()),
            method: Some("Banque".into()),
            reference: Some("RECETTE-PAIEMENT".into()),
            notes: None,
        };
        source.record_payment(payment.clone()).unwrap();
        assert_eq!(pending(&source), 1);
        let paid = outgoing::prepare_next(&source, "org-replay", "owner")
            .unwrap()
            .unwrap();
        let after_payment = replay::state_fingerprint(&source.connect().unwrap()).unwrap();
        let received = receive(&receiver, &source, &paid, &after_issue, &after_payment).await;
        assert_eq!(received["detail"]["acknowledged"], false);
        receive(&source, &source, &paid, &after_issue, &after_payment).await;
        assert_eq!(pending(&source), 0);
        assert_eq!(pending(&receiver), 1);
        assert_eq!(journal(&receiver), offline_evidence);
        assert_eq!(Binding::read(&receiver, "org-replay").unwrap().revision, 3);

        let c = receiver.connect().unwrap();
        assert_eq!(
            c.query_row("SELECT name FROM projects WHERE id=?1", [&project], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Projet modifié hors ligne"
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*),SUM(amount_cents) FROM payments WHERE invoice_id=?1",
                [&invoice],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            )
            .unwrap(),
            (1, 30_000)
        );
        let balances: Vec<(i64, i64)> = c.prepare("SELECT SUM(debit_cents),SUM(credit_cents) FROM journal_lines GROUP BY journal_entry_id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(balances.len(), 2);
        assert!(balances.iter().all(|(debit, credit)| debit == credit));
        assert!(balances.contains(&(100_000, 100_000)));
        assert!(balances.contains(&(30_000, 30_000)));
        crate::audit::verify_audit_chain(&c).unwrap();
        assert!(c
            .execute(
                "UPDATE invoices SET title='Modification interdite' WHERE id=?1",
                [&invoice]
            )
            .is_err());
        drop(c);
        assert_eq!(
            receiver.get_accounting_continuity().unwrap()["total_missing"],
            0
        );
        receiver.record_payment(payment).unwrap();
        assert_eq!(
            journal(&receiver),
            offline_evidence,
            "Replaying the payment request must not duplicate it after synchronization"
        );

        let reopened = LocalStore::initialize(receiver.data_dir.clone()).unwrap();
        assert_eq!(journal(&reopened), offline_evidence);
        assert_eq!(pending(&reopened), 1);
        assert_eq!(Binding::read(&reopened, "org-replay").unwrap().revision, 3);

        // Publish the offline project edit next. The simulated server retains
        // canonical positions assigned during the previous merge, including
        // the audit branch displaced by the other device's payment. Original
        // event bytes and their source positions must remain unchanged.
        let edited = outgoing::prepare_next(&reopened, "org-replay", "owner")
            .unwrap()
            .unwrap();
        let originals: Vec<_> = (0..edited.manifest.chunks.len())
            .map(|i| fs::read(edited.folder.join(format!("{i:04}.json"))).unwrap())
            .collect();
        let merged = replay::state_fingerprint(&reopened.connect().unwrap()).unwrap();
        let canonical = reopened.connect().unwrap();
        let policy = crate::business_sync::policy().unwrap();
        let mut remapped = false;
        for target in [&source, &reopened] {
            let changed_position = std::cell::Cell::new(false);
            let (folder, header) = stage_from_positions(
                target,
                &reopened,
                &edited,
                &after_payment,
                &merged,
                |change| {
                    let table = change["table"].as_str().unwrap();
                    let key = change["key_json"].as_str().unwrap();
                    let rowid: i64 = canonical
                        .query_row(
                            &format!(
                                "SELECT r.rowid FROM {} r WHERE {}=?1",
                                crate::business_sync::identifier(table).unwrap(),
                                crate::business_sync::json_key("r", &policy.tables[table].key)
                                    .unwrap()
                            ),
                            [key],
                            |r| r.get(0),
                        )
                        .unwrap();
                    let value = json!(rowid.to_string());
                    if value != change["source_rowid"] {
                        changed_position.set(true);
                    }
                    value
                },
            );
            remapped |= changed_position.get();
            let server = transport(target, folder, header);
            let result = cycle::pass(target.clone(), server, true).await.unwrap();
            assert_eq!(result["state"], "installed", "{result}");
            assert_eq!(
                result["detail"]["acknowledged"],
                target.installation_id == reopened.installation_id
            );
            assert_eq!(pending(target), 0);
            assert_eq!(Binding::read(target, "org-replay").unwrap().revision, 4);
            assert_eq!(
                replay::state_fingerprint(&target.connect().unwrap()).unwrap(),
                merged
            );
            crate::audit::verify_audit_chain(&target.connect().unwrap()).unwrap();
        }
        assert!(
            remapped,
            "The concurrent audit branches must exercise a canonical position change"
        );
        assert_eq!(journal(&reopened), offline_evidence);
        for (i, original) in originals.iter().enumerate() {
            assert_eq!(
                &fs::read(edited.folder.join(format!("{i:04}.json"))).unwrap(),
                original
            );
        }
    });
}

#[test]
fn quote_deletion_cascades_install_atomically_or_preserve_the_conflicting_offline_document() {
    tauri::async_runtime::block_on(async {
        for conflict in [false, true] {
            let (_source_root, source, initial) = replay::tests::setup_with(|s| {
                let client = s
                    .create_record("clients", json!({"name":"Client fictif du devis"}))
                    .unwrap();
                s.create_record("projects", json!({"name":"Projet du devis"}))
                    .unwrap();
                s.save_document_with_items(crate::models::SaveDocumentWithItemsInput {
                    entity: "quotes".into(), id: None,
                    data: json!({"client_id":client["id"],"title":"Devis brouillon partagé","currency":"CHF"}),
                    items: ["Prestation une", "Prestation deux"].iter().map(|description| json!({"description":description,"quantity":1,"unit":"forfait","unit_price_cents":5_000,"discount_bp":0,"vat_bp":0})).collect(),
                }).unwrap();
            });
            let (_receiver_root, receiver) = replay::tests::copy_receiver(&source);
            let quote: String = source
                .connect()
                .unwrap()
                .query_row("SELECT id FROM quotes", [], |r| r.get(0))
                .unwrap();
            if conflict {
                receiver
                    .update_record(
                        "quotes",
                        &quote,
                        json!({"title":"Devis modifié hors ligne"}),
                    )
                    .unwrap();
            } else {
                let project: String = receiver
                    .connect()
                    .unwrap()
                    .query_row("SELECT id FROM projects", [], |r| r.get(0))
                    .unwrap();
                receiver
                    .update_record(
                        "projects",
                        &project,
                        json!({"name":"Projet modifié hors ligne"}),
                    )
                    .unwrap();
            }
            let original = journal(&receiver);
            let working = replay::state_fingerprint(&receiver.connect().unwrap()).unwrap();
            source.delete_record("quotes", &quote).unwrap();
            let removed = outgoing::prepare_next(&source, "org-replay", "owner")
                .unwrap()
                .unwrap();
            let after = replay::state_fingerprint(&source.connect().unwrap()).unwrap();
            let (folder, header) = stage_from(
                &receiver,
                &source,
                &removed,
                &initial.source_state_sha256,
                &after,
            );
            let server = transport(&receiver, folder, header);
            let result = cycle::pass(receiver.clone(), server.clone(), true)
                .await
                .unwrap();
            assert_eq!(journal(&receiver), original);
            assert_eq!(acknowledged(&receiver), 0);
            assert_eq!(pending(&receiver), 1);
            assert!(!server
                .transport
                .calls
                .lock()
                .unwrap()
                .contains(&"send".into()));
            let c = receiver.connect().unwrap();
            let counts: (i64, i64) = c
                .query_row(
                    "SELECT (SELECT COUNT(*) FROM quotes),(SELECT COUNT(*) FROM quote_items)",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            if conflict {
                assert_eq!(result["state"], "conflict", "{result}");
                assert_eq!(result["workspace_changed"], false);
                assert_eq!(result["detail"]["conflict_count"], 1);
                assert_eq!(result["detail"]["conflicts"][0]["table"], "quotes");
                assert_eq!(counts, (1, 2));
                assert_eq!(replay::state_fingerprint(&c).unwrap(), working);
                assert_eq!(Binding::read(&receiver, "org-replay").unwrap().revision, 1);
                assert_eq!(
                    cycle::pass(receiver.clone(), server.clone(), true)
                        .await
                        .unwrap()["state"],
                    "conflict"
                );
                assert_eq!(journal(&receiver), original);
            } else {
                assert_eq!(result["state"], "installed", "{result}");
                assert_eq!(
                    counts,
                    (0, 0),
                    "The deleted quote and both children disappear in the same installation"
                );
                assert_eq!(
                    c.query_row("SELECT name FROM projects", [], |r| r.get::<_, String>(0))
                        .unwrap(),
                    "Projet modifié hors ligne"
                );
                assert_eq!(Binding::read(&receiver, "org-replay").unwrap().revision, 2);
                crate::audit::verify_audit_chain(&c).unwrap();
            }
        }
    });
}
