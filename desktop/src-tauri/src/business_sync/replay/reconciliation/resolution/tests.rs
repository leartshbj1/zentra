use super::*;
use crate::business_sync::{outgoing, replay};
use serde_json::json;
use uuid::Uuid;

// These unit cases exercise row decisions only. The authenticated transport
// tests below delivery/incoming exercise real retained and received file bytes.
fn preview(
    prepared: &Prepared,
    scope: &Scope<'_>,
    request: Request,
    ensure_current: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    preview_impl(
        prepared,
        scope,
        request,
        ensure_current,
        |_| Ok(None),
        |_, _| Ok(()),
    )
}

struct Fixture {
    _roots: (tempfile::TempDir, tempfile::TempDir),
    store: LocalStore,
    prepared: Prepared,
    context: Context,
    capture: String,
    receipt: String,
    account: String,
    object: String,
}
impl Fixture {
    fn scope(&self) -> Scope<'_> {
        Scope {
            store: &self.store,
            context: &self.context,
            capture: &self.capture,
            receipt_sha256: &self.receipt,
            role: "owner",
            account_binding: &self.account,
            acknowledgement: None,
        }
    }
    fn ids(&self) -> Vec<String> {
        self.prepared.model.connection.prepare("SELECT transaction_id FROM pending_changes GROUP BY transaction_id ORDER BY MIN(sequence)").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }
    fn request(&self, choices: &[Choice]) -> Request {
        Request {
            review_id: review_id(&self.prepared, &self.scope()).unwrap(),
            after_sequence: None,
            decisions: self
                .ids()
                .into_iter()
                .zip(choices)
                .map(|(transaction_id, choice)| Decision {
                    transaction_id,
                    choice: *choice,
                })
                .collect(),
        }
    }
}
fn evidence(store: &LocalStore) -> (String, String, String) {
    let c = store.connect().unwrap();
    (
        state_fingerprint(&c).unwrap(),
        local_fingerprint(&c).unwrap(),
        native::internal_fingerprint(&c).unwrap(),
    )
}

