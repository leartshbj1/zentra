import { useEffect, useState } from 'react';
import { Archive, CheckCircle2, Clock3, FileText, MessageSquareWarning, Plus, Printer, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import { desktopApi } from './bridge';
import type { Reminder, ReminderHistory, ReminderSettings, ReminderTemplate, Workspace } from './types';
import { formatDate, formatMoney, todayIso } from './utils';
import { Button, EmptyState, ErrorPanel, Field, SectionHeading, StatusBadge, submitForm } from './ui';

type Tab = 'due' | 'templates' | 'history' | 'settings';

export function RemindersScreen({ workspace }: { workspace: Workspace }) {
  const [tab, setTab] = useState<Tab>('due');
  const [settings, setSettings] = useState<ReminderSettings>({ enabled: false, senderName: '' });
  const [templates, setTemplates] = useState<ReminderTemplate[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [history, setHistory] = useState<ReminderHistory[]>([]);
  const [selectedReminderId, setSelectedReminderId] = useState('');
  const [templateDraft, setTemplateDraft] = useState<Partial<ReminderTemplate> | null>(null);
  const [asOf, setAsOf] = useState(todayIso());
  const [printReminder, setPrintReminder] = useState<Reminder | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (success) setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'L’action de relance locale a échoué.'); }
    finally { setBusy(false); }
  }

  async function load() {
    const [nextSettings, nextTemplates, nextReminders] = await Promise.all([desktopApi.getReminderSettings(), desktopApi.listReminderTemplates(), desktopApi.listReminders()]);
    setSettings(nextSettings); setTemplates(nextTemplates); setReminders(nextReminders);
  }

  useEffect(() => { void run(load); }, []);

  useEffect(() => {
    if (!printReminder) return;
    const timeout = window.setTimeout(() => window.print(), 80);
    return () => window.clearTimeout(timeout);
  }, [printReminder]);

  async function selectHistory(id: string) {
    setSelectedReminderId(id);
    await run(async () => setHistory(await desktopApi.getReminderHistory(id)));
  }

  async function mark(reminder: Reminder, status: 'completed' | 'cancelled') {
    const note = window.prompt(status === 'completed' ? 'Note de traitement (facultative)' : 'Motif d’annulation (facultatif)') ?? undefined;
    await run(async () => { await desktopApi.markReminder(reminder.id, status, note); await load(); }, status === 'completed' ? 'La relance a été marquée traitée.' : 'La relance a été annulée.');
  }

  async function record(reminder: Reminder, action: 'printed' | 'sent_manually') {
    if (action === 'sent_manually') {
      const note = window.prompt('Indiquez le canal ou la référence de l’envoi effectué hors du logiciel. Cette action n’envoie aucun message.');
      if (note === null) return;
      await run(async () => { await desktopApi.recordReminderAction(reminder.id, action, note); await load(); }, 'L’envoi manuel a été tracé localement; aucun message n’a été envoyé par Elyko.');
      return;
    }
    await run(async () => { await desktopApi.recordReminderAction(reminder.id, 'printed'); setPrintReminder(reminder); await load(); }, 'L’impression a été ajoutée à l’historique.');
  }

  const tabs: Array<[Tab, string]> = [['due', 'Échéances'], ['templates', 'Niveaux & modèles'], ['history', 'Historique'], ['settings', 'Paramètres']];
  const due = reminders.filter((reminder) => reminder.status === 'due' || reminder.status === 'planned');
  const selectedReminder = reminders.find((reminder) => reminder.id === selectedReminderId);

  return <div className="stack-layout reminders-screen">
    <section className="panel reminder-toolbar"><div className="tab-strip">{tabs.map(([id, label]) => <button className={tab === id ? 'is-active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}</div><div><Field label="État au"><input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></Field><Button disabled={busy || !settings.enabled || !templates.some((template) => template.active)} onClick={() => void run(async () => { await desktopApi.generateDueReminders(asOf); await load(); }, 'Les échéances ont été analysées; seules les relances applicables ont été créées.')}><RefreshCw size={15} /> Générer les échéances</Button></div></section>
    <div className="info-strip"><ShieldCheck size={17} /><span>Elyko ne transmet aucun e-mail : les impressions et envois manuels sont uniquement tracés dans l’historique local.</span></div>
    {error ? <ErrorPanel message={error} /> : null}{notice ? <div className="notice notice--success"><span><CheckCircle2 size={18} />{notice}</span><button onClick={() => setNotice('')}><X size={15} /></button></div> : null}

    {tab === 'due' ? <section className="panel"><SectionHeading eyebrow="À traiter" title="Factures échues et relances planifiées" description="Le solde figé par la relance inclut les paiements et avoirs liés par le moteur local." />{due.length ? <div className="reminder-list">{due.map((reminder) => { const invoice = workspace.invoices.find((item) => item.id === reminder.invoiceId); const client = workspace.clients.find((item) => item.id === invoice?.clientId); return <article key={reminder.id}><header><span className="reminder-level">Niveau {reminder.level}</span><div><strong>{reminder.subject}</strong><small>{invoice?.number || reminder.invoiceNumber || 'Facture'} · {client?.company || client?.name || reminder.clientName || 'Client'}</small></div><StatusBadge status={reminder.status} /></header><div className="reminder-facts"><span>Échéance <strong>{formatDate(invoice?.dueDate || reminder.dueDate)}</strong></span><span>Relance prévue <strong>{formatDate(reminder.scheduledDate)}</strong></span><span>Solde figé <strong>{formatMoney(reminder.balanceCents)}</strong></span></div><p>{reminder.body}</p><footer><Button variant="secondary" size="small" onClick={() => void record(reminder, 'printed')}><Printer size={14} /> Imprimer</Button><Button variant="secondary" size="small" onClick={() => void record(reminder, 'sent_manually')}><Send size={14} /> Tracer un envoi manuel</Button><Button variant="ghost" size="small" onClick={() => { setTab('history'); void selectHistory(reminder.id); }}><Clock3 size={14} /> Historique</Button><Button size="small" onClick={() => void mark(reminder, 'completed')}><CheckCircle2 size={14} /> Traitée</Button><Button variant="ghost" size="small" onClick={() => void mark(reminder, 'cancelled')}><X size={14} /> Annuler</Button></footer></article>; })}</div> : <EmptyState icon={<MessageSquareWarning />} title="Aucune relance à traiter" text={settings.enabled ? 'Générez les échéances pour la date choisie; aucun exemple n’est affiché.' : 'Activez les relances et créez au moins un modèle.'} />}</section> : null}

    {tab === 'templates' ? <section className="panel"><SectionHeading eyebrow="Niveaux" title="Modèles de relance" description="Le contenu est conservé localement et n’est jamais envoyé automatiquement." action={<Button onClick={() => setTemplateDraft({ active: true })}><Plus size={15} /> Nouveau modèle</Button>} />{templateDraft ? <form className="reminder-template-form" onSubmit={submitForm(async (form) => { await run(async () => { await desktopApi.upsertReminderTemplate({ id: templateDraft.id, level: Number(form.get('level')), name: String(form.get('name')), subject: String(form.get('subject')), body: String(form.get('body')), daysAfterDue: Number(form.get('daysAfterDue')), active: form.get('active') === 'on' }); setTemplateDraft(null); await load(); }, 'Le modèle de relance a été enregistré.'); })}><div className="form-grid"><Field label="Niveau" required><input name="level" type="number" min="1" max="10" defaultValue={templateDraft.level || ''} required /></Field><Field label="Nom" required><input name="name" defaultValue={templateDraft.name} required /></Field><Field label="Jours après échéance" required><input name="daysAfterDue" type="number" min="0" defaultValue={templateDraft.daysAfterDue ?? ''} required /></Field><Field label="Objet" required wide><input name="subject" defaultValue={templateDraft.subject} required /></Field><Field label="Corps du message" required wide><textarea name="body" rows={7} defaultValue={templateDraft.body} required /></Field><label className="check-card"><input name="active" type="checkbox" defaultChecked={templateDraft.active ?? true} /><span><strong>Modèle actif</strong><small>Pris en compte lors de la génération locale.</small></span></label></div><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setTemplateDraft(null)}>Annuler</Button><Button type="submit" disabled={busy}>Enregistrer</Button></div></form> : null}{templates.length ? <div className="template-list">{templates.map((template) => <article key={template.id}><span className="reminder-level">Niveau {template.level}</span><div><strong>{template.name}</strong><p>{template.subject}</p><small>{template.daysAfterDue} jour{template.daysAfterDue > 1 ? 's' : ''} après échéance</small></div><StatusBadge status={template.active ? 'validated' : 'incomplete'} /><Button variant="ghost" size="small" onClick={() => setTemplateDraft(template)}>Modifier</Button><Button variant="ghost" size="icon" onClick={() => { if (window.confirm(`Supprimer le modèle « ${template.name} » ?`)) void run(async () => { await desktopApi.deleteReminderTemplate(template.id); await load(); }, 'Le modèle inutilisé a été supprimé.'); }}><Archive size={15} /></Button></article>)}</div> : <EmptyState icon={<FileText />} title="Aucun modèle" text="Créez chaque niveau et son texte réel; aucun modèle commercial n’est imposé." />}</section> : null}

    {tab === 'history' ? <section className="panel"><SectionHeading eyebrow="Traçabilité locale" title="Historique des relances" /><div className="history-layout"><div className="history-selector">{reminders.length ? reminders.map((reminder) => <button className={selectedReminderId === reminder.id ? 'is-active' : ''} key={reminder.id} onClick={() => void selectHistory(reminder.id)}><strong>Niveau {reminder.level} · {reminder.subject}</strong><small>{formatDate(reminder.scheduledDate)} · {reminder.status}</small></button>) : <EmptyState title="Aucune relance" text="L’historique apparaîtra après création d’une relance réelle." />}</div><div className="history-timeline">{selectedReminder ? <header><strong>{selectedReminder.subject}</strong><StatusBadge status={selectedReminder.status} /></header> : null}{history.length ? history.map((item) => <article key={item.id}><span /><div><strong>{historyLabel(item.action)}</strong><small>{formatDate(item.occurredAt)}</small>{item.note ? <p>{item.note}</p> : null}</div></article>) : selectedReminderId ? <div className="compact-empty"><Clock3 size={18} /><span>Aucune action enregistrée.</span></div> : <div className="compact-empty"><Clock3 size={18} /><span>Choisissez une relance.</span></div>}</div></div></section> : null}

    {tab === 'settings' ? <section className="panel settings-card"><SectionHeading eyebrow="Fonctionnement" title="Paramètres des relances" description="Aucune transmission automatique n’est disponible." /><label className="module-toggle module-toggle--compact"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /><span><MessageSquareWarning size={19} /><strong>Relances actives</strong><small>Autorise uniquement la génération locale des échéances</small></span></label><Field label="Nom de l’expéditeur"><input value={settings.senderName} onChange={(event) => setSettings((current) => ({ ...current, senderName: event.target.value }))} /></Field><Button disabled={busy} onClick={() => void run(async () => { await desktopApi.updateReminderSettings(settings); await load(); }, 'Les paramètres de relance ont été enregistrés.')}>Enregistrer</Button></section> : null}

    {printReminder ? <ReminderPrint reminder={printReminder} workspace={workspace} onClose={() => setPrintReminder(null)} /> : null}
  </div>;
}

function historyLabel(action: string) {
  return ({ created: 'Relance créée', due: 'Arrivée à échéance', completed: 'Traitée', cancelled: 'Annulée', printed: 'Imprimée', exported: 'Exportée', sent_manually: 'Envoi manuel tracé', note: 'Note ajoutée' } as Record<string, string>)[action] ?? action;
}

function ReminderPrint({ reminder, workspace, onClose }: { reminder: Reminder; workspace: Workspace; onClose: () => void }) {
  const invoice = workspace.invoices.find((item) => item.id === reminder.invoiceId);
  const client = workspace.clients.find((item) => item.id === invoice?.clientId);
  const settings = workspace.settings!;
  return <div className="print-preview"><div className="print-preview__toolbar"><strong>Aperçu de la relance</strong><Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> Imprimer</Button><Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button></div><article className="print-sheet reminder-print"><header className="print-header"><div><strong>{settings.organization.legalName}</strong><p>{settings.organization.address.street} {settings.organization.address.buildingNumber}<br />{settings.organization.address.postalCode} {settings.organization.address.city}</p></div><div><h1>RELANCE NIVEAU {reminder.level}</h1><strong>{invoice?.number || reminder.invoiceNumber || '—'}</strong></div></header><section className="print-recipient"><span>DESTINATAIRE</span><strong>{client?.company || client?.name || reminder.clientName || '—'}</strong><p>{client?.address || '—'}</p></section><h2>{reminder.subject}</h2><div className="reminder-letter">{reminder.body.split('\n').map((line, index) => <p key={`${line}-${index}`}>{line || <br />}</p>)}</div><footer className="print-footer"><p>Échéance de la facture : {formatDate(invoice?.dueDate || reminder.dueDate)}<br />Solde figé de la relance : {formatMoney(reminder.balanceCents)}<br />Document préparé localement le {formatDate(todayIso())}.</p></footer></article></div>;
}
