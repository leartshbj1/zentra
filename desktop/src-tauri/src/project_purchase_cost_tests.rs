use super::*;

fn cost(store: &LocalStore, collection: &str, id: &str) -> serde_json::Value {
    store.get_workspace().unwrap()[collection]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id)
        .unwrap()
        .clone()
}

fn expense(store: &LocalStore, paid: bool) -> String {
    store
        .create_record(
            "expenses",
            json!({
                "date":"2026-02-10", "due_date":"2026-03-10", "paid_at":if paid {Some("2026-02-10")}else{None},
                "payment_status":if paid {"paid"}else{"pending"}, "supplier":"Coût projet",
                "reference":Uuid::new_v4().to_string(), "net_cents":10000,"vat_cents":810
            }),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn project_costs_keep_historical_non_registered_costs_and_do_not_write_on_read() {
    let (_dir, store, accounts) = fixture_with_registration(false);
    let id = expense(&store, true);
    let before = journal_count(&store);
    let row = cost(&store, "expenses", &id);
    assert_eq!(row["cost_cents"], 10810);
    assert_eq!(
        row["cost_cents"],
        balance(&store, &accounts["expense"], "2026-12-31")
    );
    assert_eq!(row["cost_basis"], "accounted");
    assert_eq!(row["cost_review_required"], false);
    assert_eq!(row["net_cents"], 10000);
    assert_eq!(row["vat_cents"], 810);
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE settings SET vat_registered=1,vat_number='CHE-123.456.789 TVA' WHERE id=1",
            [],
        )
        .unwrap();
    let mut dated = profile(false);
    dated.effective_from = "2026-03-01".into();
    store.create_vat_profile(dated).unwrap();
    for _ in 0..3 {
        assert_eq!(cost(&store, "expenses", &id), row);
    }
    assert_eq!(
        journal_count(&store),
        before,
        "workspace reads never reclassify historical purchases"
    );
}

#[test]
fn project_costs_follow_actual_vat_classification_changes_and_flag_missing_decisions() {
    let (_dir, store, accounts) = fixture();
    store.create_vat_profile(profile(false)).unwrap();
    let id = expense(&store, true);
    let unknown = cost(&store, "expenses", &id);
    assert_eq!(unknown["cost_cents"], 10000);
    assert_eq!(unknown["cost_review_required"], true);
    for (treatment, expected) in [
        ("input_materials", 10000),
        ("non_deductible", 10810),
        ("input_investments", 10000),
    ] {
        classify(&store, "expense", &id, treatment);
        let row = cost(&store, "expenses", &id);
        assert_eq!(row["cost_cents"], expected);
        assert_eq!(
            row["cost_cents"],
            balance(&store, &accounts["expense"], "2026-12-31")
        );
        assert_eq!(row["cost_review_required"], false);
    }
    // A legacy decision without its corresponding accounting correction is not a proven cost.
    store.connect().unwrap().execute("UPDATE vat_source_classifications SET treatment='non_deductible' WHERE source_type='expense' AND source_id=?",params![id]).unwrap();
    let missing = cost(&store, "expenses", &id);
    assert_eq!(missing["cost_cents"], 10000);
    assert_eq!(missing["cost_review_required"], true);
}

#[test]
fn project_costs_reconcile_supplier_invoices_credits_and_account_reclassifications() {
    let (_dir, store, accounts) = fixture_with_registration(false);
    let (invoice, lines) = draft(&store);
    store.validate_supplier_invoice(&invoice).unwrap();
    let (credit, line) = credit_draft(&store, "2026-03-15");
    validate_credit(&store, &credit);
    let purchase_cost = || {
        lines
            .iter()
            .map(|id| {
                cost(&store, "supplier_invoice_items", id)["cost_cents"]
                    .as_i64()
                    .unwrap()
            })
            .sum::<i64>()
    };
    assert_eq!(purchase_cost(), 21620);
    let credit_row = cost(&store, "supplier_credit_note_items", &line);
    assert_eq!(
        credit_row["cost_cents"], 5405,
        "credit is positive, deducted once by the report"
    );
    assert_eq!(credit_row["cost_review_required"], false);
    assert_eq!(
        purchase_cost() - 5405,
        balance(&store, &accounts["expense"], "2026-12-31")
    );
    store
        .reclassify_supplier_invoice_expense(ReclassifySupplierInvoiceExpenseInput {
            request_id: Uuid::new_v4().to_string(),
            supplier_invoice_id: invoice,
            effective_date: "2026-04-01".into(),
            reason: "Autre charge projet".into(),
            lines: vec![SupplierExpenseReclassificationLineInput {
                supplier_invoice_item_id: lines[0].clone(),
                new_expense_account_id: accounts["wages_expense"].clone(),
            }],
        })
        .unwrap();
    assert_eq!(
        purchase_cost(),
        21620,
        "changing the expense account does not change project cost"
    );
    assert_eq!(
        purchase_cost() - 5405,
        balance(&store, &accounts["expense"], "2026-12-31")
            + balance(&store, &accounts["wages_expense"], "2026-12-31")
    );
    assert_eq!(
        cost(&store, "supplier_invoice_items", &lines[0])["cost_review_required"],
        false
    );
}

#[test]
fn project_costs_include_input_vat_under_the_simple_tax_rate_method() {
    let (_dir, store, accounts) = fixture();
    store.create_vat_profile(profile(true)).unwrap();
    let id = expense(&store, true);
    classify(&store, "expense", &id, "input_materials");
    let (invoice, lines) = draft(&store);
    store.validate_supplier_invoice(&invoice).unwrap();
    let (credit, line) = credit_draft(&store, "2026-03-15");
    validate_credit(&store, &credit);
    for (table, id, expected) in [
        ("expenses", id, 10810),
        ("supplier_invoice_items", lines[0].clone(), 10810),
        ("supplier_credit_note_items", line, 5405),
    ] {
        let row = cost(&store, table, &id);
        assert_eq!(row["cost_cents"], expected);
        assert_eq!(row["cost_review_required"], false);
    }
    assert_eq!(balance(&store, &accounts["expense"], "2026-12-31"), 27025);
    assert_eq!(
        balance(&store, &accounts["vat_receivable"], "2026-12-31"),
        0
    );
}

#[test]
fn project_costs_distinguish_pending_estimates_and_missing_paid_journals() {
    let (_dir, store, _accounts) = fixture_with_registration(false);
    let id = expense(&store, false);
    let pending = cost(&store, "expenses", &id);
    assert_eq!(pending["cost_cents"], 10810);
    assert_eq!(pending["cost_basis"], "estimated");
    assert_eq!(pending["cost_review_required"], false);
    assert_eq!(journal_count(&store), 0);
    // Reproduce an old paid expense that has not been imported into accounting.
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE expenses SET payment_status='paid',paid_at='2026-02-10' WHERE id=?",
            params![id],
        )
        .unwrap();
    assert_eq!(cost(&store, "expenses", &id)["cost_review_required"], true);
}

