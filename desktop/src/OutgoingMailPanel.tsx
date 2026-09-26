import { useEffect, useRef, useState } from 'react';
import { Check, Mail, Paperclip, Send } from 'lucide-react';
import { Button, ErrorPanel, Field, Modal } from './ui';
import { errorMessage } from './utils';
import { mailConnectionInput, mailTemplateError, mailVariables, outgoingMail, type MailConnection, type MailPreview, type MailState, type MailTarget } from './outgoingMail';
import './outgoing-mail.css';

const emptyConnection: MailConnection = { host: 'mail.infomaniak.com', port: 465, security: 'tls', username: '', fromEmail: '', fromName: '', password: '' };
export function MailSettings({ companyName = '', companyEmail = '', readOnly = false, initialTab = 'connection', onSaved }: { companyName?: string; companyEmail?: string; readOnly?: boolean; initialTab?: 'connection' | 'quotes' | 'invoices'; onSaved?: () => Promise<void> }) {
  const [state, setState] = useState<MailState | null>(null);
  const [connection, setConnection] = useState<MailConnection>({ ...emptyConnection, fromName: companyName, username: companyEmail, fromEmail: companyEmail });
  const [tab, setTab] = useState<'connection' | 'quotes' | 'invoices'>(initialTab);
  const [provider, setProvider] = useState('infomaniak');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [attempt, setAttempt] = useState(0);
  const flight = useRef(false);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const focused = useRef<'subject' | 'body'>('body');
  useEffect(() => { let active = true; void outgoingMail.state().then(value => { if (!active) return; setState(value); setConnection(current => mailConnectionInput({ ...current, ...value.connection, password: '' })); if (value.connection.connected) setProvider(value.connection.host === 'mail.infomaniak.com' ? 'infomaniak' : 'smtp'); }).catch(reason => { if (active) setError(errorMessage(reason, 'La messagerie n’a pas pu être ouverte. Réessayez.')); }); return () => { active = false; }; }, [attempt]);
  const locked = busy || readOnly || !state?.canConfigure;
  async function perform(action: () => Promise<void>) { if (flight.current) return; flight.current = true; setBusy(true); setError(''); setNotice(''); try { await action(); } catch (reason) { setError(errorMessage(reason, 'La messagerie n’a pas pu être ouverte. Réessayez.')); } finally { setBusy(false); flight.current = false; } }
  function patch(patch: Partial<MailConnection>) { setConnection(value => ({ ...value, ...patch })); setNotice(''); }
  function insertVariable(key: string) {
    if (!state || tab === 'connection') return;
    setNotice('');
    const name = focused.current, current = state.templates[tab][name], element = field.current;
    const start = element?.selectionStart ?? current.length, end = element?.selectionEnd ?? start;
    const token = `{${key}}`, next = current.slice(0, start) + token + current.slice(end);
    setState({ ...state, templates: { ...state.templates, [tab]: { ...state.templates[tab], [name]: next } } });
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length); });
  }
  return <section className="mail-settings">
    <header><h2>Vos e-mails, depuis Zentra.</h2><p>Devis, factures et relances avec votre adresse professionnelle.</p></header>
    <nav className="mail-tabs" aria-label="Réglages des e-mails">{([['connection', 'Messagerie'], ['quotes', 'Devis'], ['invoices', 'Factures']] as const).map(([id, label]) => <Button type="button" key={id} variant={tab === id ? 'primary' : 'ghost'} aria-pressed={tab === id} disabled={busy} onClick={() => { setTab(id); setError(''); setNotice(''); }}>{label}</Button>)}</nav>
    {error && <ErrorPanel message={error} onRetry={!state ? () => { setError(''); setAttempt(n => n + 1); } : undefined} />}
    {notice && <p className="mail-notice" role="status"><Check size={17} />{notice}</p>}
    {!state && !error && <p role="status">Ouverture de la messagerie…</p>}
    {state && !state.canConfigure && <p>Un administrateur peut modifier ces réglages.</p>}
    {state && tab === 'connection' && <form onSubmit={event => { event.preventDefault(); if (!locked) void perform(async () => { const result = await outgoingMail.connect(state.scope, connection); setState({ ...state, connection: result }); setConnection(value => ({ ...value, password: '' })); setNotice('Connexion vérifiée et enregistrée. Aucun e-mail de test n’a été envoyé.'); }); }}>
      <div className="mail-connection-state"><Mail size={20} /><div><strong>{state.connection.connected ? state.connection.fromEmail : 'Connecter une messagerie'}</strong><span>{state.connection.connected ? 'Connectée sur cet appareil' : 'Connexion chiffrée · mot de passe dans le coffre de cet appareil'}</span></div></div>
      <fieldset disabled={locked} className="mail-fields">
        <Field label="Fournisseur"><select value={provider} onChange={e => { setProvider(e.target.value); if (e.target.value === 'infomaniak') patch({ host: 'mail.infomaniak.com', port: 465, security: 'tls' }); }}><option value="infomaniak">Infomaniak</option><option value="smtp">Autre messagerie · SMTP</option></select></Field>
        <Field label="Nom de l’expéditeur" required><input value={connection.fromName} maxLength={200} onChange={e => patch({ fromName: e.target.value })} required autoComplete="organization" /></Field>
        <Field label="Adresse d’envoi" required><input type="email" value={connection.fromEmail} onChange={e => patch({ fromEmail: e.target.value, ...(connection.username === connection.fromEmail ? { username: e.target.value } : {}) })} required autoComplete="email" /></Field>
        <Field label="Identifiant SMTP" required><input value={connection.username} onChange={e => patch({ username: e.target.value })} required autoComplete="username" /></Field>
        <Field label="Mot de passe de la boîte mail" required={!state.connection.connected} hint={state.connection.connected ? 'Laissez vide pour conserver le mot de passe enregistré.' : 'Selon le fournisseur, utilisez le mot de passe de la boîte ou un mot de passe d’application.'}><input type="password" value={connection.password} onChange={e => patch({ password: e.target.value })} required={!state.connection.connected} autoComplete="new-password" /></Field>
        {provider === 'smtp' && <><Field label="Serveur SMTP" required><input value={connection.host} onChange={e => patch({ host: e.target.value.trim() })} placeholder="smtp.votre-fournisseur.ch" required /></Field><Field label="Chiffrement"><select value={connection.security} onChange={e => patch({ security: e.target.value as 'tls' | 'starttls', port: e.target.value === 'tls' ? 465 : 587 })}><option value="tls">TLS · port 465</option><option value="starttls">STARTTLS · port 587</option></select></Field><Field label="Port" required><input type="number" min={1} max={65535} value={connection.port} onChange={e => patch({ port: Number(e.target.value) })} required /></Field></>}
      </fieldset>
      <div className="mail-actions"><Button type="submit" disabled={locked}>{busy ? 'Vérification…' : state.connection.connected ? 'Vérifier et enregistrer' : 'Connecter ma messagerie'}</Button>{state.connection.connected && <Button type="button" variant="ghost" disabled={locked} onClick={() => void perform(async () => { await outgoingMail.disconnect(state.scope); setState({ ...state, connection: { connected: false } }); setConnection(value => ({ ...value, password: '' })); setNotice('Messagerie déconnectée sur cet appareil.'); })}>Déconnecter</Button>}</div>
      <p className="mail-help">À connecter une fois sur chaque appareil. Les modèles des documents suivent l’entreprise ; le mot de passe reste sur cet appareil. Les comptes nécessitant uniquement OAuth ne sont pas pris en charge par SMTP avec mot de passe.</p>
    </form>}
    {state && tab !== 'connection' && <form onSubmit={event => { event.preventDefault(); if (!locked) void perform(async () => { const issue = mailTemplateError(state.templates.quotes) || mailTemplateError(state.templates.invoices); if (issue) throw new Error(issue); await outgoingMail.saveTemplates(state.scope, state.templates, state.signature ?? { includeCompanyLogo: false }); setNotice('Modèles enregistrés pour l’entreprise.'); await onSaved?.(); }); }}>
      <p>Préparé pour chaque client. Vous pourrez toujours modifier le message avant l’envoi.</p>
      <fieldset className="mail-fields mail-fields--single" disabled={locked}><Field label="Objet" required><input value={state.templates[tab].subject} maxLength={250} onFocus={e => { focused.current = 'subject'; field.current = e.currentTarget; }} onChange={e => { setNotice(''); setState({ ...state, templates: { ...state.templates, [tab]: { ...state.templates[tab], subject: e.target.value } } }); }} required /></Field><Field label="Message" required><textarea value={state.templates[tab].body} rows={10} onFocus={e => { focused.current = 'body'; field.current = e.currentTarget; }} onChange={e => { setNotice(''); setState({ ...state, templates: { ...state.templates, [tab]: { ...state.templates[tab], body: e.target.value } } }); }} required /></Field></fieldset>
      <div className="mail-variables" aria-label="Insérer une variable">{mailVariables.map(([key, label]) => <Button type="button" key={key} variant="ghost" size="small" disabled={locked} onClick={() => insertVariable(key)} title={`Insérer {${key}}`}>{label}</Button>)}</div>
      <div className="mail-signature-settings">
        <label className="mail-signature-toggle"><input type="checkbox" role="switch" checked={Boolean(state.signature?.includeCompanyLogo)} disabled={locked || (!state.companyLogoDataUrl && !state.signature?.includeCompanyLogo)} onChange={event => { setNotice(''); setState({ ...state, signature: { includeCompanyLogo: event.target.checked } }); }} /><span><strong>Ajouter le logo de l’entreprise</strong><small>Après votre message, pour les devis, factures et relances.</small></span></label>
        {state.signature?.includeCompanyLogo && state.companyLogoDataUrl && <CompanyMailSignature logo={state.companyLogoDataUrl} />}
        {!state.companyLogoDataUrl && <p className="mail-help">{state.companyLogoError || 'Ajoutez votre logo dans Paramètres → Entreprise pour l’utiliser ici.'}</p>}
      </div>
      <div className="mail-actions"><Button type="submit" disabled={locked}>{busy ? 'Enregistrement…' : 'Enregistrer les modèles'}</Button></div><p className="mail-help">Les textes des relances se règlent dans Relances → Cycle & textes.</p>
    </form>}
  </section>;
}

