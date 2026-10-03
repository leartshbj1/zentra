// Prepared real LocalStore regressions. Not parsed, compiled or run locally.
// Include inside fixed_assets::tests as a child module with `use super::*;`.
use super::*;

fn small_late_asset() -> (tempfile::TempDir, LocalStore, AssetInput) {
    let (directory, store, mut asset) = fixture();
    asset.date = "2024-12-31".into();
    asset.cost_cents = 100;
    asset.residual_cents = 0;
    asset.rate_bp = 2000;
    (directory, store, asset)
}

fn financial_snapshot(store: &LocalStore) -> Value {
    let db = store.connect().unwrap();
    let mut result = serde_json::Map::new();
    for table in ["journal_entries", "journal_lines", "accounting_sequences", "accounting_periods", "audit_log", "company_local_clock"] {
        result.insert(table.into(), json!(query_all(&db, &format!("SELECT * FROM {table} ORDER BY rowid"), []).unwrap()));
    }
    Value::Object(result)
}

#[test]
fn a_zero_acquisition_prorata_keeps_the_next_positive_year_available_and_replay_exact() {
    let (_directory, store, asset) = small_late_asset();
    assert_eq!(annual_amount(&asset, 2024, 0).unwrap(), 0);
    assert_eq!(annual_amount(&asset, 2025, 0).unwrap(), 20);
    let registered = register(&store, asset.clone()).unwrap();
    assert_eq!(registered["items"][0]["nextYear"], 2025);
    assert_eq!(registered["items"][0]["nextAmountCents"], 20);
    let receipt = depreciate(&store, &asset.id, 2025, 20).unwrap();
    assert_eq!(receipt["items"][0]["nextYear"], 2026);
    assert_eq!(receipt["items"][0]["bookValueCents"], 80);
    assert_eq!(receipt["items"][0]["history"].as_array().unwrap().len(), 1);
    assert_eq!(receipt["items"][0]["history"][0]["source_event"], "depreciation:2025");
    let before_replay = financial_snapshot(&store);
    assert_eq!(depreciate(&store, &asset.id, 2025, 20).unwrap(), receipt);
    assert_eq!(financial_snapshot(&store), before_replay);
    assert!(posted(&store.connect().unwrap(), &asset.id, "depreciation:2024").unwrap().is_none());
}

#[test]
fn skipping_a_zero_amount_never_skips_a_positive_or_closed_year() {
    let (_directory, store, asset) = small_late_asset();
    register(&store, asset.clone()).unwrap();
    let initial = financial_snapshot(&store);
    assert!(depreciate(&store, &asset.id, 2024, 0).is_err());
    assert!(depreciate(&store, &asset.id, 2026, 20).is_err());
    assert_eq!(financial_snapshot(&store), initial);
    store.connect().unwrap().execute(
        "INSERT INTO accounting_periods VALUES('zero-prorata-closed','Clôture','2025-01-01','2025-12-31','closed','2026-01-01','2025-01-01','2026-01-01')", []
    ).unwrap();
    let closed = financial_snapshot(&store);
    let reason = depreciate(&store, &asset.id, 2025, 20).unwrap_err();
    assert!(reason.to_string().contains("clôturée"));
    assert!(depreciate(&store, &asset.id, 2026, 20).is_err());
    assert_eq!(financial_snapshot(&store), closed);
}

#[test]
fn a_failed_audit_rolls_back_the_skipped_year_posting_and_success_can_be_retried_once() {
    let (_directory, store, asset) = small_late_asset();
    register(&store, asset.clone()).unwrap();
    let initial = financial_snapshot(&store);
    store.connect().unwrap().execute_batch(
        "CREATE TRIGGER synthetic_zero_prorata_audit_refusal BEFORE INSERT ON audit_log WHEN NEW.action='fixed_asset_depreciated' BEGIN SELECT RAISE(ABORT,'synthetic depreciation audit refusal'); END;"
    ).unwrap();
    let reason = depreciate(&store, &asset.id, 2025, 20).unwrap_err();
    assert!(reason.to_string().contains("synthetic depreciation audit refusal"));
    assert_eq!(financial_snapshot(&store), initial);
    store.connect().unwrap().execute_batch("DROP TRIGGER synthetic_zero_prorata_audit_refusal").unwrap();
    depreciate(&store, &asset.id, 2025, 20).unwrap();
    let recorded = financial_snapshot(&store);
    depreciate(&store, &asset.id, 2025, 20).unwrap();
    assert_eq!(financial_snapshot(&store), recorded);
}

