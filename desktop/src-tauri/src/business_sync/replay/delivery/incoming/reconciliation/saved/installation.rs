//! Install only the sealed replacement, preserving the current private state.
//! SQLite's exact installed receipt decides file recovery, including after exit.
use super::*;
use crate::business_sync::{
    identifier, json_image, policy,
    replay::{self, Context},
    retirement::{durable, Intent, Receipt as RetirementReceipt},
};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};

mod private;
mod snapshots;
pub(in crate::business_sync::replay::delivery::incoming::reconciliation) use super::super::install::Point;

fn readonly(path: &Path) -> AppResult<Connection> {
    if !snapshot::regular_metadata(path)?.is_file() {
        return Err(invalid("Une base sauvegardée est absente."));
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
    )?;
    connection.execute_batch("BEGIN")?;
    connection.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })?;
    Ok(connection)
}

struct Ready {
    folder: PathBuf,
    proposal: Proposal,
    mapping: String,
    plan: merge::replacements::Plan,
    model: Connection,
    receipt: String,
    header: Header,
    context: Context,
}
impl Ready {
    fn read(store: &LocalStore, frozen: &durable::Frozen) -> AppResult<Self> {
        let intent = &frozen.intent;
        if frozen.stage != durable::Stage::Retired {
            return Err(invalid(
                "Attendez la confirmation distante avant l’installation.",
            ));
        }
        RetirementReceipt::read(
            frozen
                .retirement
                .as_deref()
                .ok_or_else(|| invalid("La confirmation distante est absente."))?
                .as_bytes(),
            intent,
        )?;
        verify_frozen(store, intent)?;
        let (folder, proposal, seal) = load_proposal(store, &intent.resolution_id)?;
        if seal != intent.proposal_sha256 {
            return Err(invalid("La proposition a changé avant l’installation."));
        }
        let mapping =
            String::from_utf8(read(&artifact(&folder, "replacement.json")?, MAX_METADATA)?)
                .map_err(|_| invalid("Le plan de remplacement est illisible."))?;
        let plan: merge::replacements::Plan = serde_json::from_str(&mapping)?;
        let receipt = String::from_utf8(read(&artifact(&folder, "receipt.json")?, 16 * 1024)?)
            .map_err(|_| invalid("Le reçu enregistré est illisible."))?;
        let expected = Expected::from_authenticated_receipt(
            receipt.as_bytes(),
            ReceiptRequest {
                organization: &intent.organization_id,
                generation: &intent.generation,
                transaction_id: &intent.received_transaction_id,
                source_revision: intent.source_revision,
                receipt_sha256: &intent.receipt_sha256,
            },
        )?;
        let r = expected.receipt;
        let model = readonly(&artifact(&folder, "model.sqlite")?)?;
        let context = Context {
            fingerprint_version: r.fingerprint_version,
            organization: r.organization_id.clone(),
            generation: r.generation.clone(),
            base_revision: r.source_revision,
            source_state_sha256: r.source_state_sha256,
            target_state_sha256: r.target_state_sha256,
        };
        if replay::fingerprint(&model, "source_rows")? != context.source_state_sha256
            || replay::fingerprint(&model, "canonical_rows")? != context.target_state_sha256
            || plan.canonical_state_sha256 != context.target_state_sha256
        {
            return Err(invalid(
                "Le modèle sauvegardé ne correspond pas au reçu canonique.",
            ));
        }
        let header = Header {
            version: 1,
            binding: proposal.binding.clone(),
            entry: Entry {
                transaction_id: r.transaction_id,
                source_revision: r.source_revision,
                revision: r.revision,
                bundle_sha256: r.bundle_sha256,
                receipt_sha256: intent.receipt_sha256.clone(),
                origin_installation_id: r.origin_installation_id,
            },
        };
        Ok(Self {
            folder,
            proposal,
            mapping,
            plan,
            model,
            receipt,
            header,
            context,
        })
    }
    fn final_files(&self, store: &LocalStore) -> AppResult<()> {
        for step in &self.proposal.final_files {
            if journal::stamp(&journal::target(store, step, false)?)?.as_ref() != Some(&step.after)
            {
                return Err(invalid(
                    "Un document de la résolution a changé avant la validation.",
                ));
            }
        }
        Ok(())
    }
    fn stage(&self, store: &LocalStore) -> AppResult<crate::business_sync::workspace::Workspace> {
        let stage = crate::business_sync::workspace::Workspace::new(store, "reconciliation-files")?;
        fs::create_dir(stage.path().join("files"))?;
        for step in &self.proposal.steps {
            let source = artifact(&self.folder, &format!("blobs/{}", step.after.sha256))?;
            journal::copy_verified(
                &source,
                &stage.path().join("files").join(&step.after.sha256),
                &step.after,
            )?;
        }
        Ok(stage)
    }
    fn retain(&self, store: &LocalStore, candidate: &Connection) -> AppResult<()> {
        let mut q=candidate.prepare("SELECT table_name,before_json,after_json FROM business_sync_changes WHERE generation=?1 OR (generation=?2 AND sequence>=?3 AND sequence<=?4) ORDER BY sequence")?;
        let mut rows = q.query(params![
            self.plan.replacement_capture_generation,
            self.plan.original_capture_generation,
            self.plan.originals[0].first_sequence,
            self.plan.originals.last().unwrap().last_sequence
        ])?;
        while let Some(row) = rows.next()? {
            let table: String = row.get(0)?;
            if !retained::has_files(&table) {
                continue;
            }
            for raw in [row.get::<_, Option<String>>(1)?, row.get(2)?]
                .into_iter()
                .flatten()
            {
                let key = format!("{table}:{}", digest(raw.as_bytes()));
                let files = self
                    .proposal
                    .replacement_files
                    .get(&key)
                    .or_else(|| self.proposal.original_files.get(&key))
                    .ok_or_else(|| invalid("Une preuve documentaire de la résolution manque."))?;
                for file in files {
                    retained::retain_verified_image(
                        &store.data_dir,
                        &table,
                        &raw,
                        file,
                        &artifact(&self.folder, &format!("blobs/{}", file.sha256))?,
                    )?;
                }
            }
        }
        Ok(())
    }
}

