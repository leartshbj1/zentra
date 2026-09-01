import { useMemo, useState } from 'react';
import { Archive, Banknote, Building2, CheckCircle2, Clock3, Mail, Pencil, Phone, Plus, RotateCcw, Search, WalletCards } from 'lucide-react';
import { desktopApi } from './bridge';
import {
  filterPurchaseExpenses,
  filterSuppliers,
  isExpenseOverdue,
  purchaseSummary,
  selectableSuppliers,
  supplierSnapshotForDraft,
  supplierDueDate,
  type PurchaseTab,
  type SupplierVisibility,
} from './purchases';
import { projectTerminology } from './terminology';
import type { Expense, Supplier, Workspace } from './types';
import { centsFromInput, formatDate, formatMoney, numberFromInput, todayIso } from './utils';
import { Button, EmptyState, Field, FormActions, Modal, SectionHeading, StatusBadge, submitForm } from './ui';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;

export function PurchasesScreen({
  workspace,
  query,
  onQueryChange,
  busy,
  onCreateExpense,
  onEditExpense,
  onArchiveExpense,
  onMarkPaid,
  onCreateSupplier,
  onEditSupplier,
  onArchiveSupplier,
  onRestoreSupplier,
}: {
  workspace: Workspace;
  query: string;
  onQueryChange: (query: string) => void;
  busy: boolean;
  onCreateExpense: () => void;
  onEditExpense: (expense: Expense) => void;
  onArchiveExpense: (expense: Expense) => void;
  onMarkPaid: (expense: Expense) => void;
  onCreateSupplier: () => void;
  onEditSupplier: (supplier: Supplier) => void;
  onArchiveSupplier: (supplier: Supplier) => void;
  onRestoreSupplier: (supplier: Supplier) => void;
}) {
  const [tab, setTab] = useState<PurchaseTab>('pending');
  const [supplierVisibility, setSupplierVisibility] = useState<SupplierVisibility>('active');
  const today = todayIso();
  const summary = useMemo(() => purchaseSummary(workspace.expenses, today), [workspace.expenses, today]);
  const expenses = useMemo(
    () => tab === 'suppliers' ? [] : filterPurchaseExpenses(workspace.expenses, workspace.projects, query, tab),
    [workspace.expenses, workspace.projects, query, tab],
  );
  const suppliers = useMemo(
    () => filterSuppliers(workspace.suppliers, query, supplierVisibility),
    [workspace.suppliers, query, supplierVisibility],
  );
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const expenseBlockReason = workspace.settings!.work.costCategories.length ? '' : 'Ajoutez d’abord une catégorie de coûts dans Paramètres.';

  return <div className="stack-layout purchases-screen">
    <div className="summary-strip purchase-summary" aria-label="Résumé des achats">
      <div><span>À payer · {summary.pendingCount}</span><strong>{formatMoney(summary.pendingCents)}</strong></div>
      <div><span>Échu · {summary.overdueCount}</span><strong className={summary.overdueCount ? 'is-negative' : ''}>{formatMoney(summary.overdueCents)}</strong></div>
      <div><span>Déjà payé · {summary.paidCount}</span><strong>{formatMoney(summary.paidCents)}</strong></div>
    </div>

    <section className="panel purchase-panel">
      <SectionHeading
        eyebrow="Données locales"
        title="Achats & fournisseurs"
        description="Suivez les achats saisis et leurs échéances. Aucun paiement bancaire n’est exécuté depuis cet écran."
        action={<Button disabled={tab !== 'suppliers' && Boolean(expenseBlockReason)} title={tab === 'suppliers' ? 'Ajouter un fournisseur' : expenseBlockReason || 'Enregistrer un achat'} onClick={tab === 'suppliers' ? onCreateSupplier : onCreateExpense}><Plus size={16} /> {tab === 'suppliers' ? 'Nouveau fournisseur' : 'Nouvel achat'}</Button>}
      />
      <div className="purchase-toolbar">
        <div className="tab-strip" role="tablist" aria-label="Sections des achats">
          <button type="button" role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? 'is-active' : ''} onClick={() => setTab('pending')}><Clock3 size={15} /> À payer <em>{summary.pendingCount}</em></button>
          <button type="button" role="tab" aria-selected={tab === 'paid'} className={tab === 'paid' ? 'is-active' : ''} onClick={() => setTab('paid')}><CheckCircle2 size={15} /> Payés <em>{summary.paidCount}</em></button>
          <button type="button" role="tab" aria-selected={tab === 'suppliers'} className={tab === 'suppliers' ? 'is-active' : ''} onClick={() => setTab('suppliers')}><Building2 size={15} /> Fournisseurs <em>{workspace.suppliers.filter((supplier) => !supplier.archivedAt).length}</em></button>
        </div>
        <label className="purchase-search"><Search size={15} /><span className="sr-only">Rechercher</span><input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={tab === 'suppliers' ? 'Nom, contact, IDE, IBAN…' : 'Fournisseur, projet, référence…'} /></label>
        {tab === 'suppliers' ? <label className="supplier-visibility"><span>État</span><select value={supplierVisibility} onChange={(event) => setSupplierVisibility(event.target.value as SupplierVisibility)}><option value="active">Actifs</option><option value="archived">Archivés</option><option value="all">Tous</option></select></label> : null}
      </div>

      {tab === 'suppliers' ? suppliers.length ? <div className="supplier-list" role="list">
        {suppliers.map((supplier) => <article className={`supplier-card ${supplier.archivedAt ? 'is-archived' : ''}`} key={supplier.id} role="listitem">
          <div className="supplier-card__icon"><Building2 size={19} /></div>
          <div className="supplier-card__identity"><div><strong>{supplier.name}</strong><StatusBadge status={supplier.archivedAt ? 'incomplete' : 'validated'} label={supplier.archivedAt ? 'Archivé' : 'Actif'} /></div><p>{supplier.contactName || 'Aucun contact renseigné'}</p>{supplier.address ? <small>{supplier.address}</small> : null}</div>
          <div className="supplier-card__contact">{supplier.email ? <a href={`mailto:${supplier.email}`}><Mail size={13} /> {supplier.email}</a> : <span>Pas d’e-mail</span>}{supplier.phone ? <a href={`tel:${supplier.phone}`}><Phone size={13} /> {supplier.phone}</a> : null}</div>
          <div className="supplier-card__terms"><span>Conditions</span><strong>{supplier.paymentTermsDays ? `${supplier.paymentTermsDays} jours` : 'Paiement immédiat'}</strong><small>{supplier.iban || 'IBAN non renseigné'}</small></div>
          <div className="supplier-card__actions"><Button variant="ghost" size="small" onClick={() => onEditSupplier(supplier)}><Pencil size={14} /> Modifier</Button>{supplier.archivedAt ? <Button variant="secondary" size="small" onClick={() => onRestoreSupplier(supplier)}><RotateCcw size={14} /> Réactiver</Button> : <Button variant="ghost" size="small" onClick={() => onArchiveSupplier(supplier)}><Archive size={14} /> Archiver</Button>}</div>
        </article>)}
      </div> : <EmptyState icon={<Building2 size={25} />} title={supplierVisibility === 'archived' ? 'Aucun fournisseur archivé' : 'Aucun fournisseur'} text={query.trim() ? 'Aucun fournisseur ne correspond à cette recherche.' : 'Ajoutez un fournisseur pour réutiliser ses coordonnées et ses conditions de paiement.'} actionLabel="Ajouter un fournisseur" onAction={onCreateSupplier} />
        : expenses.length ? <div className="table-panel purchase-table"><table><thead><tr><th>Date</th><th>Fournisseur</th><th>{terminology.singularTitle}</th><th>Catégorie</th><th>{tab === 'pending' ? 'Échéance' : 'Paiement'}</th><th>TTC</th><th>Statut</th><th aria-label="Actions" /></tr></thead><tbody>{expenses.map((expense) => {
          const project = workspace.projects.find((candidate) => candidate.id === expense.projectId);
          const overdue = isExpenseOverdue(expense, today);
          return <tr key={expense.id}><td>{formatDate(expense.date)}<small>{expense.reference || 'Sans référence'}</small></td><td><strong>{expense.supplier || 'Fournisseur non renseigné'}</strong><small>{expense.note || '—'}</small></td><td>{project?.name || `Aucun ${terminology.singular}`}</td><td><span className="category-pill">{expense.category || 'Non classé'}</span></td><td><strong className={overdue ? 'is-negative' : ''}>{tab === 'paid' && !expense.paidAt ? 'Date inconnue' : formatDate(tab === 'pending' ? expense.dueDate : expense.paidAt)}</strong></td><td><strong>{formatMoney(expense.totalCents)}</strong><small>TVA {formatMoney(expense.vatCents)}</small></td><td><StatusBadge status={overdue ? 'expired' : expense.paymentStatus === 'paid' ? 'paid' : 'draft'} label={overdue ? 'Échu' : expense.paymentStatus === 'paid' ? 'Payé' : 'À payer'} /></td><td><div className="row-actions">{expense.paymentStatus === 'pending' ? <Button variant="secondary" size="small" disabled={busy} onClick={() => onMarkPaid(expense)} title="Marquer payé aujourd’hui"><Banknote size={14} /> Marquer payé</Button> : null}<Button variant="ghost" size="icon" onClick={() => onEditExpense(expense)} title="Modifier" aria-label={`Modifier l’achat ${expense.supplier}`}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchiveExpense(expense)} title="Supprimer" aria-label={`Supprimer l’achat ${expense.supplier}`}><Archive size={15} /></Button></div></td></tr>;
        })}</tbody></table></div> : <EmptyState icon={tab === 'pending' ? <Clock3 /> : <CheckCircle2 />} title={query.trim() ? 'Aucun résultat' : tab === 'pending' ? 'Aucun achat à payer' : 'Aucun achat payé'} text={query.trim() ? 'Aucun achat ne correspond à cette recherche.' : expenseBlockReason || (tab === 'pending' ? 'Les achats enregistrés comme à payer apparaîtront ici avec leur échéance.' : 'Les dépenses existantes et les achats marqués payés apparaissent ici.')} actionLabel={expenseBlockReason ? undefined : 'Enregistrer un achat'} onAction={expenseBlockReason ? undefined : onCreateExpense} />}
    </section>
  </div>;
}

