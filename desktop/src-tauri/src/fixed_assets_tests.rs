use super::*;
fn fixture() -> (tempfile::TempDir, LocalStore, AssetInput) {
    let dir = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(dir.path().join("a")).unwrap();
    store
        .complete_onboarding(crate::tests::test_onboarding(), "1.0.0")
        .unwrap();
    let accounts = crate::tests::enable_accounting(&store);
    for (id, code, kind, section) in [
        ("asset-fixture", "1500", "asset", "fixed_assets"),
        ("depreciation-fixture", "6800", "expense", "depreciation"),
    ] {
        store.connect().unwrap().execute("INSERT INTO accounts(id,code,name,account_type,normal_balance,report_section,active,created_at,updated_at) VALUES(?,?,?,?,'debit',?,1,'2024-01-01','2024-01-01')",params![id,code,id,kind,section]).unwrap();
    }
    let input = AssetInput {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Ordinateur".into(),
        date: "2024-01-01".into(),
        reference: "F-42".into(),
        cost_cents: 100000,
        residual_cents: 10000,
        rate_bp: 2000,
        method: "linear".into(),
        asset_account_id: "asset-fixture".into(),
        depreciation_account_id: "depreciation-fixture".into(),
        counterpart_account_id: accounts["bank"].clone(),
        mode: "purchase".into(),
    };
    (dir, store, input)
}
#[test]
fn fixed_assets_integer_schedule_handles_leap_proration_declining_and_residual() {
    let (_dir, _store, mut asset) = fixture();
    assert_eq!(annual_amount(&asset, 2024, 0).unwrap(), 20000);
    asset.date = "2024-07-01".into();
    assert_eq!(annual_amount(&asset, 2024, 0).unwrap(), 10055);
    asset.method = "declining".into();
    asset.date = "2024-01-01".into();
    asset.rate_bp = 4000;
    assert_eq!(annual_amount(&asset, 2024, 0).unwrap(), 40000);
    assert_eq!(annual_amount(&asset, 2025, 40000).unwrap(), 24000);
    assert_eq!(annual_amount(&asset, 2026, 89999).unwrap(), 1);
}
#[test]
fn fixed_assets_post_balanced_entries_once_and_survive_company_restore() {
    let (dir, store, asset) = fixture();
    register(&store, asset.clone()).unwrap();
    register(&store, asset.clone()).unwrap();
    depreciate(&store, &asset.id, 2024, 20000).unwrap();
    depreciate(&store, &asset.id, 2024, 20000).unwrap();
    let db = store.connect().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM journal_entries WHERE source_type='fixed_asset'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT SUM(debit_cents-credit_cents) FROM journal_lines",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let snapshot = dir.path().join("assets.zentra");
    store.create_backup_at(&snapshot, "1.89.0").unwrap();
    let other = LocalStore::initialize(dir.path().join("other")).unwrap();
    other
        .restore_company_snapshot(&snapshot.to_string_lossy(), || Ok(()))
        .unwrap();
    assert_eq!(list(&store).unwrap(), list(&other).unwrap());
    assert_eq!(list(&other).unwrap()["items"][0]["bookValueCents"], 80000);
    let v: i64 = other
        .connect()
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(v, 60);
}
#[test]
fn fixed_assets_preserve_value_on_bad_accounts_stale_requests_or_duplicate_reference() {
    let (_dir, store, asset) = fixture();
    let mut invalid = asset.clone();
    invalid.asset_account_id = invalid.counterpart_account_id.clone();
    assert!(register(&store, invalid).is_err());
    assert!(list(&store).unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    register(&store, asset.clone()).unwrap();
    let mut duplicate = asset.clone();
    duplicate.id = uuid::Uuid::new_v4().to_string();
    assert!(register(&store, duplicate).is_err());
    let mut changed = asset.clone();
    changed.cost_cents = 120000;
    assert!(register(&store, changed).is_err());
    assert!(depreciate(&store, &asset.id, 2025, 20000).is_err());
    assert!(depreciate(&store, &asset.id, 2024, 19999).is_err());
    assert_eq!(list(&store).unwrap()["items"][0]["bookValueCents"], 100000);
}
#[test]
fn fixed_assets_cancel_once_and_block_isolated_reversals_and_closed_years() {
    let (_dir, store, asset) = fixture();
    register(&store, asset.clone()).unwrap();
    let posting = posted(&store.connect().unwrap(), &asset.id, "acquired")
        .unwrap()
        .unwrap();
    assert!(store
        .reverse_journal_entry(posting["id"].as_str().unwrap(), "2024-02-01", None)
        .is_err());
    cancel(&store, &asset.id, "2024-02-01").unwrap();
    cancel(&store, &asset.id, "2024-02-01").unwrap();
    assert!(depreciate(&store, &asset.id, 2024, 20000).is_err());
    assert_eq!(list(&store).unwrap()["items"][0]["bookValueCents"], 0);
    let mut other = asset;
    other.id = uuid::Uuid::new_v4().to_string();
    register(&store, other.clone()).unwrap();
    store.connect().unwrap().execute("INSERT INTO accounting_periods VALUES('closed-fixture','Clôture','2024-01-01','2024-12-31','closed','2025-01-01','2024-01-01','2025-01-01')",[]).unwrap();
    assert!(depreciate(&store, &other.id, 2024, 20000).is_err());
}
#[test]
fn fixed_assets_colliding_device_depreciations_do_not_double_post() {
    let (dir, store, asset) = fixture();
    register(&store, asset.clone()).unwrap();
    let base = dir.path().join("base.zentra");
    store.create_backup_at(&base, "1.89.0").unwrap();
    let other = LocalStore::initialize(dir.path().join("other")).unwrap();
    other
        .restore_company_snapshot(&base.to_string_lossy(), || Ok(()))
        .unwrap();
    depreciate(&store, &asset.id, 2024, 20000).unwrap();
    depreciate(&other, &asset.id, 2024, 20000).unwrap();
    let local = dir.path().join("local.zentra");
    let remote = dir.path().join("remote.zentra");
    let merged = dir.path().join("merged.zentra");
    store.create_backup_at(&local, "1.89.0").unwrap();
    other.create_backup_at(&remote, "1.89.0").unwrap();
    assert!(crate::company_merge::merge(&store, &base, &local, &remote, &merged).is_err());
    assert_eq!(list(&store).unwrap()["items"][0]["bookValueCents"], 80000);
    assert!(!merged.exists());
}
