import { getAppLanguage, t, type AppLanguage } from './language';
import { errorMessage } from './utils';
import { localValidationDetails } from './localValidation';
import { isDocumentCreationUnconfirmedError } from './documentCreationRequest';
import { interfaceKeys } from 'virtual:zentra-language-keys';

export type UserErrorKind = 'network' | 'session' | 'permission' | 'member' | 'workspace' | 'conflict' | 'validation' | 'file' | 'unknown';
export type UserErrorOperation = 'read' | 'mutation';
type Copy = { title: string; message: string; action: string };
type ErrorCopy = Record<UserErrorKind, Copy> & { unknownRead: Copy; workspaceRead: Copy; documentCreationUnknown: Copy; uncertain: string; reload: string; reconnect: string; review: string; details: string; incident: string; copy: string; copied: string; copyFailed: string };

// Kept together so the recovery wording is available even when a language asset
// cannot be loaded. Raw native messages remain untouched for business guards.
const copy: Record<AppLanguage, ErrorCopy> = {
  fr: {
    documentCreationUnknown: { title: 'Vérifions la création', message: 'Le document a peut-être déjà été enregistré. Votre saisie est conservée.', action: 'Utilisez « Vérifier cette création » avant tout nouvel envoi.' },
    network: { title: 'Connexion indisponible', message: 'Zentra n’a pas pu joindre le service.', action: 'Vérifiez votre connexion Internet.' },
    session: { title: 'Connexion au compte à renouveler', message: 'Votre session n’est plus disponible.', action: 'Reconnectez ce poste depuis Compte et équipe.' },
    permission: { title: 'Accès à vérifier', message: 'Votre accès ne permet pas cette action.', action: 'Vérifiez vos droits d’accès avec la personne qui gère l’entreprise.' },
    member: { title: 'Compte ouvert à vérifier', message: 'Le compte utilisé pour cette action n’est plus disponible sur cet appareil.', action: 'Ouvrez le bon compte, puis rouvrez cette action. Vérifiez ce qui est déjà enregistré avant de la recommencer.' },
    workspace: { title: 'Entreprise ouverte à vérifier', message: 'La demande ne correspond plus au compte ou à l’entreprise ouverte.', action: 'Rouvrez cette action dans la bonne entreprise. Vérifiez ce qui est déjà enregistré avant de la recommencer.' },
    workspaceRead: { title: 'Entreprise ouverte à vérifier', message: 'Cette lecture ne concerne plus le compte ou l’entreprise ouverte.', action: 'Vérifiez l’entreprise ouverte, puis actualisez l’affichage ou rouvrez la réception.' },
    conflict: { title: 'Enregistrement à vérifier', message: 'Les données ont changé ou sont utilisées ailleurs.', action: 'Consultez la version enregistrée avant de choisir les modifications à conserver.' },
    validation: { title: 'Informations à corriger', message: 'Certaines informations ne sont pas acceptées.', action: 'Vérifiez les champs indiqués, les dates et les montants.' },
    file: { title: 'Fichier à vérifier', message: 'Le fichier n’a pas pu être lu ou créé.', action: 'Vérifiez son format et l’accès au dossier, puis choisissez le fichier ou le dossier à nouveau.' },
    unknown: { title: 'Action à vérifier', message: 'Le résultat de cette action n’a pas pu être confirmé.', action: 'Vérifiez le résultat. Si le problème persiste, communiquez le code d’incident au support.' },
    unknownRead: { title: 'Lecture indisponible', message: 'Les informations n’ont pas pu être chargées.', action: 'Réessayez le chargement. Si le problème persiste, communiquez le code d’incident au support.' },
    uncertain: 'Avant un nouvel enregistrement, vérifiez si l’action apparaît déjà dans Zentra.',
    reload: 'Actualiser l’affichage', reconnect: 'Ouvrir la connexion', review: 'Vérifier les informations', details: 'Détails techniques', incident: 'Code d’incident', copy: 'Copier le code', copied: 'Code copié', copyFailed: 'La copie n’est pas disponible. Sélectionnez le code pour le copier.',
  },
  de: {
    documentCreationUnknown: { title: 'Erstellung prüfen', message: 'Das Dokument wurde möglicherweise bereits gespeichert. Ihre Eingaben bleiben erhalten.', action: 'Verwenden Sie vor einem erneuten Senden « Diese Erstellung prüfen ».' },
    network: { title: 'Verbindung nicht verfügbar', message: 'Zentra konnte den Dienst nicht erreichen.', action: 'Prüfen Sie Ihre Internetverbindung.' },
    session: { title: 'Erneut am Konto anmelden', message: 'Ihre Sitzung ist nicht mehr verfügbar.', action: 'Verbinden Sie dieses Gerät unter Konto und Team erneut.' },
    permission: { title: 'Zugriff prüfen', message: 'Ihr Zugriff erlaubt diese Aktion nicht.', action: 'Prüfen Sie Ihre Zugriffsrechte mit der Person, die das Unternehmen verwaltet.' },
    member: { title: 'Geöffnetes Konto prüfen', message: 'Das Konto dieser Aktion ist auf diesem Gerät nicht mehr verfügbar.', action: 'Öffnen Sie das richtige Konto und danach diese Aktion. Prüfen Sie vor einer Wiederholung, was bereits gespeichert wurde.' },
    workspace: { title: 'Geöffnetes Unternehmen prüfen', message: 'Diese Anfrage gehört nicht mehr zum geöffneten Konto oder Unternehmen.', action: 'Öffnen Sie diese Aktion im richtigen Unternehmen. Prüfen Sie vor einer Wiederholung, was bereits gespeichert wurde.' },
    workspaceRead: { title: 'Geöffnetes Unternehmen prüfen', message: 'Diese Abfrage betrifft nicht mehr das geöffnete Konto oder Unternehmen.', action: 'Prüfen Sie das geöffnete Unternehmen. Aktualisieren Sie dann die Anzeige oder öffnen Sie den Eingang erneut.' },
    conflict: { title: 'Speicherung prüfen', message: 'Die Daten wurden geändert oder werden anderweitig verwendet.', action: 'Prüfen Sie die gespeicherte Version und wählen Sie die Änderungen, die Sie behalten möchten.' },
    validation: { title: 'Angaben korrigieren', message: 'Einige Angaben werden nicht akzeptiert.', action: 'Prüfen Sie die markierten Felder, Daten und Beträge.' },
    file: { title: 'Datei prüfen', message: 'Die Datei konnte nicht gelesen oder erstellt werden.', action: 'Prüfen Sie das Format und den Ordnerzugriff. Wählen Sie die Datei oder den Ordner erneut.' },
    unknown: { title: 'Aktion prüfen', message: 'Das Ergebnis dieser Aktion konnte nicht bestätigt werden.', action: 'Prüfen Sie das Ergebnis. Falls das Problem bleibt, geben Sie dem Support den Vorfallcode.' },
    unknownRead: { title: 'Informationen nicht verfügbar', message: 'Die Informationen konnten nicht geladen werden.', action: 'Laden Sie die Informationen erneut. Falls das Problem bleibt, geben Sie dem Support den Vorfallcode.' },
    uncertain: 'Prüfen Sie vor einer erneuten Speicherung, ob die Aktion bereits in Zentra erscheint.',
    reload: 'Anzeige aktualisieren', reconnect: 'Anmeldung öffnen', review: 'Angaben prüfen', details: 'Technische Details', incident: 'Vorfallcode', copy: 'Code kopieren', copied: 'Code kopiert', copyFailed: 'Kopieren ist nicht verfügbar. Markieren Sie den Code, um ihn zu kopieren.',
  },
  it: {
    documentCreationUnknown: { title: 'Verifichiamo la creazione', message: 'Il documento potrebbe essere già stato salvato. I dati inseriti sono conservati.', action: 'Usa « Verifica questa creazione » prima di un nuovo invio.' },
    network: { title: 'Connessione non disponibile', message: 'Zentra non ha potuto raggiungere il servizio.', action: 'Controlla la connessione Internet.' },
    session: { title: 'Accedi di nuovo al conto', message: 'La sessione non è più disponibile.', action: 'Ricollega questo dispositivo da Conto e team.' },
    permission: { title: 'Verifica l’accesso', message: 'Il tuo accesso non permette questa azione.', action: 'Verifica i diritti di accesso con chi gestisce l’azienda.' },
    member: { title: 'Verifica il conto aperto', message: 'Il conto usato per questa azione non è più disponibile su questo dispositivo.', action: 'Apri il conto corretto, poi riapri questa azione. Prima di ripeterla, verifica cosa è già stato salvato.' },
    workspace: { title: 'Verifica l’azienda aperta', message: 'La richiesta non corrisponde più al conto o all’azienda aperta.', action: 'Riapri questa azione nell’azienda corretta. Prima di ripeterla, verifica cosa è già stato salvato.' },
    workspaceRead: { title: 'Verifica l’azienda aperta', message: 'Questa lettura non riguarda più il conto o l’azienda aperta.', action: 'Verifica l’azienda aperta, poi aggiorna la vista o riapri la ricezione.' },
    conflict: { title: 'Verifica il salvataggio', message: 'I dati sono cambiati o sono utilizzati altrove.', action: 'Controlla la versione salvata prima di scegliere le modifiche da mantenere.' },
    validation: { title: 'Correggi le informazioni', message: 'Alcune informazioni non sono accettate.', action: 'Controlla i campi indicati, le date e gli importi.' },
    file: { title: 'Verifica il file', message: 'Il file non ha potuto essere letto o creato.', action: 'Controlla il formato e l’accesso alla cartella, poi scegli nuovamente il file o la cartella.' },
    unknown: { title: 'Verifica l’azione', message: 'Il risultato di questa azione non ha potuto essere confermato.', action: 'Controlla il risultato. Se il problema persiste, comunica il codice incidente all’assistenza.' },
    unknownRead: { title: 'Informazioni non disponibili', message: 'Le informazioni non sono state caricate.', action: 'Riprova a caricare le informazioni. Se il problema persiste, comunica il codice incidente all’assistenza.' },
    uncertain: 'Prima di salvare di nuovo, verifica se l’azione appare già in Zentra.',
    reload: 'Aggiorna la vista', reconnect: 'Apri l’accesso', review: 'Verifica le informazioni', details: 'Dettagli tecnici', incident: 'Codice incidente', copy: 'Copia il codice', copied: 'Codice copiato', copyFailed: 'La copia non è disponibile. Seleziona il codice per copiarlo.',
  },
  en: {
    documentCreationUnknown: { title: 'Check the creation', message: 'The document may already have been saved. Your entered information is retained.', action: 'Use “Check this creation” before sending again.' },
    network: { title: 'Connection unavailable', message: 'Zentra could not reach the service.', action: 'Check your Internet connection.' },
    session: { title: 'Sign in to your account again', message: 'Your session is no longer available.', action: 'Reconnect this device from Account and team.' },
    permission: { title: 'Check your access', message: 'Your access does not allow this action.', action: 'Check your access rights with the person who manages the company.' },
    member: { title: 'Check the open account', message: 'The account used for this action is no longer available on this device.', action: 'Open the correct account, then reopen this action. Check what was already saved before repeating it.' },
    workspace: { title: 'Check the open company', message: 'This request no longer matches the open account or company.', action: 'Reopen this action in the correct company. Check what was already saved before repeating it.' },
    workspaceRead: { title: 'Check the open company', message: 'This read no longer applies to the open account or company.', action: 'Check the open company, then refresh the view or reopen the inbox.' },
    conflict: { title: 'Check the saved record', message: 'The data changed or is being used elsewhere.', action: 'Review the saved version before choosing which changes to keep.' },
    validation: { title: 'Correct the information', message: 'Some information was not accepted.', action: 'Check the indicated fields, dates and amounts.' },
    file: { title: 'Check the file', message: 'The file could not be read or created.', action: 'Check its format and folder access, then select the file or folder again.' },
    unknown: { title: 'Check the action', message: 'The result of this action could not be confirmed.', action: 'Check the result. If the problem continues, give the incident code to support.' },
    unknownRead: { title: 'Information unavailable', message: 'The information could not be loaded.', action: 'Try loading the information again. If the problem continues, give the incident code to support.' },
    uncertain: 'Before saving again, check whether the action already appears in Zentra.',
    reload: 'Refresh the view', reconnect: 'Open sign-in', review: 'Check the information', details: 'Technical details', incident: 'Incident code', copy: 'Copy the code', copied: 'Code copied', copyFailed: 'Copying is unavailable. Select the code to copy it.',
  },
};