fn finalize(copy: &LocalStore, ready: &Ready, frozen: &durable::Frozen) -> AppResult<bool> {
    let intent = &frozen.intent;
    let r: Value = serde_json::from_str(&ready.receipt)?;
    let own = r["origin_installation_id"] == intent.installation_id
        && r["capture_generation"] == intent.capture_generation;
    let confirmed = ready.proposal.preview["confirmed_transaction_id"].as_str();
    if own != (confirmed == Some(intent.received_transaction_id.as_str()))
        || (!own && confirmed.is_some())
    {
        return Err(invalid(
            "La preuve d’origine ne correspond pas à la comparaison protégée.",
        ));
    }
    let mut c = copy.connect()?;
    c.pragma_update(None, "synchronous", "FULL")?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO business_sync_installed_revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            intent.organization_id,
            intent.generation,
            intent.base_revision,
            intent.received_transaction_id,
            intent.receipt_sha256,
            ready.receipt,
            now
        ],
    )?;
    if own {
        // The fresh freeze independently recreated the original manifest and
        // chunks. The sealed review attests that exact transaction; preparation
        // below also compares every original immutable journal row to live data.
        let (first,last,count):(i64,i64,i64)=tx.query_row("SELECT MIN(sequence),MAX(sequence),COUNT(*) FROM business_sync_changes WHERE generation=?1 AND transaction_id=?2",
            params![intent.capture_generation,intent.received_transaction_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        if first < 1
            || last >= integer(&intent.first_sequence)?
            || count < 1
            || last - first + 1 != count
        {
            return Err(invalid("Le reçu d’origine ne couvre pas une opération complète antérieure aux remplacements."));
        }
        tx.execute(
            "INSERT INTO business_sync_receipts VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                intent.capture_generation,
                intent.received_transaction_id,
                last,
                r["manifest_sha256"].as_str(),
                intent.base_revision,
                now
            ],
        )?;
    }
    tx.execute(
        "INSERT INTO business_sync_resolutions VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            intent.resolution_id,
            frozen.raw_intent,
            digest(frozen.raw_intent.as_bytes()),
            frozen.retirement,
            digest(frozen.retirement.as_ref().unwrap().as_bytes()),
            ready.mapping,
            digest(ready.mapping.as_bytes()),
            now
        ],
    )?;
    tx.execute("DELETE FROM business_sync_resolution_intent WHERE id=1", [])?;
    tx.commit()?;
    Ok(own)
}