function CompanyMailSignature({ logo }: { logo: string }) {
  return <figure className="mail-signature-preview"><figcaption>Logo ajouté après votre message</figcaption><div className="mail-signature-paper" data-document-colors><img src={logo} alt="Logo de l’entreprise" /></div></figure>;
}

export function MailComposer({ target, onClose, onSent }: { target: MailTarget; onClose: () => void; onSent?: () => void }) {
  const [preview, setPreview] = useState<MailPreview | null>(null), [state, setState] = useState<MailState | null>(null);
  const [recipient, setRecipient] = useState(''), [subject, setSubject] = useState(''), [body, setBody] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [settings, setSettings] = useState(false), [attempt, setAttempt] = useState(0);
  const flight = useRef(false), requestId = useRef(crypto.randomUUID());
  const [attempted, setAttempted] = useState(false), [historyWarning, setHistoryWarning] = useState(false);
  async function returnToMessage() {
    setBusy(true); setError('');
    try {
      const [next, nextState] = await Promise.all([outgoingMail.preview(target), outgoingMail.state()]);
      if (next.scope !== nextState.scope) throw new Error('L’entreprise a changé. Rouvrez cet e-mail.');
      // Connecting SMTP does not discard the user's draft. Changed company/document data reloads the preview.
      if (next.sourceRevision !== preview?.sourceRevision) { setRecipient(next.recipient); setSubject(next.subject); setBody(next.body); }
      setPreview(next); setState(nextState);
    } catch (reason) { setError(errorMessage(reason, 'La messagerie n’a pas pu être ouverte. Réessayez.')); }
    finally { setSettings(false); setBusy(false); }
  }
  useEffect(() => { let active = true; setError(''); void Promise.all([outgoingMail.preview(target), outgoingMail.state()]).then(([p, s]) => { if (!active) return; if (p.scope !== s.scope) throw new Error('L’entreprise a changé. Rouvrez cet e-mail.'); setPreview(p); setState(s); setRecipient(p.recipient); setSubject(p.subject); setBody(p.body); }).catch(reason => { if (active) setError(errorMessage(reason, 'La messagerie n’a pas pu être ouverte. Réessayez.')); }); return () => { active = false; }; }, [target.entity, target.id, attempt]);
  async function send() {
    if (flight.current || !preview || preview.signatureLogoError || !state?.connection.connected || sent) return;
    flight.current = true; setBusy(true); setError(''); setAttempted(true);
    try { const result = await outgoingMail.send({ requestId: requestId.current, scope: preview.scope, target, sourceRevision: preview.sourceRevision, recipient: recipient.trim(), subject, body }); setHistoryWarning(Boolean(result.historyWarning)); setSent(true); onSent?.(); }
    catch (reason) { setError(errorMessage(reason, 'L’envoi n’a pas pu être confirmé. Vérifiez votre messagerie avant de renvoyer.')); }
    finally { setBusy(false); flight.current = false; }
  }
  return <Modal title={sent ? 'E-mail transmis' : settings ? 'Votre messagerie' : 'Envoyer par e-mail'} onClose={onClose} dismissible={!busy}>
    <div className="mail-composer">
      {sent ? <><p className="mail-notice" role="status"><Check size={20} />Le serveur de votre messagerie a accepté l’e-mail pour {recipient}.</p><p>Le PDF est joint. La réception par le destinataire n’est pas encore confirmée.</p>{historyWarning && <p role="alert">L’historique local n’a pas pu être complété. L’e-mail a été accepté : ne le renvoyez pas pour cette raison.</p>}<Button type="button" onClick={onClose}>Terminer</Button></> : settings ? <><MailSettings initialTab={state?.connection.connected ? (target.entity === 'quotes' ? 'quotes' : 'invoices') : 'connection'} /><Button type="button" variant="secondary" disabled={busy} onClick={() => void returnToMessage()}>Revenir au message</Button></> : <>
        {error && <ErrorPanel message={error} onRetry={!preview ? () => setAttempt(n => n + 1) : undefined} />}
        {!preview && !error && <p role="status">Préparation de l’e-mail…</p>}
        {preview && <>
          {!state?.connection.connected ? <div className="mail-connect-prompt"><p>Connectez votre messagerie pour envoyer depuis votre adresse.</p><Button type="button" onClick={() => setSettings(true)}>Connecter ma messagerie</Button></div> : <p className="mail-from">De : {state.connection.fromName} &lt;{state.connection.fromEmail}&gt;</p>}
          {preview.history.length > 0 && <details className="mail-history"><summary>Derniers envois sur cet appareil</summary>{preview.history.map((item, index) => <p key={index}>{new Date(item.createdAt).toLocaleString()} · {item.recipient}<br />{item.status === 'accepted' ? 'Accepté par le serveur' : item.status === 'rejected' ? 'Refusé par le serveur' : 'Envoi non confirmé — à vérifier avant de renvoyer'}</p>)}</details>}
          <form onSubmit={event => { event.preventDefault(); void send(); }}>
            <fieldset className="mail-fields mail-fields--single" disabled={busy || attempted}>
              <Field label="À" required hint={!preview.recipient ? 'Ajoutez l’adresse du client pour cet envoi.' : undefined}><input type="email" required value={recipient} onChange={e => setRecipient(e.target.value)} autoComplete="email" /></Field>
              <Field label="Objet" required><input required maxLength={250} value={subject} onChange={e => setSubject(e.target.value)} /></Field>
              <Field label="Message" required><textarea required rows={10} value={body} onChange={e => setBody(e.target.value)} /></Field>
            </fieldset>
            {preview.signatureLogoDataUrl && <CompanyMailSignature logo={preview.signatureLogoDataUrl} />}
            {preview.signatureLogoError && <div className="mail-signature-issue"><p role="alert">{preview.signatureLogoError}</p>{state?.canConfigure && <Button type="button" variant="secondary" disabled={busy || attempted} onClick={() => setSettings(true)}>Modifier les réglages des e-mails</Button>}</div>}
            <p className="mail-attachment"><Paperclip size={17} /><span>{preview.attachmentName}</span><small>PDF joint automatiquement</small></p>
            <div className="mail-actions"><Button type="submit" disabled={busy || attempted || !state?.connection.connected || Boolean(preview.signatureLogoError)}><Send size={16} />{busy ? 'Envoi en cours…' : 'Envoyer l’e-mail'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{attempted ? 'Fermer' : 'Annuler'}</Button></div>
            {attempted && !busy && <p className="mail-help">Aucun renvoi automatique. Après vérification, fermez puis rouvrez le message si vous devez préparer un nouvel envoi.</p>}
          </form>
        </>}
      </>}
    </div>
  </Modal>;
}