function displayErrorMessage(reason: unknown): string {
  try { return errorMessage(reason, ''); } catch { return ''; }
}

function errorStatus(reason: unknown): number | undefined {
  try {
    if (!reason || typeof reason !== 'object') return undefined;
    const value = (reason as { status?: unknown; statusCode?: unknown }).status ?? (reason as { statusCode?: unknown }).statusCode;
    return typeof value === 'number' ? value : typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : undefined;
  } catch { return undefined; }
}

function errorCode(reason: unknown): string {
  try { return reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string' ? reason.code.toLowerCase() : ''; } catch { return ''; }
}

export function classifyUserError(reason: unknown): UserErrorKind {
  if (isDocumentCreationUnconfirmedError(reason)) return 'unknown';
  if (localValidationDetails(reason)) return 'validation';
  const message = displayErrorMessage(reason).toLowerCase();
  const status = errorStatus(reason);
  const code = errorCode(reason);
  const text = `${code} ${message}`;
  // Native validation/not-found bodies can contain invoice references such as FA-401.
  // Only explicit status metadata or HTTP labels override that authored context.
  const nativeMessage = /^(?:erreur de base de données locale|erreur de fichier local|données json invalides|formulaire pdf invalide|archive zentra invalide|champ invalide|enregistrement introuvable|chemin refusé car il sort du dossier local autorisé)\s*:/.test(message.trimStart());
  const reportedHttpStatus = nativeMessage ? message.match(/\b(?:http(?:\/[\d.]+)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/)?.[1] || '' : '';
  const statusText = nativeMessage ? `${code} ${reportedHttpStatus}` : text;
  if (status === 401 || /\b401\b/.test(statusText) || /jwt.*expir|session.*expir|session.*invalid|refresh.?token|not authenticated|unauthenticated|auth.*required|reconnectez|connexion.*expir/.test(text)) return 'session';
  if (status === 403 || /\b403\b/.test(statusText) || /forbidden|row.level.security|\brls\b|insufficient.privilege|permission denied|access denied|droits?.*(insuffisant|requis)|accès.*(refus|interdit)|read.only|lecture seule/.test(text)) return 'permission';
  const nativeContextMessage = message.trim().replace(/^champ invalide\s*:\s*/, '');
  if (nativeContextMessage === 'le compte connecté a changé. rouvrez cette action avec le bon compte.' || nativeContextMessage === 'le contexte local du compte doit être vérifié. rouvrez votre espace.') return 'member';
  // Only authored native context rejections override the validation prefix.
  if (/(?:la connexion ou l[’']entreprise ouverte a changé\. rouvrez la réception\.|l[’']entreprise ouverte a changé\. rouvrez cette action dans le bon espace\.|l[’']espace de travail a changé pendant l[’']actualisation des réglages enregistrés\.)/.test(message)) return 'workspace';
  if (status === 409 || /\b409\b|\b23505\b/.test(statusText) || /unique constraint|duplicate key|already exists|conflict|conflit|sqlite_busy|database is locked|updated_at|version.*(changed|modifi)|modifi.*autre|déjà (utilisé|enregistré|existe)/.test(text)) return 'conflict';
  if (status === 400 || status === 422 || /\b(400|422|23502|23503|23514)\b/.test(statusText) || /validation|invalid (input|value|date|amount)|not.null.constraint|check.constraint|obligatoire|doit être|doivent être|date.*(invalide|antérieur)|montant.*(invalide|positif)|champ.*(requis|invalide)/.test(text)) return 'validation';
  if (/\benoent\b|\beacces\b|\benospc\b|no space left|disk full|file not found|no such file|fichier.*(introuvable|invalide|illisible|format)|invalid.*(pdf|file)|unsupported.*(file|format)|cannot.*(file|directory)|unable.*(file|directory)|format.*non.*pris/.test(text)) return 'file';
  if (status === 408 || status === 429 || (status !== undefined && status >= 500) || /\b(408|429|5\d\d)\b/.test(statusText) || /failed to fetch|network.*(error|request|unavailable)|load failed|fetch failed|offline|timed? ?out|timeout|econn|enotfound|dns|connexion.*(internet|réseau)|service.*indisponible|connection.*(refused|reset|closed)|too many requests|rate.?limit/.test(text)) return 'network';
  return 'unknown';
}

/** A bounded display-only copy. Never send this text to diagnostics. */
export function safeErrorDetails(reason: unknown): string {
  const raw = displayErrorMessage(reason);
  if (!raw) return '';
  return raw
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[secret]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[authorization]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, '[connection]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
    .replace(/\b(?:sk|pk|rk|sb_secret|sb_publishable)[_-][A-Za-z0-9_-]+\b/g, '[key]')
    .replace(/((?:["']?)(?:password|passwd|mot.de.passe|secret|token|api[_ -]?key|authorization|cookie|access[_ -]?key|client[_ -]?secret)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[secret]')
    .replace(/\b(?:authorization|cookie|password|passwd|mot.de.passe|client[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\b[^\r\n]*/gi, '[credential]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?:[A-Z]:[\\/]|\\\\)[^\r\n"<>|]+/gi, '[path]')
    .replace(/\/(?:Users|home|tmp|var|private|storage|data)\/[^\r\n\s"<>]+/g, '[path]')
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, '[account]')
    .replace(/(['"])[^'"\r\n]*\1/g, '[value]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[value]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 900);
}

export function userErrorCopy(language: AppLanguage = getAppLanguage()) { return copy[language]; }

export function getUserError(reason: unknown, options: { fallback?: string; language?: AppLanguage; operation?: UserErrorOperation } = {}) {
  const language = options.language ?? getAppLanguage();
  const labels = copy[language];
  // A real uncertain creation is never a field correction or a prompt to resend.
  if (isDocumentCreationUnconfirmedError(reason)) return { kind: 'unknown' as const, ...labels.documentCreationUnknown, technicalDetails: safeErrorDetails(reason) };
  const local = localValidationDetails(reason);
  if (local) return { kind: 'validation' as const, title: labels.validation.title, message: local.language === language ? local.message : labels.validation.message, action: labels.validation.action, technicalDetails: '' };
  const kind = classifyUserError(reason);
  const selected = kind === 'unknown' && options.operation === 'read' ? labels.unknownRead
    : kind === 'workspace' && options.operation === 'read' ? labels.workspaceRead : labels[kind];
  const uncertain = (options.operation ?? 'mutation') === 'mutation' && ['network', 'conflict', 'unknown', 'session'].includes(kind);
  // Fallbacks are authored UI context, never server text. Do not make an
  // uncertain mutation invite another blind save through old retry wording.
  const retryWording = /réessay|retry|try again|erneut|riprova/i;
  const fallback = options.fallback && !retryWording.test(options.fallback) ? t(options.fallback, undefined, language) : '';
  const raw = displayErrorMessage(reason);
  const authored = interfaceKeys.has(raw) && !retryWording.test(raw) && safeErrorDetails(raw) === raw ? t(raw, undefined, language) : '';
  return { kind, title: selected.title, message: authored || (kind === 'unknown' && fallback ? fallback : selected.message), action: uncertain ? `${selected.action} ${labels.uncertain}` : selected.action, technicalDetails: safeErrorDetails(reason) };
}

export function userErrorMessage(reason: unknown, fallback?: string): string { return getUserError(reason, { fallback }).message; }
