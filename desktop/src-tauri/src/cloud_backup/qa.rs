//! Isolated acceptance fixture. No installed profile or customer document is read.
use super::*;
use base64::Engine;
use futures_util::FutureExt;
use std::collections::BTreeMap;

struct Fixture {
    project_id: String,
    files: BTreeMap<String, (String, u64)>,
    registers: BTreeMap<&'static str, Vec<Value>>,
}

fn seed(store: &LocalStore) -> AppResult<Fixture> {
    store.complete_onboarding(crate::tests::test_onboarding(), env!("CARGO_PKG_VERSION"))?;
    let project_id = Uuid::new_v4().to_string();
    store.connect()?.execute("INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,'Recette fictive sauvegarde HTTPS','2026-09-08','2026-09-08')", [&project_id])?;
    let document =
        store.add_project_document(crate::project_documents::AddProjectDocumentInput {
            project_id: project_id.clone(),
            original_name: "Plan fictif de recette.txt".into(),
            content_base64: base64::engine::general_purpose::STANDARD
                .encode(b"Document fictif pour verifier le lien au projet apres restauration."),
        })?;
    // Deterministic incompressible padding crosses the real 8 MiB boundary.
    let mut padding = vec![0u8; CHUNK_BYTES + 1024 * 1024];
    let mut random = 0x1938_ca47_2026_0908u64;
    for byte in &mut padding {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        *byte = random as u8;
    }
    fs::write(store.attachments_dir.join("qa-padding.bin"), &padding)?;
    store.connect()?.execute("UPDATE settings SET uid_number='CHE-123.456.789',vat_number='CHE-123.456.789 TVA' WHERE id=1", [])?;
    let profile = store.create_vat_profile(crate::vat_reporting::VatProfileInput {
        id: Some("qa-backup-vat".into()),
        effective_from: "2026-01-01".into(),
        effective_to: None,
        reporting_method: "effective".into(),
        form_of_reporting: "agreed".into(),
        periodicity: "quarterly".into(),
        gross_or_net: "net".into(),
        tdfn_activity_id: None,
        tdfn_rate_bp: None,
        afc_authorization_confirmed: false,
        notes: Some("Recette fictive de sauvegarde ; aucun depot aupres de l'AFC.".into()),
        close_previous_open_profile: false,
    })?;
    let vat = store.export_vat_return_xml(crate::vat_reporting::ExportVatReturnInput {
        date_from: "2026-01-01".into(),
        date_to: "2026-03-31".into(),
        submission_type: "initial".into(),
        profile_id: Some(profile.id),
        business_reference_id: "QA-BACKUP-ONLY".into(),
        file_name: Some("qa-backup-vat.xml".into()),
    })?;
    store.connect()?.execute("INSERT INTO accounting_periods(id,name,date_from,date_to,status,created_at,updated_at) VALUES(?,'Exercice fictif de recette HTTPS','2026-01-01','2026-12-31','open','2026-09-08','2026-09-08')", [Uuid::new_v4().to_string()])?;
    let review = store.prepare_fiduciary_pre_closing(crate::models::PeriodFilter {
        date_from: Some("2026-01-01".into()),
        date_to: Some("2026-12-31".into()),
    })?;
    let closing = store.export_fiduciary_closing_zip(
        review["review_id"].as_str().unwrap(),
        env!("CARGO_PKG_VERSION"),
    )?;
    let mut files = BTreeMap::new();
    for relative in [
        format!("attachments/{}", document["stored_name"].as_str().unwrap()),
        "attachments/qa-padding.bin".into(),
        format!("exports/{}", vat.file_name),
        format!("exports/{}", closing["file_name"].as_str().unwrap()),
    ] {
        let bytes = fs::read(store.data_dir.join(&relative))?;
        files.insert(
            relative,
            (format!("{:x}", Sha256::digest(&bytes)), bytes.len() as u64),
        );
    }
    let registers = [
        "attachments",
        "vat_return_exports",
        "closing_package_exports",
    ]
    .into_iter()
    .map(|table| {
        Ok((
            table,
            crate::database::query_all(&store.connect()?, &format!("SELECT * FROM {table}"), [])?,
        ))
    })
    .collect::<AppResult<_>>()?;
    Ok(Fixture {
        project_id,
        files,
        registers,
    })
}

