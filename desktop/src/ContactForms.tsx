import { knownErrorIncident, withKnownErrorIncident } from './diagnostics';
import type { WorkspaceMutationOrigin } from './workspaceMemberOrigin';
import { useRef, useState, type FormEvent } from 'react';
import type { Client, Supplier, Workspace } from './types';
import { desktopApi } from './bridge';
import { Button, Field, FormActions, Modal } from './ui';
import { createId, errorMessage } from './utils';
import { contactCountries, contactFormIssue, contactNativeIssue, type ContactIssue, type ContactValues } from './contactFormValidation';
import './contact-forms.css';
import { ErrorDetails, ErrorGuidance } from './ErrorGuidance';
import { t, useAppLanguage, type AppLanguage } from './language';
import { WorkspaceCreationOutcomeUnknownError } from './workspaceCreation';
import { draftText, FormDraftNotice } from './useFormDraft';
import { useNativeFormDraft } from './useNativeFormDraft';
import { formDraftFingerprint } from './formDrafts';

type ActionRunner = (action: (origin: WorkspaceMutationOrigin) => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
type CommonProps = { workspace?: Workspace; busy: boolean; readOnly?: boolean; close: () => void; act: ActionRunner };
const contactDraftFields = ['name', 'contactPerson', 'company', 'contactName', 'email', 'phone', 'street', 'buildingNumber', 'postalCode', 'city', 'canton', 'country', 'countryCustom', 'address', 'uidNumber', 'iban', 'paymentTermsDays', 'notes'] as const;

const creationUuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const creationDraftFields = [...contactDraftFields, 'creationId'];
const validCreationContactDraft = (value: Record<string, string>) => value.creationId === undefined || creationUuid.test(value.creationId);
const CONTACT_CREATION_UNCONFIRMED = 'La création du contact n’est pas confirmée.';
// Keep local recovery state independent from the current display language.
const CONTACT_LOCAL_DRAFT_UNSAVED = 'contact-local-draft-unsaved';
const contactCreationRecovery: Record<AppLanguage, { title: string; message: string; instruction: string; legacy: string; prepare: string; storage: string }> = {
  fr: {
    title: 'Création du contact à vérifier',
    message: 'La création de cette fiche n’a pas été confirmée. Votre saisie est conservée.',
    instruction: 'Vérifiez la liste des clients ou fournisseurs avant de réessayer. Si la fiche existe déjà, ouvrez-la pour la contrôler ou la modifier.',
    legacy: 'Ce brouillon ancien ne permet pas de retrouver une précédente création. Vérifiez la liste des clients ou fournisseurs avant de préparer une nouvelle fiche.',
    prepare: 'Préparer une nouvelle fiche',
    storage: 'Cette nouvelle fiche ne peut pas être conservée sur cet appareil. Réessayez sa sauvegarde locale avant de l’enregistrer.',
  },
  de: {
    title: 'Kontakterstellung prüfen',
    message: 'Die Erstellung dieses Kontakts wurde nicht bestätigt. Ihre Eingaben bleiben gespeichert.',
    instruction: 'Prüfen Sie die Kunden- oder Lieferantenliste, bevor Sie es erneut versuchen. Falls der Kontakt bereits vorhanden ist, öffnen Sie ihn zum Prüfen oder Bearbeiten.',
    legacy: 'Dieser ältere Entwurf kann einer früheren Erstellung nicht zugeordnet werden. Prüfen Sie die Kunden- oder Lieferantenliste, bevor Sie einen neuen Kontakt vorbereiten.',
    prepare: 'Neuen Kontakt vorbereiten',
    storage: 'Dieser neue Kontakt kann auf diesem Gerät nicht gespeichert werden. Versuchen Sie zuerst, den lokalen Entwurf erneut zu speichern.',
  },
  it: {
    title: 'Verifica la creazione del contatto',
    message: 'La creazione di questa scheda non è stata confermata. I dati inseriti sono conservati.',
    instruction: 'Controlla l’elenco dei clienti o fornitori prima di riprovare. Se la scheda esiste già, aprila per verificarla o modificarla.',
    legacy: 'Questa vecchia bozza non permette di identificare una creazione precedente. Controlla l’elenco dei clienti o fornitori prima di preparare una nuova scheda.',
    prepare: 'Prepara una nuova scheda',
    storage: 'Questa nuova scheda non può essere conservata sul dispositivo. Riprova a salvare la bozza locale prima di registrarla.',
  },
  en: {
    title: 'Check the contact creation',
    message: 'The creation of this contact has not been confirmed. Your entries are retained.',
    instruction: 'Check the customer or supplier list before trying again. If the contact already exists, open it to review or edit it.',
    legacy: 'This older draft cannot identify a previous creation. Check the customer or supplier list before preparing a new contact.',
    prepare: 'Prepare a new contact',
    storage: 'This new contact cannot be retained on this device. Retry saving the local draft before creating it.',
  },
};

function ContactForm({ kind, item: suppliedItem, workspace, busy, readOnly = false, close, act }: CommonProps & { kind: 'client' | 'supplier'; item?: Client | Supplier }) {
  const recovery = contactCreationRecovery[useAppLanguage()];
  const [creationId] = useState(() => suppliedItem ? undefined : createId());
  const current = suppliedItem && workspace ? (kind === 'client' ? workspace.clients : workspace.suppliers).find(row => row.id === suppliedItem.id) : suppliedItem;
  const item = current ?? suppliedItem;
  const client = kind === 'client' ? item as Client | undefined : undefined;
  const supplier = kind === 'supplier' ? item as Supplier | undefined : undefined;
  const [country, setCountry] = useState(client?.country?.toUpperCase() || (item ? '' : 'CH'));
  const [terms, setTerms] = useState(String(supplier?.paymentTermsDays ?? 30));
  const [issue, setIssue] = useState<ContactIssue | null>(null), [failure, setFailure] = useState('');
  const failureReference = useRef<unknown>(undefined);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false), formRef = useRef<HTMLFormElement>(null), alertRef = useRef<HTMLDivElement>(null);
  const persisted = useNativeFormDraft({ workspace, type: kind, recordId: item?.id, fingerprint: current ? formDraftFingerprint(current) : item ? 'missing' : 'new', form: formRef, fields: item ? contactDraftFields : creationDraftFields, initial: creationId ? { creationId } : {}, validateValue: item ? undefined : validCreationContactDraft,
    controlled: ['country', 'paymentTermsDays'], onRestore: values => { setCountry(values?.country ?? client?.country?.toUpperCase() ?? (item ? '' : 'CH')); setTerms(values?.paymentTermsDays ?? String(supplier?.paymentTermsDays ?? 30)); if (values === null && !item) close(); } });
  const closeForm = () => persisted.close(close);
  const draftBlocked = !!persisted.pending || persisted.conflict || persisted.invalid || !!(suppliedItem && workspace && !current);
  const legacyCreation = !item && !persisted.value.creationId;
  const locked = busy || saving;
  const prepareNewLegacyCreation = () => {
    if (!legacyCreation || !creationId || locked || readOnly || draftBlocked) return;
    // Preserve the restored fields. Attaching a fresh identity requires this explicit choice.
    persisted.capture({ creationId });
    failureReference.current = undefined; setFailure(''); setIssue(null);
  };
  const title = kind === 'client' ? t(item ? 'Modifier le client' : 'Nouveau client') : item ? t('Modifier {name}', { name: item.name }) : t('Nouveau fournisseur');
  function reveal(next: ContactIssue | null) {
    setIssue(next);
    requestAnimationFrame(() => {
      const element = next ? formRef.current?.elements.namedItem(next.field) as HTMLElement | null : alertRef.current;
      const field = element?.closest<HTMLElement>('.field') || element;
      const actionsHeight = formRef.current?.querySelector('.form-actions')?.getBoundingClientRect().height || 0;
      if (field) field.style.scrollMarginBlockEnd = `${actionsHeight + 20}px`;
      element?.focus({ preventScroll: true }); field?.scrollIntoView({ block: 'center' });
    });
  }
  const invalid = (field: string) => issue?.field === field ? issue.message : undefined;
  const inputProps = (field: string) => ({ name: field, 'aria-invalid': issue?.field === field || undefined });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || readOnly || inFlight.current || draftBlocked || legacyCreation) return;
    const originWorkspaceScope = workspace?.workNotesScope;
    const values = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, String(value).trim()])) as ContactValues;
    failureReference.current = undefined; setFailure('');
    const invalid = contactFormIssue(kind, values);
    if (invalid) { reveal(invalid); return; }
    // Persist the exact current form and creation UUID, including a final unrendered keystroke.
    // A failed write or readback must stop native creation before any invocation.
    const captured = !item ? persisted.capture() : undefined;
    if (captured && (captured.storageError || captured.pending || captured.invalid || captured.conflict || !creationUuid.test(captured.value.creationId || ''))) {
      failureReference.current = undefined; setFailure(CONTACT_LOCAL_DRAFT_UNSAVED); reveal(null); return;
    }
    setIssue(null); inFlight.current = true; setSaving(true);
    const data = kind === 'client' ? {
      name: values.company || values.contactPerson, company: values.company, contactPerson: values.contactPerson,
      email: values.email, phone: values.phone, addressLine1: values.street, addressLine2: values.buildingNumber,
      postalCode: values.postalCode, city: values.city, canton: values.canton,
      country: (values.country === '__other' ? values.countryCustom : values.country).toUpperCase(), notes: values.notes,
    } : {
      name: values.name, contactName: values.contactName, email: values.email, phone: values.phone,
      address: values.address, uidNumber: values.uidNumber, iban: values.iban,
      currency: 'CHF', paymentTermsDays: Number(values.paymentTermsDays), notes: values.notes,
    };
    const entity = kind === 'client' ? 'clients' : 'suppliers';
    const refused = (reason: unknown) => {
      const message = errorMessage(reason, 'L’enregistrement n’a pas abouti. Votre saisie est conservée.');
      failureReference.current = reason; setFailure(message); reveal(contactNativeIssue(kind, message));
    };
    try { const saved = await act((mutationOrigin) => item ? desktopApi.updateEntity(entity, item.id, data, originWorkspaceScope, mutationOrigin.memberContextNonce) : desktopApi.createEntity(entity, { ...data, id: captured!.value.creationId }, originWorkspaceScope, mutationOrigin.memberContextNonce).catch(reason => {
      if (reason instanceof WorkspaceCreationOutcomeUnknownError) {
        // A row sharing the UUID may belong to an older corrected attempt.
        // Ordinary unknown errors retain the draft; they cannot use act's ID-only confirmation.
        throw withKnownErrorIncident(new Error(CONTACT_CREATION_UNCONFIRMED, { cause: reason }), reason);
      }
      throw reason;
    }), kind === 'client' ? item ? 'Le client a été mis à jour.' : 'Le client a été ajouté.' : item ? 'Le fournisseur a été mis à jour.' : 'Le fournisseur a été ajouté.', true, refused); persisted.complete(saved); }
    catch (reason) { refused(reason); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal title={title} description={t(kind === 'client' ? 'Le destinataire et son adresse de facturation. Le téléphone et l’e-mail sont facultatifs.' : 'Le nom du fournisseur suffit pour commencer. Complétez ses coordonnées quand vous les avez.')} onClose={closeForm} dismissible={!locked} className="contact-form-modal" wide>
    <form ref={formRef} noValidate onSubmit={submit} onChange={event => { if (!readOnly && !locked && !draftBlocked) persisted.capture(); if (event.target.getAttribute('name') === issue?.field) setIssue(null); }}>
      {!readOnly && <FormDraftNotice draft={persisted} disabled={locked} currentValues={item ? [{ label: t("Nom"), value: item.name }, { label: t("E-mail"), value: item.email }, { label: t("Téléphone"), value: item.phone }, { label: t("Adresse"), value: item.address }, { label: t("Notes"), value: item.notes }] : undefined} />}
      {legacyCreation && !persisted.pending && !readOnly && <div className="contact-form-failure" role="status"><p>{recovery.legacy}</p><Button type="button" disabled={locked || draftBlocked || !creationId} onClick={prepareNewLegacyCreation}>{recovery.prepare}</Button></div>}
      <fieldset disabled={locked || readOnly || draftBlocked || legacyCreation}>
        <section className="contact-form-section"><h3>{t(kind === 'client' ? 'Qui est votre client ?' : 'Qui est le fournisseur ?')}</h3>
          <p>{t(kind === 'client' ? 'Renseignez un contact, une entreprise, ou les deux.' : 'Reprenez les informations de sa facture ou de son devis.')}</p>
          <div className="form-grid">
            {kind === 'client' ? <><Field label={t("Nom du contact")} hint={t("Pour un particulier : prénom et nom.")} error={invalid('contactPerson')}><input {...inputProps('contactPerson')} defaultValue={client?.contactPerson ?? client?.name} autoComplete="name" autoFocus /></Field><Field label={t("Entreprise")}><input name="company" defaultValue={client?.company} autoComplete="organization" /></Field></> : <><Field label={t("Raison sociale / nom")} required wide error={invalid('name')}><input {...inputProps('name')} defaultValue={supplier?.name} maxLength={200} autoComplete="organization" autoFocus /></Field><Field label={t("Personne de contact")} error={invalid('contactName')}><input {...inputProps('contactName')} defaultValue={supplier?.contactName} maxLength={200} autoComplete="name" /></Field></>}
            <Field label={t("E-mail")} error={invalid('email')}><input {...inputProps('email')} type="email" defaultValue={item?.email} maxLength={254} autoComplete="email" /></Field>
            <Field label={t("Téléphone")} error={invalid('phone')}><input {...inputProps('phone')} type="tel" defaultValue={item?.phone} maxLength={80} autoComplete="tel" /></Field>
          </div>
        </section>
        <section className="contact-form-section"><h3>{t(kind === 'client' ? 'Où envoyer les documents ?' : 'Adresse et identification')}</h3><p>{t(kind === 'client' ? 'Cette adresse apparaîtra sur les nouveaux devis et factures.' : 'Ces informations sont facultatives et restent modifiables.')}</p>
          <div className="form-grid">
            {kind === 'client' ? <>
              <Field label={t("Rue / case postale")} required wide error={invalid('street')}><input {...inputProps('street')} defaultValue={client?.addressLine1} autoComplete="address-line1" /></Field>
              <Field label={t("Numéro de bâtiment")} error={invalid('buildingNumber')}><input {...inputProps('buildingNumber')} defaultValue={client?.buildingNumber ?? client?.addressLine2} /></Field>
              <Field label={t("NPA")} required error={invalid('postalCode')}><input {...inputProps('postalCode')} defaultValue={client?.postalCode} autoComplete="postal-code" /></Field>
              <Field label={t("Localité")} required error={invalid('city')}><input {...inputProps('city')} defaultValue={client?.city} autoComplete="address-level2" /></Field>
              <Field label={t("Canton / région")}><input name="canton" defaultValue={client?.canton} autoComplete="address-level1" /></Field>
              <Field label={t("Pays")} required error={invalid('country')}><select {...inputProps('country')} value={country} onChange={event => setCountry(event.target.value)}><option value="">{t('Choisir le pays')}</option>{contactCountries.map(([code, label]) => <option key={code} value={code}>{t(label)}</option>)}{country !== '__other' && country && !contactCountries.some(([code]) => code === country) && <option value={country}>{t('{country} · pays de la fiche', { country })}</option>}<option value="__other">{t('Autre pays…')}</option></select></Field>
              {country === '__other' && <Field label={t("Code du pays")} required hint={t("Deux lettres : ES pour l’Espagne, PT pour le Portugal…")} error={invalid('countryCustom')}><input {...inputProps('countryCustom')} autoCapitalize="characters" maxLength={2} /></Field>}
            </> : <><Field label={t("Adresse")} wide error={invalid('address')}><textarea {...inputProps('address')} rows={3} defaultValue={supplier?.address} maxLength={1_000} autoComplete="street-address" /></Field><Field label={t("Numéro IDE")} hint={t("Facultatif. Reprenez le numéro d’identification de l’entreprise.")} error={invalid('uidNumber')}><input {...inputProps('uidNumber')} defaultValue={supplier?.uidNumber} maxLength={80} /></Field></>}
          </div>
        </section>
        {kind === 'supplier' && <section className="contact-form-section"><h3>{t('Comment régler ses factures ?')}</h3><p>{t('Ces réglages préremplissent les nouveaux achats. Aucun virement n’est envoyé depuis cette fiche.')}</p><div className="form-grid">
          <Field label={t("IBAN CH / LI")} wide hint={t("Facultatif. Vous pouvez le compléter plus tard.")} error={invalid('iban')}><input {...inputProps('iban')} defaultValue={supplier?.iban} autoCapitalize="characters" spellCheck={false} /></Field>
          <Field label={t("Délai de paiement (jours)")} required error={invalid('paymentTermsDays')} hint={t("Nombre de jours après la date de facture.")}><input {...inputProps('paymentTermsDays')} inputMode="numeric" value={terms} onChange={event => setTerms(event.target.value)} /></Field><Field label={t("Devise")}><output className="field-output">CHF · {t('franc suisse')}</output></Field>
        </div><div className="contact-form-choices" role="group" aria-label={t('Délais habituels')}>{[0, 10, 30, 60].map(days => <Button type="button" variant="secondary" key={days} aria-pressed={terms === String(days)} onClick={() => { setTerms(String(days)); persisted.capture({ paymentTermsDays: String(days) }); if (issue?.field === 'paymentTermsDays') setIssue(null); }}>{days ? t('{days} jours', { days }) : t('Immédiat')}</Button>)}</div></section>}
        <section className="contact-form-section"><Field label={t("Notes internes")} wide hint={t("Conservées dans la fiche, sans ajout automatique aux documents.")} error={invalid('notes')}><textarea {...inputProps('notes')} rows={3} defaultValue={item?.notes} maxLength={10_000} /></Field></section>
        {item?.archivedAt && <p className="info-strip">{t('Cette fiche est archivée. La modifier ne la réactive pas et son historique est conservé.')}</p>}
      </fieldset>
      {failure && <div ref={alertRef} className="contact-form-failure" tabIndex={-1}><>{failure === CONTACT_CREATION_UNCONFIRMED
        ? <div className="error-panel error-guidance error-guidance--compact"><div role="alert" data-contact-creation-recovery><strong>{recovery.title}</strong><p>{recovery.message}</p><p className="error-guidance__recovery">{recovery.instruction}</p></div><ErrorDetails error={failureReference.current ?? failure} /></div>
        : failure === CONTACT_LOCAL_DRAFT_UNSAVED
          ? <div className="error-panel error-guidance error-guidance--compact"><div role="alert" data-contact-storage-recovery><strong>{draftText('La saisie locale ne peut pas être conservée')}</strong><p>{recovery.storage}</p></div><div className="error-guidance__actions"><Button type="button" variant="secondary" size="small" disabled={locked || readOnly} onClick={() => { const captured = persisted.capture(); if (!captured.storageError && !captured.pending && !captured.invalid && !captured.conflict) { failureReference.current = undefined; setFailure(''); setIssue(null); } }}>{draftText('Réessayer la sauvegarde locale')}</Button></div></div>
          : <ErrorGuidance error={failure} incidentCode={knownErrorIncident(failureReference.current)?.code} operation="mutation" compact />}</></div>}
      <FormActions onCancel={closeForm} busy={locked} disabled={readOnly || draftBlocked || legacyCreation || !item && persisted.storageError} submitLabel={kind === 'client' ? 'Enregistrer' : item ? 'Enregistrer les modifications' : 'Ajouter le fournisseur'} />
    </form>
  </Modal>;
}
export function ClientForm(props: CommonProps & { item?: Client }) { return <ContactForm {...props} kind="client" />; }
export function SupplierForm(props: CommonProps & { item?: Supplier }) { return <ContactForm {...props} kind="supplier" />; }
