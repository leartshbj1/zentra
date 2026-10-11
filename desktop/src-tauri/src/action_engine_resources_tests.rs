use super::*;
use rusqlite::params;
use serde_json::{json, Value};

// Memory-only fixtures use the real column names and intentionally permit bad
// storage types so the reader, rather than SQLite CHECKs, is exercised.
fn fixture() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE settings (
                id INTEGER PRIMARY KEY, country TEXT, currency TEXT,
                onboarding_completed INTEGER, vat_registered INTEGER,
                default_vat_bp INTEGER, payment_terms_days INTEGER,
                quote_validity_days INTEGER, updated_at TEXT,
                iban TEXT, logo_path TEXT, extra_settings_json TEXT
            );
            INSERT INTO settings VALUES (1,'CH','CHF',1,1,810,30,30,
                '2026-10-11T08:00:00.123Z','PRIVATE-BANK','PRIVATE-PATH','PRIVATE-EXTRAS');
            CREATE TABLE clients (
                id TEXT PRIMARY KEY, name TEXT, email TEXT, archived_at TEXT,
                updated_at TEXT, notes TEXT, phone TEXT
            );
            INSERT INTO clients VALUES
                ('customer-b','Ancien client',NULL,'2026-10-10',
                '2026-10-10T08:01:00Z','PRIVATE-NOTE','PRIVATE-PHONE'),
                ('customer-a','Élodie 🚧',' ELODIE@example.test ',NULL,
                '2026-10-11T08:01:00Z','PRIVATE-NOTE','PRIVATE-PHONE');
            CREATE TABLE catalog_items (
                id TEXT PRIMARY KEY, kind TEXT, sku TEXT, name TEXT,
                description TEXT, unit TEXT, sales_price_cents INTEGER,
                vat_bp INTEGER, archived_at TEXT, updated_at TEXT,
                purchase_cost_cents INTEGER, stock_quantity_milli INTEGER
            );
            INSERT INTO catalog_items VALUES
                ('article-b','service',NULL,'Visite offerte','','h',0,0,
                '2026-10-10','2026-10-10T08:02:00Z',987654321,123456789),
                ('article-a','product','RAD-600','Radiateur','Radiateur 600 mm',
                'pce',55000,810,NULL,'2026-10-11T08:02:00Z',987654321,123456789);",
        )
        .unwrap();
    connection
}

fn resources() -> PublishedResources {
    export_resources(&fixture()).unwrap()
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn projection_is_closed_sorted_nullable_and_keeps_archived_records() {
    let connection = fixture();
    let result = export_resources(&connection).unwrap();
    assert!(connection.is_autocommit());
    assert_eq!(result.company.country, "CH");
    assert_eq!(result.company.currency, "CHF");
    assert_eq!(result.customers[0].id, "customer-a");
    assert_eq!(
        result.customers[0].email.as_deref(),
        Some(" ELODIE@example.test ")
    );
    assert_eq!(result.customers[1].email, None);
    assert!(result.customers[1].archived);
    assert_eq!(result.articles[0].id, "article-a");
    assert_eq!(result.articles[0].unit_price_cents, 55_000);
    assert_eq!(result.articles[1].sku, None);
    assert!(result.articles[1].archived);
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["company"].as_object().unwrap().len(), 8);
    assert_eq!(value["customers"][0].as_object().unwrap().len(), 5);
    assert_eq!(value["articles"][0].as_object().unwrap().len(), 10);
    let text = serde_json::to_string(&result).unwrap();
    for forbidden in ["PRIVATE", "purchase", "stock", "notes", "iban", "logoPath"] {
        assert!(!text.contains(forbidden));
    }
    assert_eq!(value["customers"][1]["email"], Value::Null);
    assert_eq!(value["articles"][1]["sku"], Value::Null);
}

#[test]
fn repeated_exports_are_deterministic_and_do_not_mutate_the_database() {
    let connection = fixture();
    let before = connection.total_changes();
    let first = export_resources(&connection).unwrap();
    let second = export_resources(&connection).unwrap();
    assert_eq!(first, second);
    assert_eq!(resource_hash(&first), resource_hash(&second));
    assert_eq!(before, connection.total_changes());
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
}

