//! Number ranges have their own scheduler: a failed project upload must never
//! prevent replenishing numbers needed for an offline document or journal.
use super::*;
use crate::models::ManualJournalInput;
use crate::{
    account_cloud::{project_sync_session, ProjectSyncSession},
    business_sync::{cycle, snapshot},
    error::command_error,
};
use chrono::Datelike;
use serde_json::{json, Value};
use std::{fs, future::Future, sync::Arc};
use tauri::State;

trait Transport {
    fn organization(&self) -> &str;
    fn role(&self) -> &str;
    fn current(&self, store: &LocalStore) -> AppResult<()>;
    fn reserve(
        &self,
        request: &ReservationRequest,
    ) -> impl Future<Output = AppResult<Vec<u8>>> + Send;
}
impl Transport for ProjectSyncSession {
    fn organization(&self) -> &str {
        &self.organization_id
    }
    fn role(&self) -> &str {
        &self.role
    }
    fn current(&self, store: &LocalStore) -> AppResult<()> {
        self.ensure_current_for(store)
    }
    async fn reserve(&self, request: &ReservationRequest) -> AppResult<Vec<u8>> {
        let (_, bytes) = self
            .request(
                reqwest::Method::POST,
                "/api/sync/numbers",
                &[],
                &[("Content-Type", "application/json".into())],
                Some(serde_json::to_vec(request)?),
                false,
            )
            .await?;
        Ok(bytes)
    }
}
struct Bound<T> {
    transport: T,
    run: Arc<cycle::Run>,
}
impl<T: Transport + Sync> Transport for Bound<T> {
    fn organization(&self) -> &str {
        self.transport.organization()
    }
    fn role(&self) -> &str {
        self.transport.role()
    }
    fn current(&self, store: &LocalStore) -> AppResult<()> {
        self.run.ensure_running()?;
        self.transport.current(store)
    }
    async fn reserve(&self, request: &ReservationRequest) -> AppResult<Vec<u8>> {
        self.transport.reserve(request).await
    }
}
fn check(store: &LocalStore, t: &impl Transport) -> AppResult<()> {
    if crate::cloud_backup::is_restoring() {
        return Err(invalid(
            "Attendez la fin de la restauration avant de préparer les numéros.",
        ));
    }
    t.current(store)?;
    bound_to(&store.connect()?, t.organization())
}
fn can_reserve(t: &impl Transport) -> AppResult<()> {
    if !matches!(t.role(), "owner" | "admin" | "member" | "accountant") {
        return Err(invalid("Ce compte ne peut pas réserver de numéros."));
    }
    Ok(())
}
async fn receive(
    store: &LocalStore,
    t: &impl Transport,
    request: &ReservationRequest,
) -> AppResult<()> {
    check(store, t)?;
    let response = t.reserve(request).await;
    // Check the session even when HTTP failed. A different account must never
    // inherit a delayed range, nor start the next request in this pass.
    check(store, t)?;
    let bytes = response?;
    if bytes.len() > 16 * 1024 {
        return Err(invalid("La réponse de numérotation est trop volumineuse."));
    }
    let response: ReservationResponse = serde_json::from_slice(&bytes)?;
    adopt_checked(store, t.organization(), request, &response, || {
        check(store, t)
    })
}

// This cursor only chooses which series is visited first. It is not a number
// reservation or a receipt, and is intentionally excluded from backups. A torn
// cursor resets iteration; the durable requests/ranges remain in SQLite.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    organization: String,
    installation: String,
    year: i64,
    prefix: String,
}
fn cursor_path(store: &LocalStore) -> AppResult<std::path::PathBuf> {
    if !snapshot::regular_metadata(&store.data_dir)?.is_dir() {
        return Err(invalid("Le dossier de numérotation est invalide."));
    }
    let path = store.data_dir.join("numbering-prefetch.json");
    if path.try_exists()? {
        let meta = snapshot::regular_metadata(&path)?;
        if !meta.is_file() || meta.len() > 8192 {
            return Err(invalid("Le suivi de numérotation est invalide."));
        }
    }
    Ok(path)
}
fn order(
    store: &LocalStore,
    org: &str,
    series: NumberSeries,
    year: i64,
) -> AppResult<Vec<((i64, String), i64)>> {
    let mut ordered: Vec<_> = series.into_iter().collect();
    ordered.sort_by_key(|((y, prefix), _)| ((y - year).abs(), *y, prefix.clone()));
    let cursor = fs::read(cursor_path(store)?)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cursor>(&bytes).ok());
    if let Some(cursor) =
        cursor.filter(|c| c.organization == org && c.installation == store.installation_id)
    {
        if let Some(index) = ordered
            .iter()
            .position(|((y, p), _)| *y == cursor.year && *p == cursor.prefix)
        {
            let shift = (index + 1) % ordered.len();
            ordered.rotate_left(shift);
        }
    }
    Ok(ordered)
}
fn advance_cursor(
    store: &LocalStore,
    organization: &str,
    year: i64,
    prefix: &str,
) -> AppResult<()> {
    fs::write(
        cursor_path(store)?,
        serde_json::to_vec(&Cursor {
            organization: organization.into(),
            installation: store.installation_id.clone(),
            year,
            prefix: prefix.into(),
        })?,
    )?;
    Ok(())
}
async fn pass(
    store: &LocalStore,
    t: &impl Transport,
    current_year: i64,
    limit: usize,
) -> AppResult<Value> {
    if !(1..=8).contains(&limit) {
        return Err(invalid("Le budget de numérotation est invalide."));
    }
    let Some((organization, series)) = active_series(store, current_year)? else {
        return Ok(json!({"state":"local"}));
    };
    if organization != t.organization() {
        return Err(invalid(
            "La numérotation appartient à une autre entreprise.",
        ));
    }
    check(store, t)?;
    if t.role() == "read_only" {
        return Ok(json!({"state":"read_only"}));
    }
    can_reserve(t)?;
    let ordered = order(store, &organization, series, current_year)?;
    let total = ordered.len();
    let mut attempts = 0;
    let mut confirmed = 0;
    let mut visited = 0;
    let mut issues = Vec::new();
    for ((year, prefix), minimum) in ordered {
        check(store, t)?;
        visited += 1;
        let request = prepare(store, &organization, &prefix, year, minimum);
        if matches!(request, Ok(None)) {
            continue;
        }
        attempts += 1;
        advance_cursor(store, &organization, year, &prefix)?;
        let result = match request {
            Ok(Some(request)) => receive(store, t, &request).await,
            Err(error) => Err(error),
            Ok(None) => unreachable!(),
        };
        check(store, t)?;
        match result {
            Ok(()) => confirmed += 1,
            Err(error) => {
                issues.push(json!({"prefix":prefix,"year":year,"message":error.to_string()}))
            }
        }
        if attempts == limit {
            break;
        }
    }
    Ok(
        json!({"state":if !issues.is_empty(){"attention"} else if visited<total {"preparing"} else {"ready"},
        "organization_id":organization,"attempts":attempts,"confirmed":confirmed,"has_more":visited<total,"issues":issues}),
    )
}