fn fixture(later_edits: usize, invoice: bool) -> Fixture {
    let (root, store, mut context) = replay::tests::setup_with(|s| {
        s.install_swiss_accounting_starter().unwrap();
        let client = s.create_record("clients", json!({"name":"Nom initial","address_line1":"Rue fictive 1","postal_code":"1000","city":"Lausanne","country":"CH"})).unwrap();
        if invoice {
            s.save_document_with_items(crate::models::SaveDocumentWithItemsInput {
                entity:"invoices".into(),id:None,
                data:json!({"client_id":client["id"],"title":"Facture brouillon","service_date_from":"2026-09-08","service_date_to":"2026-09-08","currency":"CHF"}),
                items:vec![json!({"description":"Prestation fictive","quantity":1,"unit":"forfait","unit_price_cents":10_000,"vat_bp":0,"discount_bp":0})],
            }).unwrap();
        }
    });
    let (remote_root, remote) = replay::tests::copy_receiver(&store);
    let table = if invoice { "invoices" } else { "clients" };
    let id: String = store
        .connect()
        .unwrap()
        .query_row(&format!("SELECT id FROM {table}"), [], |r| r.get(0))
        .unwrap();
    if invoice {
        store
            .update_record("invoices", &id, json!({"title":"Titre changé hors ligne"}))
            .unwrap();
        remote
            .issue_invoice(&id, Some("2026-09-08".into()), None)
            .unwrap();
    } else {
        store
            .update_record("clients", &id, json!({"name":"Nom choisi sur ce poste"}))
            .unwrap();
        for index in 0..later_edits {
            store
                .update_record(
                    "clients",
                    &id,
                    json!({"notes":format!("Notes après le changement {index}")}),
                )
                .unwrap();
        }
        remote
            .update_record("clients", &id, json!({"name":"Nom reçu de l’autre poste"}))
            .unwrap();
    }
    let sent = outgoing::prepare_next(&remote, "org-replay", "owner")
        .unwrap()
        .unwrap();
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let capture: String = store
        .connect()
        .unwrap()
        .query_row("SELECT generation FROM business_sync_binding", [], |r| {
            r.get(0)
        })
        .unwrap();
    let prepared = super::super::prepare(
        &store,
        &context,
        &capture,
        None,
        super::super::tests::changes(&sent).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    assert!(prepared.model.conflict_count > 0);
    Fixture {
        _roots: (root, remote_root),
        store,
        prepared,
        context,
        capture,
        receipt: "a".repeat(64),
        account: "d".repeat(64),
        object: id,
    }
}

#[test]
fn explicit_review_shows_three_images_and_transaction_scope_without_leaking_into_status() {
    let f = fixture(0, false);
    let original = evidence(&f.store);
    let status = f.prepared.summary().to_string();
    assert!(!status.contains("Nom choisi"));
    assert!(!status.contains("Nom reçu"));
    let review = inspect(&f.prepared, &f.scope(), None, None).unwrap();
    assert_eq!(review["decision_scope"], "whole_transaction");
    assert_eq!(review["transactions"].as_array().unwrap().len(), 1);
    let transaction = &review["transactions"][0];
    assert!(
        transaction["change_count"].as_i64().unwrap() > 1,
        "The audit change is part of the same operation"
    );
    assert_eq!(
        transaction["conflict"]["base"]["fields"]["name"]["value"],
        "Nom initial"
    );
    assert_eq!(
        transaction["conflict"]["local"]["fields"]["name"]["value"],
        "Nom choisi sur ce poste"
    );
    assert_eq!(
        transaction["conflict"]["shared"]["fields"]["name"]["value"],
        "Nom reçu de l’autre poste"
    );
    assert_eq!(review["installed"], false);
    assert_eq!(review["acknowledged"], false);
    assert_eq!(evidence(&f.store), original);
}

#[test]
fn every_deleted_quote_line_is_reviewable_with_exact_unicode_text_and_bound_pages() {
    let description = format!("Conditions\n{}\nFin", "é🧾".repeat(5_001));
    let (root, store, mut context) = replay::tests::setup_with(|s| {
        let client = s
            .create_record("clients", json!({"name":"Client du devis de comparaison"}))
            .unwrap();
        s.save_document_with_items(crate::models::SaveDocumentWithItemsInput {
            entity:"quotes".into(), id:None,
            data:json!({"client_id":client["id"],"title":"Devis initial","currency":"CHF"}),
            items:(0..7).map(|n| json!({"description":if n==0 {description.clone()} else {format!("Prestation {n}")},"quantity":1,"unit":"forfait","unit_price_cents":5_000,"discount_bp":0,"vat_bp":0})).collect(),
        }).unwrap();
    });
    let (remote_root, remote) = replay::tests::copy_receiver(&store);
    let quote: String = store
        .connect()
        .unwrap()
        .query_row("SELECT id FROM quotes", [], |r| r.get(0))
        .unwrap();
    store.delete_record("quotes", &quote).unwrap();
    remote
        .update_record(
            "quotes",
            &quote,
            json!({"title":"Devis modifié par le collègue"}),
        )
        .unwrap();
    let sent = outgoing::prepare_next(&remote, "org-replay", "owner")
        .unwrap()
        .unwrap();
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let capture: String = store
        .connect()
        .unwrap()
        .query_row("SELECT generation FROM business_sync_binding", [], |r| {
            r.get(0)
        })
        .unwrap();
    let prepared = super::super::prepare(
        &store,
        &context,
        &capture,
        None,
        super::super::tests::changes(&sent).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    let f = Fixture {
        _roots: (root, remote_root),
        store,
        prepared,
        context,
        capture,
        receipt: "a".repeat(64),
        account: "d".repeat(64),
        object: quote,
    };
    let original = evidence(&f.store);
    assert!(f.prepared.model.conflict_count > 0);
    let id = f.ids()[0].clone();
    let review_id = review_id(&f.prepared, &f.scope()).unwrap();
    let mut after = None;
    let mut changes = Vec::new();
    loop {
        let result = details::rows(
            &f.prepared,
            &f.scope(),
            details::RowsRequest {
                review_id: review_id.clone(),
                local_transaction_id: id.clone(),
                after_sequence: after,
            },
        )
        .unwrap();
        let page = result["changes"].as_array().unwrap();
        assert!(page.len() <= 3);
        changes.extend(page.clone());
        after = result["next_after_sequence"].as_str().map(str::to_owned);
        if after.is_none() {
            assert_eq!(
                changes.len(),
                result["change_count"].as_u64().unwrap() as usize
            );
            break;
        }
    }
    assert_eq!(
        changes
            .iter()
            .filter(|r| r["table"] == "quote_items")
            .count(),
        7
    );
    assert!(changes.iter().any(|r| r["table"] == "quotes"
        && r["local"].is_null()
        && r["shared"]["fields"]["title"]["value"] == "Devis modifié par le collègue"));
    assert!(changes.iter().any(|r| r["table"] == "audit_log"));
    let row = changes
        .iter()
        .find(|r| r["base"]["fields"]["description"]["truncated"] == true)
        .unwrap();
    let sequence = row["sequence"].as_str().unwrap().to_owned();
    let mut offset = 0;
    let mut full = String::new();
    loop {
        let part = details::text(
            &f.prepared,
            &f.scope(),
            details::TextRequest {
                review_id: review_id.clone(),
                local_transaction_id: id.clone(),
                sequence: sequence.clone(),
                image: details::Image::Base,
                field: "description".into(),
                offset,
            },
        )
        .unwrap();
        assert!(part["text"].as_str().unwrap().chars().count() <= 8_000);
        full.push_str(part["text"].as_str().unwrap());
        let Some(next) = part["next_offset"].as_u64() else {
            break;
        };
        offset = next as usize;
    }
    assert_eq!(full, description);
    for (expected, transaction, after) in [
        ("f".repeat(64), id.clone(), None),
        (review_id.clone(), Uuid::new_v4().to_string(), None),
        (review_id.clone(), id.clone(), Some(i64::MAX.to_string())),
        (review_id.clone(), id.clone(), Some("0".into())),
    ] {
        assert!(details::rows(
            &f.prepared,
            &f.scope(),
            details::RowsRequest {
                review_id: expected,
                local_transaction_id: transaction,
                after_sequence: after
            }
        )
        .is_err());
    }
    for (image, field, offset) in [
        (details::Image::Local, "description", 0),
        (details::Image::Base, "unknown", 0),
        (details::Image::Base, "description", usize::MAX),
    ] {
        assert!(details::text(
            &f.prepared,
            &f.scope(),
            details::TextRequest {
                review_id: review_id.clone(),
                local_transaction_id: id.clone(),
                sequence: sequence.clone(),
                image,
                field: field.into(),
                offset
            }
        )
        .is_err());
    }
    let mut reader = f.scope();
    reader.role = "read_only";
    let read = inspect(&f.prepared, &reader, None, None).unwrap();
    assert_eq!(read["can_choose"], false);
    assert!(details::rows(
        &f.prepared,
        &reader,
        details::RowsRequest {
            review_id: read["review_id"].as_str().unwrap().into(),
            local_transaction_id: id,
            after_sequence: None
        }
    )
    .is_ok());
    assert_eq!(evidence(&f.store), original);
}

#[test]
fn both_choices_pass_native_guards_but_cannot_install_or_acknowledge_the_original_transaction() {
    let f = fixture(0, false);
    let original = evidence(&f.store);
    let local = preview(&f.prepared, &f.scope(), f.request(&[Choice::Local]), || {
        Ok(())
    })
    .unwrap();
    let shared = preview(
        &f.prepared,
        &f.scope(),
        f.request(&[Choice::Shared]),
        || Ok(()),
    )
    .unwrap();
    for result in [&local, &shared] {
        assert_eq!(result["state"], "resolution_preview");
        assert_eq!(result["native_guards_validated"], true);
        assert_eq!(result["can_install"], false);
        assert_eq!(result["installed"], false);
        assert_eq!(result["acknowledged"], false);
        assert_eq!(result["documents_verified"], false);
    }
    assert_eq!(
        shared["proposed_state_sha256"],
        f.context.target_state_sha256
    );
    assert_ne!(
        local["proposed_state_sha256"],
        shared["proposed_state_sha256"]
    );
    assert_ne!(local["decision_sha256"], shared["decision_sha256"]);
    assert_eq!(evidence(&f.store), original);
    assert_eq!(
        preview(
            &f.prepared,
            &f.scope(),
            f.request(&[Choice::Shared]),
            || Ok(())
        )
        .unwrap()["decision_sha256"],
        shared["decision_sha256"]
    );
}

#[test]
fn dependent_later_edits_remain_explicit_until_every_affected_transaction_is_chosen() {
    let f = fixture(1, false);
    let original = evidence(&f.store);
    let partial = preview(
        &f.prepared,
        &f.scope(),
        f.request(&[Choice::Shared]),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(partial["state"], "resolution_needs_review");
    assert_eq!(partial["conflict_count"], 1);
    assert_eq!(partial["native_guards_validated"], false);
    let complete = preview(
        &f.prepared,
        &f.scope(),
        f.request(&[Choice::Shared, Choice::Shared]),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(complete["state"], "resolution_preview");
    assert_eq!(
        complete["proposed_state_sha256"],
        f.context.target_state_sha256
    );
    assert_eq!(evidence(&f.store), original);
}

#[test]
fn old_receipt_role_selection_duplicates_and_unknown_transactions_cannot_authorize_a_preview() {
    let f = fixture(0, false);
    let original = evidence(&f.store);
    let mut wrong_receipt = f.scope();
    let other = "b".repeat(64);
    wrong_receipt.receipt_sha256 = &other;
    assert!(preview(
        &f.prepared,
        &wrong_receipt,
        f.request(&[Choice::Local]),
        || Ok(())
    )
    .is_err());
    let mut reader = f.scope();
    reader.role = "read_only";
    assert!(preview(&f.prepared, &reader, f.request(&[Choice::Local]), || Ok(())).is_err());
    let mut changed_role = f.scope();
    changed_role.role = "member";
    assert!(preview(
        &f.prepared,
        &changed_role,
        f.request(&[Choice::Local]),
        || Ok(())
    )
    .is_err());
    let mut changed_account = f.scope();
    changed_account.account_binding = &other;
    assert!(preview(
        &f.prepared,
        &changed_account,
        f.request(&[Choice::Local]),
        || Ok(())
    )
    .is_err());
    assert_ne!(
        review_id(&f.prepared, &changed_account).unwrap(),
        review_id(&f.prepared, &f.scope()).unwrap()
    );
    changed_account.account_binding = "";
    assert!(inspect(&f.prepared, &changed_account, None, None).is_err());
    let mut repeated = f.request(&[Choice::Local]);
    repeated.decisions.push(Decision {
        transaction_id: repeated.decisions[0].transaction_id.clone(),
        choice: Choice::Shared,
    });
    assert!(preview(&f.prepared, &f.scope(), repeated, || Ok(())).is_err());
    let mut unknown = f.request(&[Choice::Local]);
    unknown.decisions[0].transaction_id = Uuid::new_v4().to_string();
    assert!(preview(&f.prepared, &f.scope(), unknown, || Ok(())).is_err());
    assert_eq!(evidence(&f.store), original);
    f.store
        .update_record(
            "clients",
            &f.object,
            json!({"notes":"Nouvelle saisie après affichage"}),
        )
        .unwrap();
    let updated = evidence(&f.store);
    assert!(
        preview(&f.prepared, &f.scope(), f.request(&[Choice::Local]), || Ok(
            ()
        ))
        .is_err()
    );
    assert_eq!(evidence(&f.store), updated);
}

#[test]
fn keeping_an_offline_draft_cannot_rewrite_an_invoice_issued_by_the_other_installation() {
    let f = fixture(0, true);
    let original = evidence(&f.store);
    assert!(
        preview(&f.prepared, &f.scope(), f.request(&[Choice::Local]), || Ok(
            ()
        ))
        .is_err()
    );
    let shared = preview(
        &f.prepared,
        &f.scope(),
        f.request(&[Choice::Shared]),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(shared["state"], "resolution_preview");
    assert_eq!(
        shared["proposed_state_sha256"],
        f.context.target_state_sha256
    );
    assert_eq!(evidence(&f.store), original);
}

#[test]
fn comparison_cells_and_page_cursors_are_bounded_without_changing_original_images() {
    let text = "é".repeat(2_001);
    let image = display_image(Some(json!({"notes":text,"amount_cents":900}).to_string())).unwrap();
    assert_eq!(
        image["fields"]["notes"]["value"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2_000
    );
    assert_eq!(image["fields"]["notes"]["truncated"], true);
    let different_tail = display_image(Some(
        json!({"notes":format!("{}fin", "é".repeat(2_000))}).to_string(),
    ))
    .unwrap();
    assert_eq!(
        image["fields"]["notes"]["value"],
        different_tail["fields"]["notes"]["value"]
    );
    assert_ne!(
        image["fields"]["notes"]["text_sha256"],
        different_tail["fields"]["notes"]["text_sha256"]
    );
    assert_eq!(image["fields"]["amount_cents"]["value"], 900);
    assert_eq!(display_image(None).unwrap(), Value::Null);
    let exact = display_image(Some(
        json!({"maximum":i64::MAX,"minimum":i64::MIN,"safe":9_007_199_254_740_991i64}).to_string(),
    ))
    .unwrap();
    assert_eq!(exact["fields"]["maximum"]["value"], i64::MAX.to_string());
    assert_eq!(exact["fields"]["minimum"]["value"], i64::MIN.to_string());
    assert_eq!(exact["fields"]["maximum"]["exact_integer"], true);
    assert_eq!(exact["fields"]["safe"]["exact_integer"], false);
    for invalid in ["0", "-1", "01", "1e3", "9223372036854775808"] {
        assert!(page_cursor(Some(invalid)).is_err());
    }
    assert_eq!(
        page_cursor(Some("9007199254740993")).unwrap(),
        9_007_199_254_740_993
    );
}

#[test]
fn choosing_local_when_both_images_already_match_requires_no_empty_replay_transaction() {
    let (root, store, mut context) = replay::tests::setup_with(|s| {
        s.create_record("clients", json!({"name":"Nom initial"}))
            .unwrap();
    });
    let (remote_root, remote) = replay::tests::copy_receiver(&store);
    for profile in [&store, &remote] {
        profile
            .connect()
            .unwrap()
            .execute("UPDATE clients SET name='Même valeur choisie'", [])
            .unwrap();
    }
    context.target_state_sha256 = state_fingerprint(&remote.connect().unwrap()).unwrap();
    let capture: String = store
        .connect()
        .unwrap()
        .query_row("SELECT generation FROM business_sync_binding", [], |r| {
            r.get(0)
        })
        .unwrap();
    let sent = outgoing::prepare_next(&remote, "org-replay", "owner")
        .unwrap()
        .unwrap();
    let prepared = super::super::prepare(
        &store,
        &context,
        &capture,
        None,
        super::super::tests::changes(&sent).into_iter().map(Ok),
        || Ok(()),
    )
    .unwrap();
    let f = Fixture {
        _roots: (root, remote_root),
        store,
        prepared,
        context,
        capture,
        receipt: "a".repeat(64),
        account: "d".repeat(64),
        object: String::new(),
    };
    let before = evidence(&f.store);
    let result = preview(&f.prepared, &f.scope(), f.request(&[Choice::Local]), || {
        Ok(())
    })
    .unwrap();
    assert_eq!(result["state"], "resolution_preview");
    assert_eq!(
        result["proposed_state_sha256"],
        f.context.target_state_sha256
    );
    assert_eq!(evidence(&f.store), before);
}

#[test]
fn comparison_and_preview_pages_require_the_same_review_and_preserve_every_transaction() {
    let f = fixture(5, false);
    let first = inspect(&f.prepared, &f.scope(), None, None).unwrap();
    assert_eq!(first["transactions"].as_array().unwrap().len(), 4);
    let cursor = first["next_after_sequence"].as_str().unwrap();
    let id = first["review_id"].as_str().unwrap();
    assert!(inspect(&f.prepared, &f.scope(), Some(cursor), None).is_err());
    assert!(inspect(&f.prepared, &f.scope(), Some(cursor), Some(&"c".repeat(64))).is_err());
    let second = inspect(&f.prepared, &f.scope(), Some(cursor), Some(id)).unwrap();
    assert_eq!(second["transactions"].as_array().unwrap().len(), 2);
    assert_eq!(second["next_after_sequence"], Value::Null);
    let shown: Vec<_> = first["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["transactions"].as_array().unwrap())
        .map(|v| v["transaction_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(shown, f.ids());
    let mut request = f.request(&[Choice::Shared; 6]);
    request.after_sequence = Some(cursor.into());
    let next = preview(&f.prepared, &f.scope(), request, || Ok(())).unwrap();
    assert_eq!(next["state"], "resolution_preview");
    assert_eq!(next["transactions"].as_array().unwrap().len(), 2);
    assert_eq!(next["review_id"], id);
    assert_eq!(next["next_after_sequence"], Value::Null);
}

#[test]
fn replacement_journals_preserve_originals_and_rebuild_audits_after_discarding_a_parent() {
    for selected in [
        [Choice::Local, Choice::Local],
        [Choice::Shared, Choice::Local],
        [Choice::Shared, Choice::Shared],
    ] {
        let f = fixture(1, false);
        let original = evidence(&f.store);
        let id = Uuid::new_v4().to_string();
        let captured = std::cell::RefCell::new(None);
        preview_impl(
            &f.prepared,
            &f.scope(),
            f.request(&selected),
            || Ok(()),
            |_| {
                Ok(Some(DocumentReview {
                    final_count: 0,
                    files_to_replace: 0,
                    total_size_bytes: 0,
                    plan_sha256: "0".repeat(64),
                }))
            },
            |candidate, report| {
                let replacement = super::super::replacements::prepare(
                    candidate,
                    &f.store,
                    &id,
                    report,
                    "2026-09-09T12:00:00Z",
                )?;
                let repeated = super::super::replacements::prepare(
                    candidate,
                    &f.store,
                    &id,
                    report,
                    "2026-09-09T12:00:00Z",
                )?;
                assert_eq!(
                    serde_json::to_value(&replacement.plan).unwrap(),
                    serde_json::to_value(&repeated.plan).unwrap()
                );
                *captured.borrow_mut() = Some(replacement);
                Ok(())
            },
        )
        .unwrap();
        let replacement = captured.into_inner().unwrap();
        let plan = &replacement.plan;
        assert_eq!(plan.originals.len(), 2);
        assert_eq!(
            plan.transactions.len(),
            selected.iter().filter(|c| **c == Choice::Local).count()
        );
        assert_ne!(plan.replacement_capture_generation, f.capture);
        let generated = replacement.store().connect().unwrap();
        crate::audit::verify_audit_chain(&generated).unwrap();
        let live = f.store.connect().unwrap();
        let rows = |c: &Connection| {
            c.prepare("SELECT sequence,generation,transaction_id,table_name,before_json,after_json,source_rowid,base_revision FROM business_sync_changes WHERE generation=?1 ORDER BY sequence").unwrap().query_map([&f.capture],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,String>(6)?,r.get::<_,i64>(7)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(rows(&live), rows(&generated));
        let audit_count: i64 = generated
            .query_row(
                "SELECT COUNT(*) FROM audit_log WHERE action='sync.conflict_resolution'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(audit_count as usize, plan.transactions.len());
        let original_audits:Vec<String>=live.prepare("SELECT json_extract(after_json,'$.id') FROM business_sync_changes WHERE generation=?1 AND table_name='audit_log'").unwrap().query_map([&f.capture],|r|r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        for audit_id in original_audits {
            assert!(!generated
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM audit_log WHERE id=?1)",
                    [audit_id],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap());
        }
        let outgoing = outgoing::prepare_next(replacement.store(), "org-replay", "owner").unwrap();
        if let Some(first) = plan.transactions.first() {
            let outgoing = outgoing.unwrap();
            assert_eq!(outgoing.manifest.transaction_id, first.transaction_id);
            assert_eq!(outgoing.manifest.base_revision, 2);
            assert_eq!(
                outgoing.manifest.capture_generation,
                plan.replacement_capture_generation
            );
            assert_eq!(outgoing.manifest.first_sequence, first.first_sequence);
            assert_eq!(outgoing.manifest.last_sequence, first.last_sequence);
            assert_eq!(outgoing.manifest.change_count, first.changes.len());
            assert!(plan
                .originals
                .iter()
                .all(|o| o.transaction_id != outgoing.manifest.transaction_id));
        } else {
            assert!(outgoing.is_none());
            assert_eq!(plan.replacement_state_sha256, f.context.target_state_sha256);
        }
        assert_eq!(evidence(&f.store), original);
    }
}