#[test]
fn the_existing_transaction_is_not_committed_or_replaced() {
    let mut connection = fixture();
    let original = export_resources(&connection).unwrap();
    let transaction = connection.transaction().unwrap();
    transaction
        .execute(
            "UPDATE clients SET name='Dans la transaction' WHERE id='customer-a'",
            [],
        )
        .unwrap();
    let projected = export_resources(&transaction).unwrap();
    assert_eq!(projected.customers[0].name, "Dans la transaction");
    assert!(!transaction.is_autocommit());
    transaction.rollback().unwrap();
    assert_eq!(export_resources(&connection).unwrap(), original);
}

#[test]
fn captured_resources_are_owned_and_do_not_follow_later_mutations() {
    let connection = fixture();
    let captured = export_resources(&connection).unwrap();
    let original_hash = resource_hash(&captured);
    connection
        .execute(
            "UPDATE catalog_items SET sales_price_cents=1 WHERE id='article-a'",
            [],
        )
        .unwrap();
    assert_eq!(captured.articles[0].unit_price_cents, 55_000);
    assert_eq!(resource_hash(&captured), original_hash);
    assert_ne!(
        resource_hash(&export_resources(&connection).unwrap()),
        original_hash
    );
}

#[test]
fn missing_settings_and_unfinished_or_other_country_configuration_fail_closed() {
    for sql in [
        "DELETE FROM settings",
        "UPDATE settings SET onboarding_completed=0",
        "UPDATE settings SET country='US'",
        "UPDATE settings SET country=NULL",
        "UPDATE settings SET currency='USD'",
        "UPDATE settings SET currency=NULL",
    ] {
        let connection = fixture();
        connection.execute(sql, []).unwrap();
        assert!(export_resources(&connection).is_err(), "{sql}");
        assert!(connection.is_autocommit(), "{sql}");
    }
}

#[test]
fn numeric_storage_types_and_bounds_are_never_coerced_or_clamped() {
    for sql in [
        "UPDATE settings SET onboarding_completed=2",
        "UPDATE settings SET vat_registered=-1",
        "UPDATE settings SET vat_registered=0.5",
        "UPDATE settings SET default_vat_bp=10001",
        "UPDATE settings SET default_vat_bp=-1",
        "UPDATE settings SET payment_terms_days=366",
        "UPDATE settings SET quote_validity_days=-1",
        "UPDATE catalog_items SET sales_price_cents=-1 WHERE id='article-a'",
        "UPDATE catalog_items SET sales_price_cents=1000000001 WHERE id='article-a'",
        "UPDATE catalog_items SET sales_price_cents=1.5 WHERE id='article-a'",
        "UPDATE catalog_items SET sales_price_cents='not-a-number' WHERE id='article-a'",
        "UPDATE catalog_items SET sales_price_cents=NULL WHERE id='article-a'",
        "UPDATE catalog_items SET vat_bp=10001 WHERE id='article-a'",
        "UPDATE catalog_items SET vat_bp=-1 WHERE id='article-a'",
        "UPDATE catalog_items SET vat_bp=0.5 WHERE id='article-a'",
    ] {
        let connection = fixture();
        connection.execute(sql, []).unwrap();
        assert!(export_resources(&connection).is_err(), "{sql}");
    }
    let connection = fixture();
    connection.execute("UPDATE catalog_items SET sales_price_cents=1000000000,vat_bp=10000 WHERE id='article-a'", []).unwrap();
    let result = export_resources(&connection).unwrap();
    assert_eq!(result.articles[0].unit_price_cents, MAX_UNIT_PRICE_CENTS);
    assert_eq!(result.articles[0].tax_rate_bp, 10_000);
}

