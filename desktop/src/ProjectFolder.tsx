import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, Image, Plus, Trash2 } from 'lucide-react';
import { desktopApi } from './bridge';
import { ProjectFilePreview } from './ProjectFilePreview';
import { ProjectFilesPicker } from './ProjectFilesPicker';
import { requestProjectSync, useProjectSyncStatus } from './projectSync';
import { projectSyncPresentation } from './projectSyncPresentation';
import { CloudAccountAccess } from './CloudAccountAccess';
import { fileSizeLabel, isProjectFile, projectDocuments } from './projectDocuments';
import type { Attachment, Invoice, Project, Quote, Workspace } from './types';
import { Button, ErrorPanel, Modal, StatusBadge } from './ui';
import { documentTotals, errorMessage, formatDate, formatMoney } from './utils';

export function ProjectFolder({ project, workspace, busy, readOnly, onBack, onOpenDocument, onCreateDocument, onWorkspaceChange, onOpenExpense }: {
  project: Project; workspace: Workspace; busy: boolean; readOnly: boolean; onBack: () => void;
  onOpenDocument: (entity: 'quotes' | 'invoices', item: Quote | Invoice) => void;
  onCreateDocument: (entity: 'quotes' | 'invoices', project: Project) => void;
  onWorkspaceChange: (workspace: Workspace) => void;
  onOpenExpense?: (expenseId: string) => void;
}) {
  const [tab, setTab] = useState<'all' | 'files' | 'quotes' | 'invoices'>('all');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [preview, setPreview] = useState<{ file: Attachment; bytes: Uint8Array; url: string } | null>(null);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const contents = projectDocuments(workspace, project.id);
  const sync = useProjectSyncStatus();
  const projectPending = sync.documents.filter(file=>file.project_id===project.id && file.state!=='synced').length;
  const syncPresentation = projectSyncPresentation(sync, projectPending);
  const billingQuotes = contents.quotes.filter((quote) => contents.invoices.some((invoice) => invoice.quoteId === quote.id));
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function upload() {
    if (saving || busy || readOnly) return;
    setSaving(true); setError('');
    const remaining: File[] = [];
    const errors: string[] = [];
    for (const [index, file] of files.entries()) {
      setProgress(`Ajout ${index + 1}/${files.length} · ${file.name}`);
      try { await desktopApi.addProjectDocument(project.id, file); }
      catch (reason) { remaining.push(file); errors.push(`${file.name} : ${errorMessage(reason, 'ajout impossible')}`); }
    }
    setFiles(remaining);
    try { onWorkspaceChange(await desktopApi.loadWorkspace()); }
    catch (reason) { errors.push(errorMessage(reason, 'Actualisation impossible. Rouvrez le projet.')); }
    setError(errors.join(' ')); setProgress(''); setSaving(false);
  }
  async function open(file: Attachment, trigger: HTMLElement) {
    if (saving) return;
    previewTrigger.current = trigger;
    setSaving(true); setError('');
    try {
      const encoded = await desktopApi.readProjectDocument(file.id);
      if (!mounted.current) return;
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      setPreview({ file, bytes, url: URL.createObjectURL(new Blob([bytes], { type: file.mimeType })) });
    } catch (reason) { setError(errorMessage(reason, 'Impossible d’ouvrir ce fichier.')); }
    finally { setSaving(false); }
  }
  function closePreview() {
    setPreview(null);
    // Opening disables the trigger during the file read, so the generic modal
    // cannot capture it reliably after the asynchronous operation completes.
    const trigger = previewTrigger.current;
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }
  async function remove() {
    if (!removing || saving || busy || readOnly) return;
    setSaving(true); setError('');
    try { onWorkspaceChange(await desktopApi.deleteProjectDocument(removing.id)); setRemoving(null); }
    catch (reason) { setError(errorMessage(reason, 'Suppression impossible.')); }
    finally { setSaving(false); }
  }
  const client = workspace.clients.find((item) => item.id === project.clientId);
  return <section className="project-folder stack-layout" aria-label={`Dossier du projet ${project.name}`}>
    <header className="project-folder__header">
      <Button variant="ghost" onClick={onBack} disabled={saving}><ArrowLeft size={18} /> Projets</Button>
      <div><h2>{project.name}</h2><p>{client?.company || client?.name}</p></div>
      <StatusBadge status={project.status} />
    </header>
    <nav className="project-folder__tabs" aria-label="Contenu du projet">{([
      ['all', 'Tout', contents.files.length + contents.quotes.length + contents.invoices.length],
      ['files', 'Documents', contents.files.length], ['quotes', 'Devis', contents.quotes.length], ['invoices', 'Factures', contents.invoices.length],
    ] as const).map(([id, label, count]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label} <span>{count}</span></button>)}</nav>
    {error ? <ErrorPanel message={error} /> : null}
    {(tab === 'all' || tab === 'files') ? <section className="panel project-folder__section">
      <h3>Documents et photos</h3>
      <div className="project-sync" role="status" aria-live="polite">
        <div><strong>{syncPresentation.title}</strong><p>{syncPresentation.description}</p></div>
        {syncPresentation.canSynchronize ? <Button size="small" variant="secondary" disabled={sync.syncing || sync.busy} onClick={requestProjectSync}>Synchroniser</Button> : !sync.mode || sync.mode === 'legacy' ? <CloudAccountAccess /> : null}
      </div>
      {!readOnly ? <><ProjectFilesPicker files={files} onChange={setFiles} disabled={saving || busy} />
      {files.length ? <Button onClick={() => void upload()} disabled={saving || busy}>{saving ? progress : `Enregistrer ${files.length} fichier${files.length > 1 ? 's' : ''}`}</Button> : null}</> : null}
      <ul className="project-document-list">{contents.files.map((file) => {
        const expenseId = file.entityType === 'expense' ? file.entityId : file.entityType === 'expense_refund' ? workspace.expenses.find((expense) => expense.refunds?.some((refund) => refund.id === file.entityId))?.id : undefined;
        const customerCredit = file.entityType === 'customer_credit_settlement' ? workspace.invoices.find((invoice) => invoice.type === 'credit_note' && invoice.creditSettlements?.some((event) => event.id === file.entityId)) : undefined;
        return <li key={file.id} className={(expenseId && onOpenExpense) || customerCredit ? 'project-document-list__with-source' : undefined}>
        <button type="button" className="project-document-list__open" onClick={(event) => void open(file, event.currentTarget)} disabled={saving}>
          {file.mimeType.startsWith('image/') ? <Image size={22} /> : <FileText size={22} />}
          <span><strong>{file.originalName}</strong><small>{fileSizeLabel(file.sizeBytes)} · {formatDate(file.createdAt)}{file.entityType === 'supplier_invoice' ? ' · Justificatif fournisseur' : file.entityType === 'customer_credit_settlement' ? ' · Règlement d’un avoir client' : file.entityType === 'expense_refund' ? ' · Avoir / remboursement de dépense' : file.entityType === 'expense' ? ' · Justificatif de dépense' : ''}</small>{isProjectFile(file) ? <small>{sync.documents.find(item=>item.document_id===file.id)?.state==='synced'?'Synchronisé · Disponible hors ligne':'Sur cet appareil · Envoi en attente'}</small> : null}</span>
        </button>
        {expenseId && onOpenExpense ? <Button variant="ghost" onClick={() => onOpenExpense(expenseId)} aria-label={`Voir la dépense liée à ${file.originalName}`}>Voir la dépense</Button> : null}
        {customerCredit ? <Button variant="ghost" onClick={() => onOpenDocument('invoices', customerCredit)} aria-label={`Voir l’avoir lié à ${file.originalName}`}>Voir l’avoir</Button> : null}
        {!readOnly && isProjectFile(file) ? <Button size="icon" variant="ghost" disabled={saving || busy} aria-label={`Supprimer ${file.originalName}`} onClick={() => setRemoving(file)}><Trash2 size={17} /></Button> : null}
      </li>; })}</ul>
      {!contents.files.length && !files.length ? <p className="project-folder__empty">Aucun fichier ajouté à ce projet.</p> : null}
    </section> : null}
    {billingQuotes.length > 0 && (tab === 'all' || tab === 'invoices') ? <section className="panel project-folder__section"><header><h3>Dossiers de facturation</h3></header><ul className="project-document-list">{billingQuotes.map((quote) => <li key={quote.id}><button className="project-document-list__open" onClick={() => onOpenDocument('quotes', quote)}><FileText size={22}/><span><strong>{quote.number || quote.title}</strong><small>{contents.invoices.filter((invoice) => invoice.quoteId === quote.id).length} factures liées · {quote.title}</small></span></button></li>)}</ul></section> : null}
    {(['quotes', 'invoices'] as const).filter((kind) => tab === 'all' || tab === kind).map((kind) => <section className="panel project-folder__section" key={kind}>
      <header><h3>{kind === 'quotes' ? 'Devis' : 'Factures'}</h3><Button size="small" variant="secondary" disabled={readOnly || saving || busy} onClick={() => onCreateDocument(kind, project)}><Plus size={16} /> {kind === 'quotes' ? 'Nouveau devis' : 'Nouvelle facture'}</Button></header>
      <ul className="project-document-list">{contents[kind].map((document) => <li key={document.id}>
        <button type="button" className="project-document-list__open" onClick={() => onOpenDocument(kind, document)}>
          <FileText size={22} /><span><strong>{document.number || 'Brouillon'} · {document.title}</strong><small>{formatDate(document.issueDate)} · {formatMoney(documentTotals(document.lines).totalCents, document.currency)}</small></span><StatusBadge status={document.status} />
        </button>
      </li>)}</ul>
      {!contents[kind].length ? <p className="project-folder__empty">{kind === 'quotes' ? 'Les devis liés à ce projet apparaîtront ici.' : 'Les factures liées à ce projet apparaîtront ici.'}</p> : null}
    </section>)}
    {preview ? <ProjectFilePreview {...preview} onClose={closePreview} /> : null}
    {removing ? <Modal title="Supprimer le document ?" onClose={() => { if (!saving) setRemoving(null); }}>
      <p>« {removing.originalName} » sera retiré de ce projet. Si ce dossier est partagé, la suppression sera transmise aux autres appareils dès le retour du réseau.</p>
      <div className="form-actions"><Button variant="secondary" disabled={saving} onClick={() => setRemoving(null)}>Annuler</Button><Button variant="danger" disabled={saving} onClick={() => void remove()}>{saving ? 'Suppression…' : 'Supprimer'}</Button></div>
    </Modal> : null}
  </section>;
}