impl Fixture {
    fn verify(&self, store: &LocalStore) -> AppResult<()> {
        for (relative, (sha256, size)) in &self.files {
            let bytes = fs::read(store.data_dir.join(relative))?;
            assert_eq!(bytes.len() as u64, *size);
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                *sha256,
                "{relative}"
            );
        }
        for (table, expected) in &self.registers {
            assert_eq!(
                crate::database::query_all(
                    &store.connect()?,
                    &format!("SELECT * FROM {table}"),
                    []
                )?,
                *expected
            );
        }
        let restored: String = store.connect()?.query_row(
            "SELECT name FROM projects WHERE id=?",
            [&self.project_id],
            |row| row.get(0),
        )?;
        assert_eq!(restored, "Recette fictive sauvegarde HTTPS");
        assert_eq!(
            self.registers["attachments"][0]["project_id"],
            self.project_id
        );
        Ok(())
    }
    fn verify_archive(&self, store: &LocalStore, pending: &Pending) -> AppResult<()> {
        let mut archive =
            zip::ZipArchive::new(File::open(store.cloud_backup_path(&pending.backup_id)?)?)?;
        let manifest: crate::models::BackupManifest =
            serde_json::from_reader(archive.by_name("manifest.json")?)?;
        assert_eq!(manifest.format_version, 2);
        assert_eq!(manifest.exports_prefix.as_deref(), Some("exports/"));
        for (relative, (sha256, size)) in &self.files {
            let mut bytes = Vec::new();
            archive.by_name(relative)?.read_to_end(&mut bytes)?;
            assert_eq!(bytes.len() as u64, *size);
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), *sha256);
        }
        assert_eq!(pending.manifest.chunks.len(), 2);
        Ok(())
    }
}