export function SupplierForm({ item, busy, close, act }: { item?: Supplier; busy: boolean; close: () => void; act: ActionRunner }) {
  return <Modal title={item ? `Modifier ${item.name}` : 'Nouveau fournisseur'} description="Ces coordonnées restent dans la base locale Elyko et servent à accélérer la saisie des achats." onClose={close} wide>
    <form onSubmit={submitForm(async (form) => {
      const data = {
        name: String(form.get('name')).trim(),
        contactName: String(form.get('contactName')).trim(),
        email: String(form.get('email')).trim(),
        phone: String(form.get('phone')).trim(),
        address: String(form.get('address')).trim(),
        uidNumber: String(form.get('uidNumber')).trim(),
        iban: String(form.get('iban')).trim(),
        currency: 'CHF',
        paymentTermsDays: Math.round(numberFromInput(form.get('paymentTermsDays'))),
        notes: String(form.get('notes')).trim(),
      };
      await act(
        () => item ? desktopApi.updateEntity('suppliers', item.id, data) : desktopApi.createEntity('suppliers', data),
        item ? 'Le fournisseur a été mis à jour.' : 'Le fournisseur a été ajouté.',
      );
    })}>
      <div className="form-grid">
        <Field label="Raison sociale / nom" required wide><input name="name" defaultValue={item?.name} maxLength={200} required autoFocus /></Field>
        <Field label="Personne de contact"><input name="contactName" defaultValue={item?.contactName} maxLength={200} /></Field>
        <Field label="E-mail"><input name="email" type="email" defaultValue={item?.email} maxLength={254} /></Field>
        <Field label="Téléphone"><input name="phone" type="tel" defaultValue={item?.phone} maxLength={80} /></Field>
        <Field label="Numéro IDE"><input name="uidNumber" defaultValue={item?.uidNumber} maxLength={80} /></Field>
        <Field label="Adresse" wide><textarea name="address" rows={3} defaultValue={item?.address} maxLength={1_000} /></Field>
        <Field label="IBAN CH / LI" hint="Facultatif; il n’est utilisé pour aucun paiement automatique."><input name="iban" defaultValue={item?.iban} autoCapitalize="characters" /></Field>
        <Field label="Devise"><output className="field-output">CHF</output></Field>
        <Field label="Délai de paiement (jours)" required><input name="paymentTermsDays" type="number" min="0" step="1" defaultValue={item?.paymentTermsDays ?? 30} required /></Field>
        <Field label="Notes internes" wide><textarea name="notes" rows={3} defaultValue={item?.notes} maxLength={10_000} /></Field>
      </div>
      {item?.archivedAt ? <div className="info-strip"><Archive size={17} /><span>Ce fournisseur est archivé. Il reste visible dans l’historique, mais n’est plus proposé pour les nouveaux achats.</span></div> : null}
      <FormActions onCancel={close} busy={busy} submitLabel={item ? 'Enregistrer les modifications' : 'Ajouter le fournisseur'} />
    </form>
  </Modal>;
}

