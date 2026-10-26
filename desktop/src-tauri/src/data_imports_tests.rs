use super::*;
use crate::{
    bexio_import::BexioContactRow,
    catalog_import::{CatalogImportConflictPolicy, CatalogImportRowInput},
    models::RecordPaymentInput,
    opening_balances::{OpeningBalanceLineInput, OpeningReceivableRow},
};

fn store(accounting: bool) -> (tempfile::TempDir, LocalStore) {
    let temporary = tempfile::tempdir().unwrap();
    let store = LocalStore::initialize(temporary.path().join("profile")).unwrap();
    store.complete_onboarding(crate::tests::test_onboarding(), "data-import-test").unwrap();
    if accounting {
        crate::tests::enable_accounting(&store);
    }
    (temporary, store)
}

fn origin(source: &str) -> ImportOrigin {
    ImportOrigin { source: source.into(), file_name: Some("export.csv".into()) }
}

fn contacts(store: &LocalStore, entity: &str, names: &[&str]) -> MigrationContactsInput {
    MigrationContactsInput {
        origin: origin("winbiz"),
        contacts: BexioContactImport {
            scope: crate::bexio_import::scope(store).unwrap(),
            entity: entity.into(),
            rows: names
                .iter()
                .enumerate()
                .map(|(index, name)| BexioContactRow {
                    line: index + 2,
                    data: json!({"name":name,"address_line1":"Rue du Lac 1","postal_code":"1200","city":"Genève","country":"CH"}),
                })
                .collect(),
        },
    }
}

fn count(store: &LocalStore, sql: &str) -> i64 {
    store.connect().unwrap().query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn a_contact_import_is_recorded_replayable_and_undone_except_used_records() {
    let (_temporary, store) = store(false);
    let receipt = store.import_migration_contacts(contacts(&store, "clients", &["Alpha SA", "Beta Sàrl"])).unwrap();
    assert_eq!(receipt["created"], 2);
    let import_id = receipt["import_id"].as_str().unwrap().to_owned();
    // Rejouer le même fichier ne crée rien.
    let replay = store.import_migration_contacts(contacts(&store, "clients", &[" alpha sa ", "Beta Sàrl"])).unwrap();
    assert_eq!((replay["created"].as_i64(), replay["skipped"].as_i64()), (Some(0), Some(2)));
    let listed = store.list_data_imports().unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert_eq!(listed[1]["source"], "winbiz");
    assert_eq!(listed[1]["file_name"], "export.csv");
    assert_eq!(store.get_data_import_report(&import_id).unwrap().as_array().unwrap().len(), 2);
    // Beta a déjà une facture : l'annulation la garde et le dit.
    let beta: String = store.connect().unwrap().query_row("SELECT id FROM clients WHERE name='Beta Sàrl'", [], |row| row.get(0)).unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "INSERT INTO invoices(id,client_id,title,type,status,issue_date,due_date,currency,created_at,updated_at) VALUES('draft-beta',?,'Brouillon','standard','brouillon','2026-01-05','2026-02-04','CHF','2026-01-05T00:00:00Z','2026-01-05T00:00:00Z')",
            [&beta],
        )
        .unwrap();
    let undone = store.undo_data_import(&import_id).unwrap();
    assert_eq!(undone["removed"], 1, "{undone}");
    assert_eq!(undone["kept"][0]["name"], "Beta Sàrl");
    assert_eq!(count(&store, "SELECT COUNT(*) FROM clients"), 1);
    assert!(store.undo_data_import(&import_id).unwrap_err().to_string().contains("déjà annulé"));
    // L'historique reste, marqué annulé.
    assert!(store.list_data_imports().unwrap()[1]["undone_at"].is_string());
    // Après l'annulation, la même reprise recrée Alpha.
    let again = store.import_migration_contacts(contacts(&store, "clients", &["Alpha SA"])).unwrap();
    assert_eq!(again["created"], 1);
}

