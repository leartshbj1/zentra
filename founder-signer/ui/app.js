/* No private key enters this renderer. Native commands own signing and DPAPI. */
const $ = (id) => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
let preview = null;
let signed = null;
let ready = false;
let busy = false;
let toastTimer;

function error(message) { $('error').textContent = String(message); $('error').hidden = false; }
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); }
function controls() {
  for (const element of document.querySelectorAll('button, input, #source')) element.disabled = busy;
  $('sign').disabled = busy || !ready || !preview;
  $('inspect').disabled = busy || !$('source').value.trim();
}
function setBusy(value) { busy = value; document.body.setAttribute('aria-busy', String(value)); controls(); }
function invalidate() { preview = null; signed = null; $('preview').hidden = true; $('result').hidden = true; $('output').value = ''; $('technical').open = false; clearError(); controls(); }
function invalidateResult() { signed = null; $('result').hidden = true; $('output').value = ''; clearError(); }
function formatDate(value) { const [y,m,d] = value.split('-'); return `${d}.${m}.${y}`; }
function planName(plan) {
  return ({'zentra-solo-monthly-49-chf':'Solo', 'zentra-start-monthly-59-chf':'Start', 'zentra-pro-monthly-89-chf':'Pro'})[plan] || 'Formule historique / propriétaire';
}
function showPreview(value) {
  preview = value;
  $('preview').hidden = false;
  const p = value.payload;
  $('installation').textContent = p.installation_id;
  $('customer').value = p.customer_name || '';
  const today = new Date().toISOString().slice(0,10);
  $('until').min = today;
  $('until').value = p.valid_until >= today ? p.valid_until : today;
  $('plan').textContent = planName(p.plan);
  $('role').textContent = `Rôle : ${{owner:'propriétaire',admin:'administrateur',accountant:'comptable',member:'membre',read_only:'lecture seule'}[p.access_role]}`;
  $('source-state').textContent = value.sourceKind === 'signed' ? 'Signature d’origine vérifiée' : value.knownDevice ? 'Présent dans votre coffre' : 'Contenu à signer';
  $('new-device-note').hidden = value.sourceKind !== 'installation' || value.knownDevice;
  controls();
}
async function readSource() { showPreview(await invoke('inspect', {source:$('source').value})); }
async function refreshStatus() {
  const status = await invoke('status');
  ready = status.keyReady;
  $('key-status').textContent = status.keyMessage;
  $('key-status').className = `key-status ${ready ? 'ready' : 'failed'}`;
  $('devices').replaceChildren();
  for (const device of status.devices) {
    const button = document.createElement('button'); button.className = 'device';
    const title = document.createElement('strong'); title.textContent = device.payload.customer_name || 'Appareil Zentra';
    const id = document.createElement('code'); id.textContent = `${device.payload.installation_id.slice(0,8)}…${device.payload.installation_id.slice(-4)}`;
    const expiry = document.createElement('small'); expiry.textContent = `Jusqu’au ${formatDate(device.payload.valid_until)}`;
    button.title = `${device.payload.installation_id}\n${device.payload.license_id}`;
    button.append(title,id,expiry);
    button.addEventListener('click', () => action(async () => {
      invalidate(); $('source').value = await invoke('load_token',{reference:device.reference}); await readSource();
    }));
    $('devices').append(button);
  }
  if (!status.devices.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Vos jetons signés apparaîtront ici pour les retrouver après fermeture.'; $('devices').append(p); }
  if (status.unreadable) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = `${status.unreadable} fichier(s) du coffre illisible(s).`; $('devices').append(p); }
  controls();
}
async function action(fn) {
  if (busy) return;
  clearError(); setBusy(true);
  try { await fn(); } catch (e) { error(e?.message || e); } finally { setBusy(false); }
}
function showSigned(value) {
  signed = value; $('result').hidden = false;
  $('output').value = value.token;
  $('binding').textContent = value.binding;
  $('license-id').textContent = value.payload.license_id;
  $('fingerprint').textContent = value.fingerprint;
  $('effective-date').textContent = `Valable jusqu’au ${formatDate(value.payload.valid_until)}`;
}
function outcome(label, message, kind) {
  $('result-badge').textContent = label; $('result-badge').className = `tag ${kind}`;
  $('result-message').textContent = message; $('result-message').className = `result-message ${kind}`;
}
async function verifyCurrent() {
  if (!signed) return;
  outcome('Vérification en cours…','Connexion au serveur Zentra…','');
  try {
    const checked = await invoke('verify_activation',{token:signed.token});
    if (checked.accepted) {
      showSigned(checked.signed);
      outcome('Activation acceptée',checked.message,'good');
      // Display the effective server-issued terms, which may differ from the requested expiry.
      $('until').value = checked.signed.payload.valid_until;
      $('customer').value = checked.signed.payload.customer_name || '';
      $('technical').open = false;
    } else {
      outcome(checked.status === 'unrecognized' ? 'Activation à autoriser' : 'Activation non confirmée',checked.message,'warning');
      $('technical').open = checked.status === 'unrecognized';
    }
  } catch (e) {
    outcome('Activation non confirmée','Le jeton est signé localement. La réponse du serveur n’a pas pu être validée.','warning');
    throw e;
  }
}

$('source').addEventListener('input',invalidate);
$('customer').addEventListener('input',invalidateResult);
$('until').addEventListener('input',invalidateResult);
$('new').addEventListener('click',() => { if(busy)return; $('source').value=''; invalidate(); $('source').focus(); });
$('reload').addEventListener('click',() => action(refreshStatus));
$('inspect').addEventListener('click',() => action(readSource));
$('import').addEventListener('click',() => $('file').click());
$('file').addEventListener('change',() => action(async () => {
  const file = $('file').files[0]; if(!file)return;
  try { if(file.size > 8192)throw new Error('Le fichier dépasse 8 Ko. Importez uniquement un jeton ou son contenu JSON.'); invalidate(); $('source').value = await file.text(); await readSource(); }
  finally { $('file').value = ''; }
}));
$('sign').addEventListener('click',() => action(async () => {
  if (!preview) return;
  if (!$('until').value || !$('until').checkValidity()) throw new Error('Choisissez une date de fin valide.');
  $('sign').textContent = 'Signature en cours…';
  try {
    const value = await invoke('sign_token',{request:{source:$('source').value,expectedPayload:preview.payload,customerName:$('customer').value,validUntil:$('until').value}});
    showSigned(value);
    outcome('Signature vérifiée','Jeton signé sur ce PC et conservé dans votre coffre Windows. L’autorisation d’activation n’a pas encore été vérifiée.','warning');
    if ($('online').checked) await verifyCurrent();
  } finally {
    $('sign').textContent = 'Signer le jeton ↗';
    if(signed) {
      $('source').value = signed.token;
      showPreview({payload:signed.payload,knownDevice:true,sourceKind:'signed'});
      await refreshStatus();
      $('result').scrollIntoView({block:'nearest',behavior:'smooth'});
    }
  }
}));
$('verify').addEventListener('click',() => action(async () => {
  await verifyCurrent();
  if(signed) { $('source').value=signed.token; showPreview({payload:signed.payload,knownDevice:true,sourceKind:'signed'}); }
  await refreshStatus();
}));
$('copy').addEventListener('click',() => action(async () => { if(!signed)return; await invoke('copy_text',{text:signed.token}); toast('Jeton copié. Collez-le dans Zentra.'); }));
$('copy-binding').addEventListener('click',() => action(async () => { if(!signed)return; await invoke('copy_text',{text:signed.binding}); toast('Empreinte d’autorisation copiée.'); }));

action(refreshStatus);
