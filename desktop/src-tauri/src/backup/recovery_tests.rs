use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

struct Fixture {
    store: LocalStore,
    project: String,
    document: String,
    document_name: String,
    document_bytes: Vec<u8>,
    logo: String,
    logo_name: String,
}

fn fixture(directory: &Path, name: &str) -> Fixture {
    let store = LocalStore::initialize(directory.join(name)).unwrap();
    let now = now_iso();
    store.connect().unwrap().execute(
        "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,?,?,?)",
        params![name, now, now],
    ).unwrap();
    let project = store.create_record("projects", json!({"name": format!("Projet {name}")})).unwrap();
    let project = project["id"].as_str().unwrap().to_owned();
    let document_bytes = crate::attachments::test_pdf_bytes();
    let document = store.add_project_document(crate::project_documents::AddProjectDocumentInput {
        project_id: project.clone(), original_name: "Plan client.pdf".into(),
        content_base64: STANDARD.encode(&document_bytes),
    }).unwrap();
    let logo_source = directory.join(format!("{name}.png"));
    image::DynamicImage::new_rgba8(64, 32).save_with_format(&logo_source, image::ImageFormat::Png).unwrap();
    let logo = store.stage_company_logo(logo_source.to_str().unwrap()).unwrap();
    store.connect().unwrap().execute("UPDATE settings SET logo_path=? WHERE id=1", [&logo]).unwrap();
    let logo_name = Path::new(&logo).file_name().unwrap().to_str().unwrap().to_owned();
    Fixture { store, project, document: document["id"].as_str().unwrap().into(),
        document_name: document["stored_name"].as_str().unwrap().into(), document_bytes, logo, logo_name }
}

fn assert_intact(fixture: &Fixture) {
    assert_eq!(fixture.store.read_project_document(&fixture.document).unwrap(), STANDARD.encode(&fixture.document_bytes));
    assert!(fixture.store.company_logo_preview(&fixture.logo).unwrap().starts_with("data:image/png;base64,"));
    let count: i64 = fixture.store.connect().unwrap().query_row(
        "SELECT COUNT(*) FROM projects WHERE id=?", [&fixture.project], |row| row.get(0),
    ).unwrap();
    assert_eq!(count, 1);
    validate_database(&fixture.store.database_path).unwrap();
}

fn rewrite_archive(source: &Path, target: &Path, entry_name: &str, replacement: Option<&[u8]>) {
    let mut original = ZipArchive::new(File::open(source).unwrap()).unwrap();
    let mut archive = ZipWriter::new(File::create(target).unwrap());
    for index in 0..original.len() {
        let mut entry = original.by_index(index).unwrap();
        if entry.name() == entry_name {
            if let Some(bytes) = replacement {
                archive.start_file(entry.name(), SimpleFileOptions::default()).unwrap();
                archive.write_all(bytes).unwrap();
            }
        } else {
            archive.start_file(entry.name(), SimpleFileOptions::default()).unwrap();
            io::copy(&mut entry, &mut archive).unwrap();
        }
    }
    archive.finish().unwrap();
}

#[test]
fn full_backup_recovers_project_document_and_logo_without_the_source_profile() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture(temp.path(), "original");
    let archive = source.store.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
    let portable_archive = temp.path().join("portable.zentra");
    fs::copy(&archive, &portable_archive).unwrap();
    let original_logo = fs::read(&source.logo).unwrap();
    fs::rename(&source.store.data_dir, temp.path().join("source-inaccessible")).unwrap();
    assert!(!Path::new(&source.logo).exists());
    let target = LocalStore::initialize(temp.path().join("other-installation")).unwrap();
    target.restore_backup(portable_archive.to_str().unwrap(), env!("CARGO_PKG_VERSION")).unwrap();
    assert_ne!(source.store.installation_id, target.installation_id);
    assert_eq!(target.read_project_document(&source.document).unwrap(), STANDARD.encode(&source.document_bytes));
    for logo_path in [source.logo.clone(), format!("C:\\Ancien PC\\attachments\\branding\\{}", source.logo_name), format!("/Users/ancien/attachments/branding/{}", source.logo_name)] {
        assert_eq!(target.company_logo_preview(&logo_path).unwrap(), format!("data:image/png;base64,{}", STANDARD.encode(&original_logo)));
        assert!(crate::branding::load_pdf_logo_with_fallback(&logo_path, &target.attachments_dir.join("branding")).is_some());
    }
    validate_database(&target.database_path).unwrap();
}