pub(super) fn verify_fixture_locally() {
    let temporary = tempfile::tempdir().unwrap();
    let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
    let fixture = seed(&source).unwrap();
    let pending = source.prepare_cloud_backup("org-qa-offline").unwrap();
    fixture.verify_archive(&source, &pending).unwrap();
    let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
    destination
        .restore_backup(
            source
                .cloud_backup_path(&pending.backup_id)
                .unwrap()
                .to_str()
                .unwrap(),
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap();
    fixture.verify(&destination).unwrap();
    assert_ne!(source.installation_id, destination.installation_id);
}

pub(super) fn run() {
    let expected_org = std::env::var("ZENTRA_BACKUP_QA_ORGANIZATION").expect("Indiquez l'entreprise fictive autorisee dans ZENTRA_BACKUP_QA_ORGANIZATION avant de lancer la recette.");
    Uuid::parse_str(
        expected_org
            .strip_prefix("org_")
            .expect("Reference d'entreprise de recette invalide"),
    )
    .unwrap();
    tauri::async_runtime::block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalStore::initialize(temporary.path().join("source")).unwrap();
        let destination = LocalStore::initialize(temporary.path().join("destination")).unwrap();
        let mut cleanup: Option<(ProjectSyncSession, String)> = None;
        let outcome = std::panic::AssertUnwindSafe(async {
            let fixture = seed(&source)?;
            crate::account_cloud::connect_live_qa_profile(&source, "backup-v2-source").await?;
            let session = backup_session(&source).await?;
            if session.organization_id != expected_org { return Err(validation("L'entreprise autorisee n'est pas l'entreprise fictive prevue. Aucun fichier n'a ete envoye.")); }
            let pending = source.prepare_cloud_backup(&session.organization_id)?;
            fixture.verify_archive(&source, &pending)?;
            println!("QA_BACKUP {} organization={} bytes={} archive_format=2 files={} registered_exports=2", pending.backup_id, session.organization_id, pending.manifest.size_bytes, fixture.files.len());
            let replay = temporary.path().join("lost-confirmation.zentra");
            fs::copy(source.cloud_backup_path(&pending.backup_id)?, &replay)?;
            cleanup = Some((session, pending.backup_id.clone()));
            let session = &cleanup.as_ref().unwrap().0;
            let initial = request(session, Method::POST, "/api/backups", &[], Some(json!({"backup_id":pending.backup_id,"manifest":pending.manifest}))).await?;
            assert!(received_chunks(&initial, &pending)?.is_empty());
            let mut archive = File::open(source.cloud_backup_path(&pending.backup_id)?)?;
            let mut first = vec![0u8; CHUNK_BYTES]; archive.read_exact(&mut first)?;
            let (status, _) = session.request(Method::PUT, "/api/backups/chunk", &[("id", &pending.backup_id), ("index", "0")], &[], Some(first), false).await?;
            assert!(status.is_success()); drop(archive);
            println!("QA_UPLOAD_PARTIAL {} confirmed_chunks=1 total_chunks=2", pending.backup_id);
            let reopened = LocalStore::initialize(source.data_dir.clone())?;
            let sent = send_backup(&reopened, &backup_session(&reopened).await?).await?;
            assert_eq!(sent, BackupSendReceipt { sent_chunks: 1, skipped_chunks: 1 });
            assert!(reopened.cloud_backup_preferences()?.pending.is_none());
            // Simulate a crash after server completion, before the local receipt.
            fs::copy(&replay, reopened.cloud_backup_path(&pending.backup_id)?)?;
            let mut prefs = reopened.cloud_backup_preferences()?; prefs.pending = Some(pending.clone()); reopened.save_cloud_backup_preferences(&prefs)?;
            let repeated = send_backup(&reopened, &backup_session(&reopened).await?).await?;
            assert_eq!(repeated, BackupSendReceipt { sent_chunks: 0, skipped_chunks: 2 });
            let complete = request(session, Method::GET, "/api/backups/item", &[("id", &pending.backup_id)], None).await?;
            assert_eq!(complete["state"], "complete");
            assert_eq!(complete["sha256"], pending.manifest.sha256);
            println!("QA_UPLOAD_COMPLETE {} resumed_chunks=1 skipped_confirmed_chunks=1 repeated_sent=0 sha256={}", pending.backup_id, pending.manifest.sha256);
            crate::account_cloud::connect_live_qa_profile(&destination, "backup-v2-destination").await?;
            let destination_session = backup_session(&destination).await?;
            if destination_session.organization_id != expected_org { return Err(validation("Les deux profils doivent appartenir a l'entreprise fictive prevue.")); }
            let destination_id = destination.installation_id.clone();
            restore(&destination, &pending.backup_id).await?;
            fixture.verify(&destination)?;
            assert_ne!(source.installation_id, destination.installation_id);
            assert_eq!(destination.installation_id, destination_id);
            assert_eq!(backup_session(&destination).await?.organization_id, expected_org);
            println!("QA_RESTORE_COMPLETE independent_installation=true archive_format=2 verified_files={} registered_exports=2 project_document_link=true immutable_registers_equal=true", fixture.files.len());
            Ok::<(), AppError>(())
        }).catch_unwind().await;
        let removal = if let Some((session, id)) = &cleanup {
            request(
                session,
                Method::DELETE,
                "/api/backups/item",
                &[("id", id)],
                None,
            )
            .await
            .map(|_| ())
        } else {
            Ok(())
        };
        let source_disconnect = crate::account_cloud::disconnect_live_qa_profile(&source).await;
        let destination_disconnect =
            crate::account_cloud::disconnect_live_qa_profile(&destination).await;
        removal.unwrap();
        source_disconnect.unwrap();
        destination_disconnect.unwrap();
        println!("QA_CLEANUP_COMPLETE archive_deleted=true sessions_revoked=true");
        outcome.unwrap().unwrap();
    });
}