#[test]
fn an_unknown_source_writes_nothing() {
    let (_temporary, store) = store(false);
    let mut input = contacts(&store, "suppliers", &["Gamma AG"]);
    input.origin.source = "excel".into();
    assert!(store.import_migration_contacts(input).is_err());
    assert_eq!(count(&store, "SELECT COUNT(*) FROM suppliers"), 0);
    assert_eq!(count(&store, "SELECT COUNT(*) FROM data_imports"), 0);
}

fn article(row_number: usize, sku: &str, price: i64) -> CatalogImportRowInput {
    CatalogImportRowInput {
        row_number,
        sku: sku.into(),
        name: format!("Article {sku}"),
        description: String::new(),
        unit: "pce".into(),
        purchase_cost_cents: 500,
        sales_price_cents: price,
        vat_bp: 810,
        kind: "product".into(),
        ean: None,
        trade_source: None,
    }
}

#[test]
fn undoing_a_catalog_import_restores_updated_prices_and_removes_new_articles() {
    let (_temporary, store) = store(false);
    store
        .import_catalog_items(ImportCatalogItemsInput { conflict_policy: CatalogImportConflictPolicy::Skip, rows: vec![article(2, "A-1", 1_000)] })
        .unwrap();
    let receipt = store
        .import_migration_catalog(MigrationCatalogInput {
            origin: origin("cresus"),
            catalog: ImportCatalogItemsInput { conflict_policy: CatalogImportConflictPolicy::Update, rows: vec![article(2, "A-1", 1_500), article(3, "B-2", 2_000)] },
        })
        .unwrap();
    assert_eq!((receipt["created_count"].as_i64(), receipt["updated_count"].as_i64()), (Some(1), Some(1)));
    let undone = store.undo_data_import(receipt["import_id"].as_str().unwrap()).unwrap();
    assert_eq!((undone["removed"].as_i64(), undone["restored"].as_i64()), (Some(1), Some(1)), "{undone}");
    assert_eq!(count(&store, "SELECT sales_price_cents FROM catalog_items WHERE sku='A-1'"), 1_000);
    assert_eq!(count(&store, "SELECT COUNT(*) FROM catalog_items WHERE sku='B-2'"), 0);
}

fn account(line: i64, code: &str, name: &str, kind: &str, normal: &str, section: &str) -> AccountImportRow {
    AccountImportRow { line, code: code.into(), name: name.into(), account_type: kind.into(), normal_balance: normal.into(), report_section: section.into() }
}

#[test]
fn a_chart_import_adds_only_missing_accounts_and_never_renames() {
    let (_temporary, store) = store(true);
    let existing: String = store.connect().unwrap().query_row("SELECT name FROM accounts WHERE code='1100'", [], |row| row.get(0)).unwrap();
    let receipt = store
        .import_migration_accounts(MigrationAccountsInput {
            origin: origin("banana"),
            rows: vec![
                account(2, "1100", "Clients", "asset", "debit", "current_assets"),
                account(3, "1025", "Banque Raiffeisen", "asset", "debit", "current_assets"),
                account(4, "6570", "Informatique", "expense", "debit", "other_operating_expense"),
            ],
        })
        .unwrap();
    assert_eq!((receipt["created"].as_i64(), receipt["skipped"].as_i64()), (Some(2), Some(1)));
    let name: String = store.connect().unwrap().query_row("SELECT name FROM accounts WHERE code='1100'", [], |row| row.get(0)).unwrap();
    assert_eq!(name, existing);
    // Une rubrique incohérente refuse tout le fichier.
    let refused = store
        .import_migration_accounts(MigrationAccountsInput {
            origin: origin("banana"),
            rows: vec![account(2, "1030", "Poste", "asset", "debit", "net_revenue"), account(3, "1031", "Autre", "asset", "debit", "current_assets")],
        })
        .unwrap_err();
    assert!(refused.to_string().contains("Ligne 2"), "{refused}");
    assert_eq!(count(&store, "SELECT COUNT(*) FROM accounts WHERE code IN ('1030','1031')"), 0);
    let undone = store.undo_data_import(receipt["import_id"].as_str().unwrap()).unwrap();
    assert_eq!(undone["removed"], 2);
    assert_eq!(count(&store, "SELECT COUNT(*) FROM accounts WHERE code IN ('1025','6570')"), 0);
}