#[test]
fn utf16_lengths_and_control_character_policy_match_the_core_contract() {
    let connection = fixture();
    connection
        .execute(
            "UPDATE clients SET name=?1 WHERE id='customer-a'",
            ["🧾".repeat(100)],
        )
        .unwrap();
    assert!(export_resources(&connection).is_ok());
    connection
        .execute(
            "UPDATE clients SET name=?1 WHERE id='customer-a'",
            ["🧾".repeat(101)],
        )
        .unwrap();
    assert!(export_resources(&connection).is_err());
    for bad in [
        "",
        "   ",
        "bad\0name",
        "bad\u{000b}name",
        "bad\u{000c}name",
        "bad\u{007f}name",
    ] {
        let mut result = resources();
        result.customers[0].name = bad.into();
        assert!(validate_resources(&result).is_err(), "{bad:?}");
    }
    let mut result = resources();
    result.customers[0].name = "Élodie\n\t🧾\u{2028}\"\\".into();
    result.articles[0].description = "Pose\nDeuxième ligne\t🧾\u{2028}".into();
    assert!(validate_resources(&result).is_ok());
    result.customers[0].name = "\u{feff}".into();
    assert!(validate_resources(&result).is_err());
    result.customers[0].name = "\u{0085}".into();
    assert!(validate_resources(&result).is_ok());
}

#[test]
fn emails_use_the_server_ascii_syntax_but_preserve_the_original_fact() {
    for accepted in [
        None,
        Some(""),
        Some(" ELODIE@example.test "),
        Some("\u{feff}elodie@example.test\u{feff}"),
        Some("a.!#$%&'*+/=?^_`{|}~-@a.example"),
        Some("a@1..a.example"),
    ] {
        let mut result = resources();
        result.customers[0].email = accepted.map(str::to_owned);
        assert!(validate_resources(&result).is_ok(), "{accepted:?}");
        let encoded = encode_sidecar(&result, "org", "snapshot", 0).unwrap();
        let value: Value = serde_json::from_slice(&encoded.bytes).unwrap();
        assert_eq!(value["resources"]["customers"][0]["email"], json!(accepted));
    }
    for refused in [
        " ",
        "a",
        "a@b",
        "a@b.c",
        "a@-b.ch",
        "a@b-.ch",
        "a@@b.ch",
        "a b@c.ch",
        "é@b.ch",
        "a@bé.ch",
        "a@b.123",
        "a\0@b.ch",
        "\u{0085}a@b.ch",
        "a@b.ch\u{0085}",
    ] {
        let mut result = resources();
        result.customers[0].email = Some(refused.into());
        assert!(validate_resources(&result).is_err(), "{refused:?}");
    }
    let connection = fixture();
    connection
        .execute(
            "UPDATE clients SET email='broken' WHERE id='customer-a'",
            [],
        )
        .unwrap();
    assert!(export_resources(&connection).is_err());
}

#[test]
fn required_timestamps_and_all_other_field_limits_are_enforced() {
    let mutations: Vec<Box<dyn Fn(&mut PublishedResources)>> = vec![
        Box::new(|r| r.company.updated_at = "".into()),
        Box::new(|r| r.company.updated_at = "x".repeat(129)),
        Box::new(|r| r.company.updated_at = "bad\0time".into()),
        Box::new(|r| r.customers[0].updated_at = " ".into()),
        Box::new(|r| r.customers[0].updated_at = "x".repeat(129)),
        Box::new(|r| r.customers[0].email = Some("x".repeat(255))),
        Box::new(|r| r.articles[0].updated_at = "".into()),
        Box::new(|r| r.articles[0].sku = Some("x".repeat(101))),
        Box::new(|r| r.articles[0].name = "x".repeat(201)),
        Box::new(|r| r.articles[0].description = "x".repeat(1001)),
        Box::new(|r| r.articles[0].unit = "x".repeat(41)),
        Box::new(|r| r.articles[0].unit = " ".into()),
        Box::new(|r| r.articles[0].kind = "stock".into()),
    ];
    for mutate in mutations {
        let mut result = resources();
        mutate(&mut result);
        assert!(validate_resources(&result).is_err());
    }
}