#[test]
fn incomplete_or_modified_archives_never_replace_current_documents_or_logo() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture(temp.path(), "original");
    let target = fixture(temp.path(), "current");
    let archive = source.store.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
    let doc_entry = format!("attachments/{}", source.document_name);
    let logo_entry = format!("attachments/branding/{}", source.logo_name);
    let mut changed_pdf = source.document_bytes.clone();
    changed_pdf[0] ^= 1; // Same size, valid ZIP CRC: only the content hash detects it.
    let mut changed_logo = fs::read(&source.logo).unwrap();
    changed_logo[0] ^= 1;
    for (index, (entry, replacement)) in [
        (doc_entry.as_str(), None),
        (doc_entry.as_str(), Some(changed_pdf.as_slice())),
        (doc_entry.as_str(), Some(b"short".as_slice())),
        (logo_entry.as_str(), None),
        (logo_entry.as_str(), Some(changed_logo.as_slice())),
    ].into_iter().enumerate() {
        let broken = temp.path().join(format!("incomplete-{index}.zentra"));
        rewrite_archive(Path::new(&archive), &broken, entry, replacement);
        let error = target.store.restore_backup(broken.to_str().unwrap(), env!("CARGO_PKG_VERSION")).unwrap_err();
        assert!(error.to_string().contains("document ou un logo"), "{error}");
        assert_intact(&target);
        assert_eq!(fs::read_dir(&target.store.backups_dir).unwrap().count(), 0);
    }
}

#[test]
fn failed_complete_backup_preserves_last_success_and_leaves_no_partial_file() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture(temp.path(), "original");
    let good = source.store.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
    let status = source.store.backup_status();
    let good_bytes = fs::read(&good).unwrap();
    fs::remove_file(source.store.attachments_dir.join(&source.document_name)).unwrap();
    let invalid = temp.path().join("incomplete.zentra");
    assert!(source.store.create_backup(Some(invalid.to_string_lossy().into()), env!("CARGO_PKG_VERSION")).is_err());
    assert!(!invalid.exists());
    assert_eq!(source.store.backup_status(), status);
    assert_eq!(fs::read(good).unwrap(), good_bytes);
    assert!(!fs::read_dir(temp.path()).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".zentra-backup-")));
}

#[test]
fn finalization_failure_recovers_original_project_documents_and_branding() {
    let temp = tempfile::tempdir().unwrap();
    let source = fixture(temp.path(), "original");
    let target = fixture(temp.path(), "current");
    let archive = source.store.create_backup(None, env!("CARGO_PKG_VERSION")).unwrap();
    let error = target.store.restore_backup_finalized(&archive, env!("CARGO_PKG_VERSION"), ARCHIVE_EXTRACTION_LIMITS, true, || {
        assert_eq!(target.store.read_project_document(&source.document).unwrap(), STANDARD.encode(&source.document_bytes));
        Err(AppError::Validation("échec final simulé".into()))
    }).unwrap_err();
    assert!(error.to_string().contains("données précédentes ont été rétablies"));
    assert_intact(&target);
    assert!(target.store.read_project_document(&source.document).is_err());
    assert_eq!(fs::read_dir(&target.store.backups_dir).unwrap().count(), 1);
}

#[test]
fn corrupt_or_truncated_zip_leaves_existing_company_usable() {
    let temp = tempfile::tempdir().unwrap();
    let target = fixture(temp.path(), "current");
    let archive = temp.path().join("interrupted.zentra");
    fs::write(&archive, b"PK\x03\x04incomplete").unwrap();
    assert!(target.store.restore_backup(archive.to_str().unwrap(), env!("CARGO_PKG_VERSION")).is_err());
    assert_intact(&target);
}