// Only the atomic, request-idempotent manual journal command is retried here.
// Cached ranges and an already committed request require no network access.
async fn post_manual_with<T, F, Fut>(
    store: LocalStore,
    input: ManualJournalInput,
    request_id: String,
    authorize: fn(&LocalStore) -> AppResult<()>,
    connect: F,
) -> AppResult<Value>
where
    T: Transport + Send + Sync + 'static,
    F: FnOnce(LocalStore) -> Fut,
    Fut: Future<Output = AppResult<T>>,
{
    let first_store = store.clone();
    let first_input = input.clone();
    let first_id = request_id.clone();
    let first = tauri::async_runtime::spawn_blocking(move || {
        let _lock = first_store.lock()?;
        authorize(&first_store)?;
        first_store.post_manual_journal_entry_with_request_id(first_input, &first_id)
    })
    .await
    .map_err(|_| invalid("L’écriture comptable a été interrompue. Reprenez la même demande."))?;
    let (organization, prefix, year, minimum) = match first {
        Err(AppError::NumberRangeRequired {
            organization,
            prefix,
            year,
            minimum,
        }) => (organization, prefix, year, minimum),
        result => return result,
    };
    let run = cycle::acquire(&store)?;
    let t = Bound {
        transport: connect(store.clone()).await?,
        run,
    };
    if t.organization() != organization {
        return Err(invalid(
            "L’entreprise a changé. Vérifiez le dossier avant de reprendre l’écriture.",
        ));
    }
    check(&store, &t)?;
    can_reserve(&t)?;
    if let Some(request) = prepare(&store, &organization, &prefix, year, minimum)? {
        receive(&store, &t, &request).await?;
    }
    // The worker owns the transport and its lease until its transaction ends,
    // even if the UI closes while it runs. Reuse the original request UUID.
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = store.lock()?;
        check(&store, &t)?;
        authorize(&store)?;
        store.post_manual_journal_entry_with_request_id(input, &request_id)
    })
    .await
    .map_err(|_| invalid("L’écriture comptable a été interrompue. Reprenez la même demande."))?
}

pub(crate) async fn post_manual(
    store: LocalStore,
    input: ManualJournalInput,
    request_id: String,
) -> AppResult<Value> {
    post_manual_with(store, input, request_id, LocalStore::require_write_access, |store| async move {
        project_sync_session(&store).await?.ok_or_else(|| invalid("Reconnectez Zentra pour préparer les numéros de cette année. Votre saisie est conservée."))
    }).await
}

#[tauri::command]
pub async fn replenish_document_numbers(state: State<'_, LocalStore>) -> Result<Value, String> {
    let store = state.inner();
    let year = i64::from(chrono::Local::now().year());
    if active_series(store, year).map_err(command_error)?.is_none() {
        return Ok(json!({"state":"local"}));
    }
    let Some(run) = cycle::try_acquire(store).map_err(command_error)? else {
        return Ok(json!({"state":"busy"}));
    };
    let Some(session) = project_sync_session(store).await.map_err(command_error)? else {
        return Ok(json!({"state":"waiting_for_connection"}));
    };
    pass(
        store,
        &Bound {
            transport: session,
            run,
        },
        year,
        8,
    )
    .await
    .map_err(command_error)
}

#[cfg(test)]
mod tests;