#[test]
fn malformed_ids_duplicate_ids_or_non_binary_order_fail_closed() {
    for id in ["", "_leading", "bad/id", "é", "a b", "a\0", "a\n"] {
        let mut result = resources();
        result.customers[0].id = id.into();
        assert!(validate_resources(&result).is_err(), "{id:?}");
    }
    let mut result = resources();
    result.customers[1].id = result.customers[0].id.clone();
    assert!(validate_resources(&result).is_err());
    let mut result = resources();
    result.articles.swap(0, 1);
    assert!(encode_sidecar(&result, "organization-demo", "snapshot-demo", 0).is_err());
    let connection = fixture();
    connection
        .execute(
            "UPDATE clients SET id='customer-Z' WHERE id='customer-b'",
            [],
        )
        .unwrap();
    let result = export_resources(&connection).unwrap();
    assert_eq!(result.customers[0].id, "customer-Z");
    assert_eq!(result.customers[1].id, "customer-a");
}

fn replace_with_many(connection: &Connection, table: &str, count: usize) {
    match table {
        "clients" => connection.execute_batch(&format!(
            "DELETE FROM clients;
            WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<{count})
            INSERT INTO clients(id,name,email,archived_at,updated_at)
            SELECT printf('customer-%05d',i),'Client',NULL,NULL,'t' FROM n;"
        )).unwrap(),
        "catalog_items" => connection.execute_batch(&format!(
            "DELETE FROM catalog_items;
            WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<{count})
            INSERT INTO catalog_items(id,kind,sku,name,description,unit,sales_price_cents,vat_bp,archived_at,updated_at)
            SELECT printf('article-%05d',i),'service',NULL,'Service','','h',100,810,NULL,'t' FROM n;"
        )).unwrap(),
        _ => panic!("closed fixture table"),
    }
}

#[test]
fn each_family_accepts_5000_records_but_never_truncates_5001() {
    for table in ["clients", "catalog_items"] {
        let connection = fixture();
        replace_with_many(&connection, table, 5000);
        let result = export_resources(&connection).unwrap();
        let actual = if table == "clients" {
            result.customers.len()
        } else {
            result.articles.len()
        };
        assert_eq!(actual, 5000);
        replace_with_many(&connection, table, 5001);
        assert!(export_resources(&connection).is_err(), "{table}");
    }
}

#[test]
fn resource_and_envelope_byte_limits_return_no_truncated_document() {
    let connection = fixture();
    replace_with_many(&connection, "catalog_items", 5000);
    connection
        .execute(
            "UPDATE catalog_items SET description=?1",
            ["x".repeat(1000)],
        )
        .unwrap();
    assert!(export_resources(&connection).is_err());
    let mut result = resources();
    result.articles = (0..5000)
        .map(|index| {
            let mut article = result.articles[0].clone();
            article.id = format!("article-{index:05}");
            article.description = "x".repeat(1000);
            article
        })
        .collect();
    assert!(validate_resources(&result).is_ok());
    assert!(encode_sidecar(&result, "organization-demo", "snapshot-demo", 0).is_err());
    let mut writer = BoundedJson {
        bytes: vec![b'x'; MAX_SIDECAR_BYTES],
    };
    assert!(writer.write_all(b"overflow").is_err());
    assert_eq!(writer.bytes.len(), MAX_SIDECAR_BYTES);
}

#[test]
fn fixed_tuple_hash_is_independent_from_json_object_key_order() {
    let result = resources();
    let expected = concat!(
        r#"[1,["CH","CHF",true,true,810,30,30,"2026-10-11T08:00:00.123Z"],"#,
        r#"[["customer-a","Élodie 🚧"," ELODIE@example.test ",false,"2026-10-11T08:01:00Z"],"#,
        r#"["customer-b","Ancien client",null,true,"2026-10-10T08:01:00Z"]],"#,
        r#"[["article-a","product","RAD-600","Radiateur","Radiateur 600 mm","pce",55000,810,false,"2026-10-11T08:02:00Z"],"#,
        r#"["article-b","service",null,"Visite offerte","","h",0,0,true,"2026-10-10T08:02:00Z"]]]"#,
    );
    assert_eq!(resource_hash(&result), sha(expected.as_bytes()));
    assert_eq!(customer_revision(&result.customers[0]), sha(
        r#"["customer","customer-a","Élodie 🚧"," ELODIE@example.test ",false,"2026-10-11T08:01:00Z"]"#.as_bytes()
    ));
    assert_eq!(article_revision(&result.articles[0]), sha(
        r#"["article","article-a","product","RAD-600","Radiateur","Radiateur 600 mm","pce",55000,810,false,"2026-10-11T08:02:00Z"]"#.as_bytes()
    ));
}