#[test]
fn an_extourned_asset_remains_visible_even_when_its_annual_calculation_would_refuse() {
    let (_directory, store, asset) = small_late_asset();
    register(&store, asset.clone()).unwrap();
    let db = store.connect().unwrap();
    let acquired = posted(&db, &asset.id, "acquired").unwrap().unwrap();
    // Synthetic historical anomaly, not an authorized application reversal.
    // The old list reports its blocker without evaluating this invalid total.
    for (id, event, amount, reversal) in [
        ("synthetic-excess-depreciation", "depreciation:2025", 200_i64, None),
        ("synthetic-acquisition-reversal", "synthetic-reversal", 100_i64, acquired["id"].as_str()),
    ] {
        db.execute(
            "INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,status,reversal_of,created_at) VALUES(?,?,'2025-12-31','Synthetic historical fixture','fixed_asset',?,?,'posted',?,'2025-12-31')",
            params![id, id, asset.id, event, reversal],
        ).unwrap();
        db.execute(
            "INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,created_at) VALUES(?,?,?, ?,0,'CHF','2025-12-31'),(?,?,?,0,?,'CHF','2025-12-31')",
            params![format!("{id}-debit"), id, asset.counterpart_account_id, amount, format!("{id}-credit"), id, asset.asset_account_id, amount],
        ).unwrap();
    }
    assert!(annual_amount(&asset, 2026, 200).is_err());
    let before = financial_snapshot(&store);
    let receipt = list(&store).unwrap();
    let item = &receipt["items"][0];
    assert!(item["blocker"].as_str().unwrap().contains("extournée"));
    assert_eq!(item["nextAmountCents"], 0);
    assert_eq!(item["nextYear"], 2025);
    assert!(depreciate(&store, &asset.id, 2025, 200).unwrap_err().to_string().contains("extournée"));
    assert_eq!(financial_snapshot(&store), before);
}

#[test]
fn a_cancelled_zero_prorata_asset_preserves_its_inactive_receipt_and_replay() {
    let (_directory, store, asset) = small_late_asset();
    register(&store, asset.clone()).unwrap();
    let receipt = cancel(&store, &asset.id, "2025-01-01").unwrap();
    assert_eq!(receipt["items"][0]["cancelled"], true);
    assert_eq!(receipt["items"][0]["bookValueCents"], 0);
    assert_eq!(receipt["items"][0]["nextYear"], 2024);
    assert_eq!(receipt["items"][0]["nextAmountCents"], 0);
    let before = financial_snapshot(&store);
    assert_eq!(cancel(&store, &asset.id, "2025-01-01").unwrap(), receipt);
    assert!(depreciate(&store, &asset.id, 2025, 20).is_err());
    assert_eq!(financial_snapshot(&store), before);
}

#[test]
fn a_fully_depreciated_asset_preserves_its_inactive_next_year_without_new_posting() {
    let (_directory, store, mut asset) = small_late_asset();
    asset.date = "2024-01-01".into();
    asset.rate_bp = 10000;
    register(&store, asset.clone()).unwrap();
    let receipt = depreciate(&store, &asset.id, 2024, 100).unwrap();
    assert_eq!(receipt["items"][0]["bookValueCents"], 0);
    assert_eq!(receipt["items"][0]["nextYear"], 2025);
    assert_eq!(receipt["items"][0]["nextAmountCents"], 0);
    let before = financial_snapshot(&store);
    assert_eq!(list(&store).unwrap(), receipt);
    assert!(depreciate(&store, &asset.id, 2025, 0).is_err());
    assert_eq!(financial_snapshot(&store), before);
}
