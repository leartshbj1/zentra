//! Short UI handshake after preparation, before any working database/file write.
//! A missing, expired, denied or disconnected UI never authorizes installation.
use super::*;
use std::{sync::mpsc, time::Instant};

#[derive(Clone, Serialize)]
pub(crate) struct Request {
    pub request_id: String,
    pub selection: Selection,
}
struct Pending {
    profile: PathBuf,
    installation: String,
    sender: mpsc::Sender<bool>,
}
static PENDING: OnceLock<Mutex<BTreeMap<String, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<BTreeMap<String, Pending>> {
    PENDING.get_or_init(Mutex::default)
}
struct Registration(String);
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut requests) = pending().lock() {
            requests.remove(&self.0);
        }
    }
}
pub(crate) fn request(
    store: &LocalStore,
    selection: &Selection,
    ensure_current: impl Fn() -> AppResult<()>,
    present: impl Fn(Request) -> AppResult<()>,
    timeout: Duration,
) -> AppResult<()> {
    ensure_current()?;
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel();
    pending()
        .lock()
        .map_err(|_| invalid("Le contrôle de réception est indisponible."))?
        .insert(
            id.clone(),
            Pending {
                profile: fs::canonicalize(&store.data_dir)?,
                installation: store.installation_id.clone(),
                sender,
            },
        );
    let _registration = Registration(id.clone());
    present(Request {
        request_id: id,
        selection: selection.clone(),
    })?;
    let started = Instant::now();
    loop {
        ensure_current()?;
        let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
            return Err(AppError::BusinessInstallDeferred);
        };
        match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(true) => {
                ensure_current()?;
                return Ok(());
            }
            Ok(false) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(AppError::BusinessInstallDeferred)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}
fn respond(store: &LocalStore, id: &str, allow: bool) -> AppResult<bool> {
    let profile = fs::canonicalize(&store.data_dir)?;
    let mut requests = pending()
        .lock()
        .map_err(|_| invalid("Le contrôle de réception est indisponible."))?;
    if !requests
        .get(id)
        .is_some_and(|p| p.profile == profile && p.installation == store.installation_id)
    {
        return Ok(false);
    }
    Ok(requests
        .remove(id)
        .is_some_and(|p| p.sender.send(allow).is_ok()))
}
#[tauri::command]
pub fn respond_business_installation(
    state: State<'_, LocalStore>,
    request_id: String,
    allow: bool,
) -> Result<bool, String> {
    respond(state.inner(), &request_id, allow).map_err(command_error)
}

#[cfg(test)]
mod tests;
