//! Commit the verified candidate through SQLite's transactional backup, with the
//! existing durable file journal and installed receipt as the recovery decision.
use super::super::installation::{self, journal};
use super::*;
use rusqlite::params;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Point {
    Prepared,
    DatabaseLocked,
    IntentSaved,
    FileInstalled(usize),
    BeforeCommit,
    DatabaseCopied(usize, bool),
    Committed,
}

pub(super) fn already_installed(store: &LocalStore, raw: &str) -> AppResult<Value> {
    let receipt: Value = serde_json::from_str(raw)?;
    let c = store.connect()?;
    let acknowledged:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_receipts WHERE generation=?1 AND transaction_id=?2 AND content_sha256=?3 AND server_revision=?4)",params![receipt["capture_generation"].as_str(),receipt["transaction_id"].as_str(),receipt["manifest_sha256"].as_str(),receipt["revision"].as_i64()],|r|r.get(0))?;
    Ok(
        json!({"state":"transaction_reconciled","already_installed":true,"installed":true,"acknowledged":acknowledged,"receipt":receipt,"replication_active":false}),
    )
}
fn finalized_binding(header: &Header) -> Binding {
    let mut binding = header.binding.clone();
    binding.revision = header.entry.revision;
    binding
}
fn finalize(revision: &Revision, header: &Header) -> AppResult<String> {
    let candidate = revision.prepared.candidate()?;
    let mut c = candidate.connect()?;
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    revision.prepared.verify_candidate(&tx)?;
    if Binding::from_connection(&tx, candidate, &header.binding.organization)?
        != finalized_binding(header)
    {
        return Err(invalid("La copie n’a pas la révision attendue."));
    }
    tx.execute(
        "INSERT INTO business_sync_installed_revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            header.binding.organization,
            header.binding.generation,
            header.entry.revision,
            header.entry.transaction_id,
            header.entry.receipt_sha256,
            std::str::from_utf8(&revision.receipt)
                .map_err(|_| invalid("Le reçu est illisible."))?,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    if let Some(ack) = &revision.acknowledgement {
        let range:(i64,i64,i64)=tx.query_row("SELECT MIN(sequence),MAX(sequence),COUNT(*) FROM business_sync_changes WHERE generation=?1 AND transaction_id=?2",params![header.binding.capture,ack.transaction_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if range
            != (
                ack.first_sequence,
                ack.last_sequence,
                ack.change_count as i64,
            )
        {
            return Err(invalid(
                "La transaction locale a changé avant sa confirmation.",
            ));
        }
        tx.execute(
            "INSERT INTO business_sync_receipts VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                header.binding.capture,
                ack.transaction_id,
                ack.last_sequence,
                revision.manifest_sha256,
                header.entry.revision,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
    }
    let seal = merge::internal_fingerprint(&tx)?;
    tx.commit()?;
    Ok(seal)
}
pub(super) fn reconcile(
    store: &LocalStore,
    folder: &Path,
    header: &Header,
    role: &str,
    ensure_current: impl Fn() -> AppResult<()>,
    checkpoint: impl Fn(Point) -> AppResult<()>,
) -> AppResult<Value> {
    ensure_current()?;
    {
        let _lock = store.lock()?;
        if let Some(raw) = installation::installed(
            store,
            &header.binding.organization,
            &header.entry.transaction_id,
        )? {
            if digest(raw.as_bytes()) != header.entry.receipt_sha256 {
                return Err(invalid("Le reçu de cette transaction a changé."));
            }
            return already_installed(store, &raw);
        }
    }
    let pending:bool=store.connect()?.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_changes c LEFT JOIN business_sync_receipts r ON r.generation=c.generation AND r.transaction_id=c.transaction_id WHERE c.generation=?1 AND c.sequence>COALESCE(r.acknowledged_through,0))",[&header.binding.capture],|r|r.get(0))?;
    if !pending {
        return installation::install(store, folder, header, ensure_current, |point| match point {
            installation::Point::Prepared => checkpoint(Point::Prepared),
            installation::Point::IntentSaved => checkpoint(Point::IntentSaved),
            installation::Point::FileInstalled(i) => checkpoint(Point::FileInstalled(i)),
            installation::Point::BeforeCommit => checkpoint(Point::BeforeCommit),
            installation::Point::Committed => checkpoint(Point::Committed),
        });
    }
    let revision = verify(store, folder, header, role, &ensure_current)?;
    let Some(plan) = &revision.files else {
        return Ok(revision.summary(header));
    };
    checkpoint(Point::Prepared)?;
    let _lock = store.lock()?;
    ensure_current()?;
    if crate::cloud_backup::is_restoring() {
        return Err(invalid("Attendez la fin de la restauration."));
    }
    if let Some(raw) = installation::installed(
        store,
        &header.binding.organization,
        &header.entry.transaction_id,
    )? {
        if raw.as_bytes() != revision.receipt {
            return Err(invalid("La transaction a déjà un autre reçu installé."));
        }
        return already_installed(store, &raw);
    }
    let seal = finalize(&revision, header)?;
    let mut candidate = revision.prepared.candidate()?.connect()?;
    let source = candidate.transaction()?;
    // Pin the finalized candidate for the entire backup. It contains only the
    // previously verified business state plus the exact receipt/acknowledgment.
    revision.prepared.verify_finalized(&source, &seal)?;
    if Binding::from_connection(
        &source,
        revision.prepared.candidate()?,
        &header.binding.organization,
    )? != finalized_binding(header)
    {
        return Err(invalid("La copie finalisée a changé."));
    }
    let outcome = atomic::replace(
        &source,
        &store.database_path,
        |reader| {
            checkpoint(Point::DatabaseLocked)?;
            ensure_current()?;
            if Binding::from_connection(reader, store, &header.binding.organization)?
                != header.binding
            {
                return Err(invalid("La révision locale a changé avant l’installation."));
            }
            revision
                .prepared
                .verify_live(reader, store, &revision.context)?;
            revision.prepared.persist_cache(store, &revision.context)?;
            let intent = journal::Journal::prepare(store, header, plan.steps.clone())?;
            checkpoint(Point::IntentSaved)?;
            intent.apply(store, plan.stage.path(), &|point| match point {
                installation::Point::FileInstalled(i) => checkpoint(Point::FileInstalled(i)),
                _ => Ok(()),
            })?;
            Ok(intent)
        },
        |intent, final_step| {
            ensure_current()?;
            if final_step {
                plan.verify_final(store)?;
                intent.verify_installed_files(store)?;
                checkpoint(Point::BeforeCommit)?;
                ensure_current()?;
            }
            Ok(())
        },
        |pages, done| {
            checkpoint(Point::DatabaseCopied(pages, done))?;
            if done {
                checkpoint(Point::Committed)?;
            }
            Ok(())
        },
    );
    let recovery = journal::recover(store);
    match (outcome, recovery) {
        (Ok(_), Ok(())) => Ok(
            json!({"state":"transaction_reconciled","transaction_id":header.entry.transaction_id,"revision":header.entry.revision,"installed":true,"acknowledged":revision.acknowledgement.is_some(),"documents_verified":true,"documents":plan.final_files.len(),"replication_active":false}),
        ),
        (Err(error), Ok(())) => Err(error),
        (_, Err(error)) => Err(error),
    }
}
