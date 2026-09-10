use super::*;

fn fixture() -> (tempfile::TempDir, LocalStore, String, String) {
    let (directory, store, _) = crate::business_sync::replay::tests::setup_with(|s| {
        s.connect().unwrap().execute("UPDATE settings SET extra_settings_json=json_set(extra_settings_json,'$.work.roundingMinutes',15,'$.work.breakMinutes',10) WHERE id=1", []).unwrap();
    });
    let project = store
        .create_record("projects", json!({"name":"Projet d’origine"}))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    start(&store, &project, "2026-09-10T08:00:00Z");
    let employee = store
        .create_record("employees", json!({"name":"Camille Exemple"}))
        .unwrap();
    let task = store
        .save_project_task(
            serde_json::from_value(json!({"project_id":project,"title":"Relevé sur place"}))
                .unwrap(),
        )
        .unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE active_timers SET employee_id=?1,task_id=?2 WHERE id=1",
            params![employee["id"].as_str(), task["id"].as_str()],
        )
        .unwrap();
    let sha = digest(&timer(&store.connect().unwrap()).unwrap().unwrap()).unwrap();
    (directory, store, project, sha)
}
fn start(store: &LocalStore, project: &str, date: &str) {
    store.connect().unwrap().execute("INSERT INTO active_timers(id,project_id,started_at,note,billable,billing_rate_cents,cost_rate_cents) VALUES(1,?1,?2,?3,0,9700,4300)",params![project,date,"Intervention\nConditions conservées 😀"]).unwrap();
}
fn ended() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-09-10T08:37:10Z")
        .unwrap()
        .with_timezone(&Utc)
}
fn target(project: &str) -> Assignment {
    Assignment {
        project_id: project.into(),
        task_id: None,
        employee_id: None,
    }
}