#[test]
fn project_costs_hide_margin_for_legacy_cancelled_expenses_until_the_journal_is_restored() {
    let (_dir, store, _accounts) = fixture();
    let id = expense(&store, true);
    classify(&store, "expense", &id, "input_materials");
    let connection = store.connect().unwrap();
    let root: String = connection
        .query_row(
            "SELECT id FROM journal_entries WHERE source_type='expense' AND source_id=?",
            params![id],
            |r| r.get(0),
        )
        .unwrap();
    let tip = Uuid::new_v4().to_string();
    connection.execute("INSERT INTO journal_entries(id,number,entry_date,description,source_type,source_id,source_event,reversal_of,created_at) VALUES(?1,?1,'2026-04-10','Extourne historique','journal_reversal',?2,'reverse',?2,'2026-04-10')",params![tip,root]).unwrap();
    connection.execute("INSERT INTO journal_lines(id,journal_entry_id,account_id,debit_cents,credit_cents,currency,memo,project_id,client_id,employee_id,created_at) SELECT ?1||id,?1,account_id,credit_cents,debit_cents,currency,memo,project_id,client_id,employee_id,created_at FROM journal_lines WHERE journal_entry_id=?2",params![tip,root]).unwrap();
    assert_eq!(cost(&store, "expenses", &id)["cost_review_required"], true);
    store
        .reverse_journal_entry(&tip, "2026-05-10", Some("Rétablir la dépense".into()))
        .unwrap();
    assert_eq!(cost(&store, "expenses", &id)["cost_review_required"], false);
    assert_eq!(cost(&store, "expenses", &id)["cost_cents"], 10000);
}