#[test]
fn unicode_and_escaped_strings_have_the_shared_json_stringify_bytes() {
    let mut result = resources();
    result.customers.truncate(1);
    result.articles.truncate(1);
    result.company.updated_at = "t".into();
    result.customers[0].name = "Élodie 🧾 \u{2028}\"\\\n".into();
    result.customers[0].email = None;
    result.customers[0].updated_at = "t".into();
    result.articles[0].description = "Pose\t\"\\\n🚧\u{2028}".into();
    result.articles[0].updated_at = "t".into();
    let customer_json = format!(
        r#"["customer","customer-a","Élodie 🧾 {}\"\\\n",null,false,"t"]"#,
        '\u{2028}',
    );
    assert_eq!(
        customer_revision(&result.customers[0]),
        sha(customer_json.as_bytes())
    );
    let article_json = format!(
        r#"["article","article-a","product","RAD-600","Radiateur","Pose\t\"\\\n🚧{}","pce",55000,810,false,"t"]"#,
        '\u{2028}',
    );
    assert_eq!(
        article_revision(&result.articles[0]),
        sha(article_json.as_bytes())
    );
    let resource_json = format!(
        r#"[1,["CH","CHF",true,true,810,30,30,"t"],[["customer-a","Élodie 🧾 {}\"\\\n",null,false,"t"]],[["article-a","product","RAD-600","Radiateur","Pose\t\"\\\n🚧{}","pce",55000,810,false,"t"]]]"#,
        '\u{2028}', '\u{2028}',
    );
    assert_eq!(resource_hash(&result), sha(resource_json.as_bytes()));
    let value: Value = serde_json::from_str(&resource_json).unwrap();
    assert_eq!(value[2][0][1], result.customers[0].name);
    assert_eq!(value[3][0][4], result.articles[0].description);
}

#[test]
fn every_updated_at_participates_in_resources_and_record_revisions() {
    let initial = resources();
    let mut changed = initial.clone();
    changed.company.updated_at.push('1');
    assert_ne!(resource_hash(&initial), resource_hash(&changed));
    let mut changed = initial.clone();
    changed.customers[0].updated_at.push('1');
    assert_ne!(resource_hash(&initial), resource_hash(&changed));
    assert_ne!(
        customer_revision(&initial.customers[0]),
        customer_revision(&changed.customers[0])
    );
    let mut changed = initial.clone();
    changed.articles[0].updated_at.push('1');
    assert_ne!(resource_hash(&initial), resource_hash(&changed));
    assert_ne!(
        article_revision(&initial.articles[0]),
        article_revision(&changed.articles[0])
    );
}

#[test]
fn null_empty_archive_and_price_are_distinct_hash_inputs() {
    let initial = resources();
    let mut changed = initial.clone();
    changed.customers[1].email = Some(String::new());
    assert_ne!(
        customer_revision(&initial.customers[1]),
        customer_revision(&changed.customers[1])
    );
    assert_ne!(resource_hash(&initial), resource_hash(&changed));
    let mut changed = initial.clone();
    changed.articles[1].sku = Some(String::new());
    assert_ne!(
        article_revision(&initial.articles[1]),
        article_revision(&changed.articles[1])
    );
    let mut changed = initial.clone();
    changed.customers[0].archived = true;
    assert_ne!(
        customer_revision(&initial.customers[0]),
        customer_revision(&changed.customers[0])
    );
    let mut changed = initial.clone();
    changed.articles[0].unit_price_cents += 1;
    assert_ne!(
        article_revision(&initial.articles[0]),
        article_revision(&changed.articles[0])
    );
}