#[test]
fn parked_timer_preserves_duration_rules_and_original_fields_without_shared_writes() {
    let (_dir, store, project, sha) = fixture();
    let before =
        crate::business_sync::replay::state_fingerprint(&store.connect().unwrap()).unwrap();
    let id = Uuid::new_v4().to_string();
    assert!(park_at(&store, &id, &"f".repeat(64), ended()).is_err());
    assert!(park_at(
        &store,
        &id,
        &sha,
        DateTime::parse_from_rfc3339("2026-09-10T07:59:59Z")
            .unwrap()
            .with_timezone(&Utc)
    )
    .is_err());
    park_at(&store, &id, &sha, ended()).unwrap();
    assert!(timer(&store.connect().unwrap()).unwrap().is_none());
    assert_eq!(
        crate::business_sync::replay::state_fingerprint(&store.connect().unwrap()).unwrap(),
        before
    );
    let saved = retained(&store.connect().unwrap(), &id).unwrap().unwrap();
    assert_eq!(saved.snapshot.elapsed_seconds, 2230);
    assert_eq!(
        (saved.snapshot.minutes, saved.snapshot.break_minutes),
        (30, 10)
    );
    assert_eq!(saved.snapshot.timer.billable, 0);
    assert_eq!(saved.snapshot.timer.billing_rate_cents, 9700);
    assert_eq!(saved.snapshot.timer.cost_rate_cents, 4300);
    assert_eq!(
        saved.snapshot.timer.note.as_deref(),
        Some("Intervention\nConditions conservées 😀")
    );
    assert_eq!(saved.snapshot.project_name, "Projet d’origine");
    assert_eq!(
        saved.snapshot.employee_name.as_deref(),
        Some("Camille Exemple")
    );
    assert_eq!(
        saved.snapshot.task_title.as_deref(),
        Some("Relevé sur place")
    );
    assert!(saved.snapshot.timer.employee_id.is_some());
    assert!(saved.snapshot.timer.task_id.is_some());
    start(&store, &project, "2026-09-10T10:00:00Z");
    assert_eq!(
        park_at(&store, &id, &sha, ended()).unwrap()["already_preserved"],
        true
    );
    assert_eq!(
        timer(&store.connect().unwrap())
            .unwrap()
            .unwrap()
            .started_at,
        "2026-09-10T10:00:00Z"
    );
    assert!(park_at(&store, &Uuid::new_v4().to_string(), &sha, ended()).is_err());
    let restarted = LocalStore::initialize(store.data_dir.clone()).unwrap();
    assert_eq!(
        state(&restarted).unwrap()["pending"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn parking_and_assignment_are_atomic_idempotent_and_keep_original_evidence() {
    let (_dir, store, old, sha) = fixture();
    let id = Uuid::new_v4().to_string();
    let c = store.connect().unwrap();
    c.execute_batch("CREATE TRIGGER fail_timer_stop BEFORE DELETE ON active_timers BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;").unwrap();
    assert!(park_at(&store, &id, &sha, ended()).is_err());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM timer_recoveries", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(timer(&c).unwrap().is_some());
    c.execute_batch("DROP TRIGGER fail_timer_stop").unwrap();
    park_at(&store, &id, &sha, ended()).unwrap();
    let evidence: String = c
        .query_row(
            "SELECT snapshot_json FROM timer_recoveries WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(c
        .execute("DELETE FROM timer_recoveries WHERE id=?1", [&id])
        .is_err());
    assert!(c
        .execute(
            "UPDATE timer_recoveries SET snapshot_json='{}' WHERE id=?1",
            [&id]
        )
        .is_err());
    c.execute("DELETE FROM projects WHERE id=?1", [&old])
        .unwrap();
    assert!(assign(&store, &id, target(&old)).is_err());
    let project = store
        .create_record("projects", json!({"name":"Projet retenu"}))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    c.execute(
        "UPDATE projects SET status='cloture' WHERE id=?1",
        [&project],
    )
    .unwrap();
    assert!(assign(&store, &id, target(&project)).is_err());
    c.execute(
        "UPDATE projects SET status='planifie' WHERE id=?1",
        [&project],
    )
    .unwrap();
    c.execute_batch("CREATE TRIGGER fail_timer_assignment BEFORE UPDATE ON timer_recoveries BEGIN SELECT RAISE(ABORT,'simulated local failure'); END;").unwrap();
    assert!(assign(&store, &id, target(&project)).is_err());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM time_entries", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    c.execute_batch("DROP TRIGGER fail_timer_assignment")
        .unwrap();
    let invalid = Assignment {
        project_id: project.clone(),
        task_id: Some("missing-task".into()),
        employee_id: None,
    };
    assert!(assign(&store, &id, invalid).is_err());
    let result = assign(&store, &id, target(&project)).unwrap();
    let retry = assign(&store, &id, target(&project)).unwrap();
    assert_eq!(retry["entry_id"], result["entry_id"]);
    assert_eq!(retry["already_saved"], true);
    assert!(assign(&store, &id, target(&old)).is_err());
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM time_entries", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let values: (i64,i64,i64,i64,i64,String) = c.query_row("SELECT minutes,break_minutes,billable,billing_rate_cents,cost_rate_cents,ended_at FROM time_entries",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).unwrap();
    assert_eq!(values, (30, 10, 0, 9700, 4300, ended().to_rfc3339()));
    assert_eq!(
        c.query_row(
            "SELECT snapshot_json FROM timer_recoveries WHERE id=?1",
            [&id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        evidence
    );
    crate::audit::verify_audit_chain(&c).unwrap();
    assert!(
        crate::business_sync::outgoing::prepare_next(&store, "org-replay", "owner")
            .unwrap()
            .is_some()
    );
}

#[test]
fn pending_pointage_survives_complete_backup_and_detached_restore() {
    let (dir, store, _old, sha) = fixture();
    let id = Uuid::new_v4().to_string();
    park_at(&store, &id, &sha, ended()).unwrap();
    let before = state(&store).unwrap()["pending"].clone();
    let archive = dir.path().join("pointage.zentra");
    store
        .create_backup_at(&archive, env!("CARGO_PKG_VERSION"))
        .unwrap();
    let restored = LocalStore::initialize(dir.path().join("restored")).unwrap();
    restored
        .restore_backup(archive.to_str().unwrap(), env!("CARGO_PKG_VERSION"))
        .unwrap();
    assert_eq!(state(&restored).unwrap()["pending"], before);
    assert_ne!(restored.installation_id, store.installation_id);
}

#[test]
fn frozen_resolution_prevents_new_timers_but_preserves_an_existing_timer() {
    let mut f = crate::business_sync::resolution_tests::setup();
    let project = f
        .store
        .create_record("projects", json!({"name":"Avant réservation"}))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    start(&f.store, &project, "2026-09-10T08:00:00Z");
    let sha = digest(&timer(&f.store.connect().unwrap()).unwrap().unwrap()).unwrap();
    let last: i64 = f
        .store
        .connect()
        .unwrap()
        .query_row("SELECT MAX(sequence) FROM business_sync_changes", [], |r| {
            r.get(0)
        })
        .unwrap();
    f.intent["last_sequence"] = json!(last.to_string());
    crate::business_sync::resolution_tests::freeze(&f);
    let before =
        crate::business_sync::replay::state_fingerprint(&f.store.connect().unwrap()).unwrap();
    let id = Uuid::new_v4().to_string();
    park_at(&f.store, &id, &sha, ended()).unwrap();
    assert!(assign(&f.store, &id, target(&project)).is_err());
    let c = f.store.connect().unwrap();
    assert!(c.execute("INSERT INTO active_timers(id,project_id,started_at) VALUES(1,?1,'2026-09-10T10:00:00Z')",[&project]).is_err());
    assert_eq!(
        crate::business_sync::replay::state_fingerprint(&c).unwrap(),
        before
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM business_sync_resolution_intent",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