fn client(store: &LocalStore) {
    store
        .connect()
        .unwrap()
        .execute(
            "INSERT INTO clients(id,name,address_line1,postal_code,city,country,created_at,updated_at) VALUES('client-open','Muster AG','Bahnhofstrasse 1','8001','Zürich','CH','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
}

fn receivable(line: i64, number: &str, open: i64) -> OpeningReceivableRow {
    OpeningReceivableRow { line, number: number.into(), client_id: "client-open".into(), issue_date: "2025-12-10".into(), due_date: "2026-01-09".into(), open_cents: open, total_cents: Some(open), title: None }
}

#[test]
fn undoing_open_invoices_cancels_and_reverses_only_unpaid_ones() {
    let (_temporary, store) = store(true);
    client(&store);
    let receipt = store
        .import_migration_receivables(MigrationReceivablesInput {
            origin: origin("abaninja"),
            receivables: OpeningReceivablesInput { rows: vec![receivable(2, "F-1", 10_000), receivable(3, "F-2", 20_000)] },
        })
        .unwrap();
    assert_eq!(receipt["created"], 2);
    let title: String = store.connect().unwrap().query_row("SELECT title FROM invoices WHERE number='F-1'", [], |row| row.get(0)).unwrap();
    assert!(title.contains("AbaNinja"), "{title}");
    let paid: String = store.connect().unwrap().query_row("SELECT id FROM invoices WHERE number='F-2'", [], |row| row.get(0)).unwrap();
    store
        .record_payment(RecordPaymentInput { request_id: Uuid::new_v4().to_string(), invoice_id: paid, amount_cents: 20_000, date: Some("2026-01-20".into()), method: Some("bank".into()), reference: None, notes: None })
        .unwrap();
    let undone = store.undo_data_import(receipt["import_id"].as_str().unwrap()).unwrap();
    assert_eq!((undone["removed"].as_i64(), undone["reversed"].as_i64()), (Some(1), Some(1)), "{undone}");
    assert_eq!(undone["kept"][0]["name"], "F-2");
    assert_eq!(count(&store, "SELECT COUNT(*) FROM invoices WHERE number='F-1' AND status='annulee'"), 1);
    // La créance annulée ne reste ni sur 1100 ni sur 9100.
    assert_eq!(
        count(&store, "SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0) FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='9100'"),
        -20_000
    );
    let continuity = store.get_accounting_continuity().unwrap();
    assert_eq!(continuity["semantic_posting_mismatches"], 0, "{continuity}");
}

fn balance(line: i64, code: &str, cents: i64) -> OpeningBalanceLineInput {
    OpeningBalanceLineInput { line, code: code.into(), name: None, balance_cents: Some(cents), debit_cents: None, credit_cents: None }
}

#[test]
fn undoing_an_opening_balance_reverses_it_and_allows_a_new_one() {
    let (_temporary, store) = store(true);
    client(&store);
    let receivables = store
        .import_migration_receivables(MigrationReceivablesInput {
            origin: origin("generic"),
            receivables: OpeningReceivablesInput { rows: vec![receivable(2, "F-9", 5_000)] },
        })
        .unwrap();
    let input = OpeningBalanceInput { entry_date: "2026-01-01".into(), lines: vec![balance(2, "1020", 100_000), balance(3, "2800", 100_000)] };
    let receipt = store.import_migration_balance(MigrationBalanceInput { origin: origin("generic"), balance: input.clone() }).unwrap();
    // Les factures comptées dans ce bilan ne s'annulent qu'après lui.
    let blocked = store.undo_data_import(receivables["import_id"].as_str().unwrap()).unwrap_err();
    assert!(blocked.to_string().contains("bilan"), "{blocked}");
    let undone = store.undo_data_import(receipt["import_id"].as_str().unwrap()).unwrap();
    assert_eq!(undone["reversed"], 1);
    assert_eq!(
        count(&store, "SELECT COALESCE(SUM(l.debit_cents-l.credit_cents),0) FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code='1020'"),
        0
    );
    store.import_migration_balance(MigrationBalanceInput { origin: origin("generic"), balance: input }).unwrap();
}