pub(in crate::business_sync::replay::delivery::incoming::reconciliation) fn installed(
    store: &LocalStore,
    c: &Connection,
    id: &str,
) -> AppResult<Option<Value>> {
    let row:Option<(String,String,String,String,String,String)>=c.query_row(
        "SELECT intent_json,intent_sha256,retirement_json,retirement_sha256,mapping_json,mapping_sha256 FROM business_sync_resolutions WHERE resolution_id=?1",
        [id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let Some((raw, sha, proof, proof_sha, mapping, mapping_sha)) = row else {
        return Ok(None);
    };
    let intent = Intent::read(raw.as_bytes())?;
    RetirementReceipt::read(proof.as_bytes(), &intent)?;
    let plan: merge::replacements::Plan = serde_json::from_str(&mapping)?;
    let binding = Binding::from_connection(c, store, &intent.organization_id)?;
    if intent.resolution_id != id
        || intent.installation_id != store.installation_id
        || sha != digest(raw.as_bytes())
        || proof_sha != digest(proof.as_bytes())
        || mapping_sha != digest(mapping.as_bytes())
        || binding.generation != intent.generation
        || binding.revision < intent.base_revision
        || plan.resolution_id != id
        || plan.replacement_capture_generation != intent.replacement_capture_generation
        || plan.base_revision != intent.base_revision
        || plan.decision_sha256 != intent.decision_sha256
    {
        return Err(invalid(
            "La résolution installée ne correspond pas à cet historique.",
        ));
    }
    let receipt:String=c.query_row("SELECT receipt_json FROM business_sync_installed_revisions WHERE organization_id=?1 AND generation=?2 AND revision=?3 AND transaction_id=?4 AND receipt_sha256=?5",
        params![intent.organization_id,intent.generation,intent.base_revision,intent.received_transaction_id,intent.receipt_sha256],|r|r.get(0))?;
    let expected = Expected::from_authenticated_receipt(
        receipt.as_bytes(),
        ReceiptRequest {
            organization: &intent.organization_id,
            generation: &intent.generation,
            transaction_id: &intent.received_transaction_id,
            source_revision: intent.source_revision,
            receipt_sha256: &intent.receipt_sha256,
        },
    )?;
    let acknowledged:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM business_sync_receipts WHERE generation=?1 AND transaction_id=?2 AND content_sha256=?3 AND server_revision=?4)",
        params![intent.capture_generation,intent.received_transaction_id,expected.receipt.manifest_sha256,intent.base_revision],|r|r.get(0))?;
    Ok(Some(
        json!({"state":"resolution_installed","resolution_id":id,"transaction_id":intent.received_transaction_id,
        "revision":intent.base_revision,"capture_generation":intent.replacement_capture_generation,
        "installed":true,"already_installed":true,"acknowledged":acknowledged,"replication_active":false}),
    ))
}

pub(in crate::business_sync::replay::delivery::incoming::reconciliation) fn install(
    store: &LocalStore,
    id: &str,
    ensure_current: impl Fn() -> AppResult<()>,
    checkpoint: impl Fn(Point) -> AppResult<()>,
) -> AppResult<Value> {
    let (frozen, source, cutoff) = {
        let _guard = store.lock()?;
        ensure_current()?;
        let c = store.connect()?;
        c.execute_batch("BEGIN")?;
        if let Some(report) = installed(store, &c, id)? {
            return Ok(report);
        }
        let frozen = durable::load(&c, store)?
            .ok_or_else(|| invalid("La résolution à installer est absente."))?;
        if frozen.intent.resolution_id != id {
            return Err(invalid("La résolution sélectionnée a changé."));
        }
        // The owned connection keeps this read transaction pinned after the
        // short working-store mutex is released for the expensive preparation.
        let cutoff = private::Cutoff::read(&c)?;
        (frozen, c, cutoff)
    };
    let ready = Ready::read(store, &frozen)?;
    let original = snapshots::Snapshot::read(store, &artifact(&ready.folder, "candidate.sqlite")?)?;
    let replacement =
        snapshots::Snapshot::read(store, &artifact(&ready.folder, "replacement.sqlite")?)?;
    private::verify_originals(
        &source,
        &original.connection,
        &replacement.connection,
        &ready,
        &frozen.intent,
    )?;
    let copy = merge::native::copy_source(store, &replacement.connection)?;
    private::refresh(&copy, &source, &frozen, &ready)?;
    let acknowledged = finalize(&copy.store, &ready, &frozen)?;
    let files = ready.stage(store)?;
    let mut candidate = copy.store.connect()?;
    let candidate = candidate.transaction()?;
    private::verify_final(&candidate, &source, &ready, &frozen, acknowledged)?;
    checkpoint(Point::Prepared)?;
    let _guard = store.lock()?;
    ensure_current()?;
    let outcome = super::super::atomic::replace(
        &candidate,
        &store.database_path,
        |reader| {
            checkpoint(Point::DatabaseLocked)?;
            ensure_current()?;
            cutoff.verify(reader)?;
            let live = durable::load(reader, store)?
                .ok_or_else(|| invalid("La résolution protégée a disparu."))?;
            if live.raw_intent != frozen.raw_intent || live.retirement != frozen.retirement {
                return Err(invalid("Les preuves de résolution ont changé."));
            }
            files::verify_prior(store, &ready.proposal.prior_files)?;
            ready.retain(store, &candidate)?;
            merge::cache::write_rows(&ready.model, store, &ready.context)?;
            let journal =
                journal::Journal::prepare(store, &ready.header, ready.proposal.steps.clone())?;
            checkpoint(Point::IntentSaved)?;
            journal.apply(store, files.path(), &|point| {
                if let super::super::super::installation::Point::FileInstalled(index) = point {
                    checkpoint(Point::FileInstalled(index))?;
                }
                Ok(())
            })?;
            Ok(journal)
        },
        |journal, last| {
            ensure_current()?;
            if last {
                ready.final_files(store)?;
                journal.verify_installed_files(store)?;
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
            json!({"state":"resolution_installed","resolution_id":id,"transaction_id":frozen.intent.received_transaction_id,
            "revision":frozen.intent.base_revision,"capture_generation":frozen.intent.replacement_capture_generation,
            "installed":true,"acknowledged":acknowledged,"documents_verified":true,"replication_active":false}),
        ),
        (Err(e), Ok(())) | (_, Err(e)) => Err(e),
    }
}
