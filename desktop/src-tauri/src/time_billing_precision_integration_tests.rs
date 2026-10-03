    // Synthetic regression using the parent module's existing LocalStore fixtures.
    #[test]
    fn time_billing_half_cent_rounding_preserves_totals_links_and_replay() {
        let (_temporary, store) = initialized_store();
        store.update_settings(json!({
            "vat_registered": true,
            "default_vat_bp": 810,
            "uid_number": "CHE-123.456.789"
        })).unwrap();
        let (_client, project, employee) = time_billing_fixture(&store);
        let first = create_billable_time(&store, &project, &employee, "2026-10-01", 11, 5_010);
        let second = create_billable_time(&store, &project, &employee, "2026-10-02", 61, 10_001);
        let request = uuid::Uuid::new_v4().to_string();
        let input = time_billing_input(&request, &project, vec![second.clone(), first.clone()]);
        let created = store.create_invoice_from_time_entries(input).unwrap();
        assert_eq!(created["invoice"]["subtotal_cents"], 11_087);
        assert_eq!(created["invoice"]["discount_cents"], 0);
        assert_eq!(created["invoice"]["vat_cents"], 898);
        assert_eq!(created["invoice"]["total_cents"], 11_985);
        let quantity = created["items"][0]["quantity"].as_f64().unwrap();
        assert!((quantity - 11.0 / 60.0).abs() <= 0.000000001);
        let replay = store.create_invoice_from_time_entries(
            time_billing_input(&request, &project, vec![first.clone(), second]),
        ).unwrap();
        assert_eq!(replay["idempotent"], true);
        assert_eq!(replay["invoice"]["id"], created["invoice"]["id"]);
        assert_eq!(replay["batch"]["id"], created["batch"]["id"]);
        assert!(store.update_record("time_entries", &first, json!({"minutes": 12})).is_err());
        let invoice = created["invoice"]["id"].as_str().unwrap();
        store.delete_record("invoices", invoice).unwrap();
        let released = store.get_workspace().unwrap();
        assert!(released["time_entries"].as_array().unwrap().iter().all(|row| row["billing_status"] == "unbilled"));
    }