#[test]
fn sidecar_has_exact_version_scope_counts_hashes_and_compact_bytes() {
    let result = resources();
    let encoded = encode_sidecar(&result, "organization-demo", "snapshot-demo", 7).unwrap();
    assert_eq!(encoded.customer_count, 2);
    assert_eq!(encoded.article_count, 2);
    assert_eq!(encoded.resources_hash, resource_hash(&result));
    assert_eq!(encoded.sha256, sha(&encoded.bytes));
    let value: Value = serde_json::from_slice(&encoded.bytes).unwrap();
    assert_eq!(
        value,
        json!({
            "format":"zentra-action-resources", "version":1, "schemaVersion":62,
            "organizationId":"organization-demo", "snapshotId":"snapshot-demo",
            "baseRevision":7, "resources":result, "resourcesHash":encoded.resources_hash,
        })
    );
    assert!(encoded
        .bytes
        .starts_with(br#"{"format":"zentra-action-resources","version":1,"schemaVersion":62,"#));
    let repeated = encode_sidecar(&resources(), "organization-demo", "snapshot-demo", 7).unwrap();
    assert_eq!(encoded.bytes, repeated.bytes);
    assert_eq!(encoded.sha256, repeated.sha256);
}

#[test]
fn sidecar_refuses_invalid_scope_or_non_safe_revision_and_revalidates_records() {
    let result = resources();
    for (organization, snapshot, revision) in [
        ("", "snapshot", 0),
        ("org/other", "snapshot", 0),
        ("org", "", 0),
        ("org", "snapshot with spaces", 0),
        ("org", "snapshot", -1),
        ("org", "snapshot", MAX_SAFE_INTEGER + 1),
    ] {
        assert!(encode_sidecar(&result, organization, snapshot, revision).is_err());
    }
    assert!(encode_sidecar(&result, "org", "snapshot", MAX_SAFE_INTEGER).is_ok());
    let mut changed = result;
    changed.company.currency = "USD".into();
    assert!(encode_sidecar(&changed, "org", "snapshot", 0).is_err());
}

#[test]
fn closed_serializable_types_refuse_unknown_fields_and_preserve_null_fields() {
    let value = serde_json::to_value(resources()).unwrap();
    for path in ["company", "customers", "articles"] {
        let mut changed = value.clone();
        let target = if path == "company" {
            &mut changed[path]
        } else {
            &mut changed[path][0]
        };
        target
            .as_object_mut()
            .unwrap()
            .insert("privateExtra".into(), json!("secret"));
        assert!(serde_json::from_value::<PublishedResources>(changed).is_err());
    }
    let mut changed = value.clone();
    changed
        .as_object_mut()
        .unwrap()
        .insert("notes".into(), json!("secret"));
    assert!(serde_json::from_value::<PublishedResources>(changed).is_err());
    // The transport encoder always emits nullable fields; verify explicit NULL
    // survives a round-trip without turning into an empty string.
    let decoded: PublishedResources = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.customers[1].email, None);
    assert_eq!(decoded.articles[1].sku, None);
}

#[test]
fn invalid_sqlite_required_text_is_not_defaulted() {
    for sql in [
        "UPDATE clients SET name=NULL WHERE id='customer-a'",
        "UPDATE clients SET updated_at=NULL WHERE id='customer-a'",
        "UPDATE catalog_items SET description=NULL WHERE id='article-a'",
        "UPDATE catalog_items SET unit=NULL WHERE id='article-a'",
        "UPDATE catalog_items SET kind='unexpected' WHERE id='article-a'",
    ] {
        let connection = fixture();
        connection.execute(sql, []).unwrap();
        assert!(export_resources(&connection).is_err(), "{sql}");
    }
    let connection = fixture();
    connection
        .execute(
            "UPDATE clients SET name=?1 WHERE id='customer-a'",
            params![vec![0xff_u8]],
        )
        .unwrap();
    assert!(export_resources(&connection).is_err());
}