export function ExpenseForm({ item, workspace, busy, close, act }: { item?: Expense; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const settings = workspace.settings!;
  const terminology = projectTerminology(settings.business.nogaSection);
  const linkedSupplier = item?.supplierId ? workspace.suppliers.find((supplier) => supplier.id === item.supplierId) : undefined;
  const supplierChoices = selectableSuppliers(workspace.suppliers, item?.supplierId);
  const initialDate = item?.date || todayIso();
  const initialStatus = item?.paymentStatus ?? 'pending';
  const [supplierChoice, setSupplierChoice] = useState(item?.supplierId && linkedSupplier ? item.supplierId : item?.supplier ? '__manual__' : '');
  const [manualSupplier, setManualSupplier] = useState(item?.supplier ?? '');
  const [expenseDate, setExpenseDate] = useState(initialDate);
  const [paymentStatus, setPaymentStatus] = useState<Expense['paymentStatus']>(initialStatus);
  const [dueDate, setDueDate] = useState(item?.dueDate ?? (initialStatus === 'pending' ? supplierDueDate(initialDate, linkedSupplier, settings.billing.paymentTermsDays) : ''));
  const [paidAt, setPaidAt] = useState(item?.paidAt ?? (initialStatus === 'paid' && !item ? todayIso() : ''));
  const [netCents, setNetCents] = useState(item?.netCents ?? 0);
  const [vatCents, setVatCents] = useState(item?.vatCents ?? 0);
  const legacyPaidWithoutDate = Boolean(item?.paymentStatus === 'paid' && !item.paidAt);
  const expenseCategories = item?.category && !settings.work.costCategories.includes(item.category) ? [item.category, ...settings.work.costCategories] : settings.work.costCategories;

  function chooseSupplier(value: string) {
    setSupplierChoice(value);
    const supplier = supplierChoices.find((candidate) => candidate.id === value);
    if (supplier && paymentStatus === 'pending') setDueDate(supplierDueDate(expenseDate, supplier, settings.billing.paymentTermsDays));
  }

  function choosePaymentStatus(value: Expense['paymentStatus']) {
    setPaymentStatus(value);
    if (value === 'paid') setPaidAt((current) => current || todayIso());
    else {
      setPaidAt('');
      const supplier = supplierChoices.find((candidate) => candidate.id === supplierChoice);
      setDueDate((current) => current || supplierDueDate(expenseDate, supplier, settings.billing.paymentTermsDays));
    }
  }

  return <Modal title={item ? 'Modifier l’achat' : 'Nouvel achat'} description="Saisissez les montants réels. Le fournisseur, l’échéance et l’état de paiement restent explicites." onClose={close} wide>
    <form onSubmit={submitForm(async (form) => {
      const selectedSupplier = supplierChoices.find((supplier) => supplier.id === supplierChoice);
      const supplierSnapshot = supplierSnapshotForDraft(item, selectedSupplier, manualSupplier);
      if (!supplierSnapshot) return;
      const data = {
        projectId: String(form.get('projectId')) || null,
        supplierId: selectedSupplier?.id ?? null,
        date: expenseDate,
        dueDate: dueDate || null,
        supplier: supplierSnapshot,
        category: String(form.get('category')),
        reference: String(form.get('reference')).trim(),
        currency: 'CHF',
        netCents,
        vatCents,
        totalCents: netCents + vatCents,
        paymentStatus,
        paidAt: paymentStatus === 'paid' ? paidAt : null,
        reimbursable: form.get('reimbursable') === 'yes',
        note: String(form.get('note')).trim(),
      };
      await act(
        () => item ? desktopApi.updateEntity('expenses', item.id, data) : desktopApi.createEntity('expenses', data),
        item ? 'L’achat a été mis à jour.' : 'L’achat a été enregistré.',
      );
    })}>
      <div className="form-grid">
        <Field label="Fournisseur" required wide><select value={supplierChoice} onChange={(event) => chooseSupplier(event.target.value)} required autoFocus><option value="">Choisir un fournisseur</option>{supplierChoices.map((supplier) => <option value={supplier.id} key={supplier.id}>{supplier.name}{supplier.archivedAt ? ' · archivé (historique)' : ''}</option>)}<option value="__manual__">Saisie libre / fournisseur non enregistré</option></select></Field>
        {supplierChoice === '__manual__' ? <Field label="Nom du fournisseur à conserver" required wide hint="Ce texte restera le snapshot de cette dépense."><input value={manualSupplier} onChange={(event) => setManualSupplier(event.target.value)} maxLength={500} required /></Field> : null}
        <Field label={terminology.singularTitle} wide hint="Facultatif; lie l’achat à sa rentabilité."><select name="projectId" defaultValue={item?.projectId ?? ''}><option value="">Aucun {terminology.singular}</option>{workspace.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field>
        <Field label="Date de l’achat" required><input type="date" value={expenseDate} onChange={(event) => { const nextDate = event.target.value; setExpenseDate(nextDate); if (!item && paymentStatus === 'pending') { const supplier = supplierChoices.find((candidate) => candidate.id === supplierChoice); setDueDate(supplierDueDate(nextDate, supplier, settings.billing.paymentTermsDays)); } }} required /></Field>
        <Field label="État du paiement" required><select value={paymentStatus} onChange={(event) => choosePaymentStatus(event.target.value as Expense['paymentStatus'])} required><option value="pending">À payer</option><option value="paid">Déjà payé</option></select></Field>
        {paymentStatus === 'pending' ? <Field label="Échéance" required><input type="date" min={expenseDate} value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></Field> : <Field label="Date de paiement" required={!legacyPaidWithoutDate} hint={legacyPaidWithoutDate ? 'Date inconnue sur cette ancienne dépense; laissez vide pour préserver l’historique.' : undefined}><input type="date" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} required={!legacyPaidWithoutDate} /></Field>}
        <Field label="Catégorie" required><select name="category" defaultValue={item?.category} required><option value="">Choisir une catégorie</option>{expenseCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></Field>
        <Field label="Référence"><input name="reference" defaultValue={item?.reference} maxLength={200} /></Field>
        <Field label="Remboursable ?" required><select name="reimbursable" defaultValue={item ? item.reimbursable ? 'yes' : 'no' : 'no'} required><option value="no">Non, charge de l’entreprise</option><option value="yes">Oui, à rembourser</option></select></Field>
        <Field label="Montant net (CHF)" required><input type="number" min="0" step="0.01" value={netCents ? netCents / 100 : ''} onChange={(event) => setNetCents(centsFromInput(event.target.value))} required /></Field>
        <Field label="Montant TVA (CHF)" required><input type="number" min="0" step="0.01" value={vatCents / 100} onChange={(event) => setVatCents(centsFromInput(event.target.value))} required /></Field>
        <Field label="Total calculé"><output className="field-output">{formatMoney(netCents + vatCents)}</output></Field>
        <Field label="Note" wide><textarea name="note" rows={3} defaultValue={item?.note} maxLength={2_000} /></Field>
      </div>
      <div className="info-strip"><WalletCards size={17} /><span>Marquer un achat payé ne déclenche une écriture que si la comptabilité locale est activée. Aucun ordre bancaire n’est envoyé.</span></div>
      <FormActions onCancel={close} busy={busy} submitLabel={item ? 'Enregistrer les modifications' : 'Enregistrer l’achat'} />
    </form>
  </Modal>;
}
