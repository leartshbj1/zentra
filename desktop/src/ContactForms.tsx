import { useRef, useState, type FormEvent } from 'react';
import type { Client, Supplier, Workspace } from './types';
import { desktopApi } from './bridge';
import { Button, Field, FormActions, Modal } from './ui';
import { errorMessage } from './utils';
import { contactCountries, contactFormIssue, contactNativeIssue, type ContactIssue, type ContactValues } from './contactFormValidation';
import './contact-forms.css';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void) => Promise<boolean>;
type CommonProps = { busy: boolean; readOnly?: boolean; close: () => void; act: ActionRunner };

function ContactForm({ kind, item, busy, readOnly = false, close, act }: CommonProps & { kind: 'client' | 'supplier'; item?: Client | Supplier }) {
  const client = kind === 'client' ? item as Client | undefined : undefined;
  const supplier = kind === 'supplier' ? item as Supplier | undefined : undefined;
  const [country, setCountry] = useState(client?.country?.toUpperCase() || (item ? '' : 'CH'));
  const [terms, setTerms] = useState(String(supplier?.paymentTermsDays ?? 30));
  const [issue, setIssue] = useState<ContactIssue | null>(null), [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false), formRef = useRef<HTMLFormElement>(null), alertRef = useRef<HTMLDivElement>(null);
  const locked = busy || saving;
  const title = kind === 'client' ? item ? 'Modifier le client' : 'Nouveau client' : item ? `Modifier ${item.name}` : 'Nouveau fournisseur';
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
    if (locked || readOnly || inFlight.current) return;
    const values = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, String(value).trim()])) as ContactValues;
    setFailure('');
    const invalid = contactFormIssue(kind, values);
    if (invalid) { reveal(invalid); return; }
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
      setFailure(message); reveal(contactNativeIssue(kind, message));
    };
    try { await act(() => item ? desktopApi.updateEntity(entity, item.id, data) : desktopApi.createEntity(entity, data), kind === 'client' ? item ? 'Le client a été mis à jour.' : 'Le client a été ajouté.' : item ? 'Le fournisseur a été mis à jour.' : 'Le fournisseur a été ajouté.', true, refused); }
    catch (reason) { refused(reason); }
    finally { inFlight.current = false; setSaving(false); }
  }
  return <Modal title={title} description={kind === 'client' ? 'Le destinataire et son adresse de facturation. Le téléphone et l’e-mail sont facultatifs.' : 'Le nom du fournisseur suffit pour commencer. Complétez ses coordonnées quand vous les avez.'} onClose={close} dismissible={!locked} className="contact-form-modal" wide>
    <form ref={formRef} noValidate onSubmit={submit} onChange={event => { if (event.target.getAttribute('name') === issue?.field) setIssue(null); }}>
      <fieldset disabled={locked || readOnly}>
        <section className="contact-form-section"><h3>{kind === 'client' ? 'Qui est votre client ?' : 'Qui est le fournisseur ?'}</h3>
          <p>{kind === 'client' ? 'Renseignez un contact, une entreprise, ou les deux.' : 'Reprenez les informations de sa facture ou de son devis.'}</p>
          <div className="form-grid">
            {kind === 'client' ? <><Field label="Nom du contact" hint="Pour un particulier : prénom et nom." error={invalid('contactPerson')}><input {...inputProps('contactPerson')} defaultValue={client?.contactPerson ?? client?.name} autoComplete="name" autoFocus /></Field><Field label="Entreprise"><input name="company" defaultValue={client?.company} autoComplete="organization" /></Field></> : <><Field label="Raison sociale / nom" required wide error={invalid('name')}><input {...inputProps('name')} defaultValue={supplier?.name} maxLength={200} autoComplete="organization" autoFocus /></Field><Field label="Personne de contact" error={invalid('contactName')}><input {...inputProps('contactName')} defaultValue={supplier?.contactName} maxLength={200} autoComplete="name" /></Field></>}
            <Field label="E-mail" error={invalid('email')}><input {...inputProps('email')} type="email" defaultValue={item?.email} maxLength={254} autoComplete="email" /></Field>
            <Field label="Téléphone" error={invalid('phone')}><input {...inputProps('phone')} type="tel" defaultValue={item?.phone} maxLength={80} autoComplete="tel" /></Field>
          </div>
        </section>
        <section className="contact-form-section"><h3>{kind === 'client' ? 'Où envoyer les documents ?' : 'Adresse et identification'}</h3><p>{kind === 'client' ? 'Cette adresse apparaîtra sur les nouveaux devis et factures.' : 'Ces informations sont facultatives et restent modifiables.'}</p>
          <div className="form-grid">
            {kind === 'client' ? <>
              <Field label="Rue / case postale" required wide error={invalid('street')}><input {...inputProps('street')} defaultValue={client?.addressLine1} autoComplete="address-line1" /></Field>
              <Field label="Numéro de bâtiment" error={invalid('buildingNumber')}><input {...inputProps('buildingNumber')} defaultValue={client?.buildingNumber ?? client?.addressLine2} /></Field>
              <Field label="NPA" required error={invalid('postalCode')}><input {...inputProps('postalCode')} defaultValue={client?.postalCode} autoComplete="postal-code" /></Field>
              <Field label="Localité" required error={invalid('city')}><input {...inputProps('city')} defaultValue={client?.city} autoComplete="address-level2" /></Field>
              <Field label="Canton / région"><input name="canton" defaultValue={client?.canton} autoComplete="address-level1" /></Field>
              <Field label="Pays" required error={invalid('country')}><select {...inputProps('country')} value={country} onChange={event => setCountry(event.target.value)}><option value="">Choisir le pays</option>{contactCountries.map(([code, label]) => <option key={code} value={code}>{label}</option>)}{country !== '__other' && country && !contactCountries.some(([code]) => code === country) && <option value={country}>{country} · pays de la fiche</option>}<option value="__other">Autre pays…</option></select></Field>
              {country === '__other' && <Field label="Code du pays" required hint="Deux lettres : ES pour l’Espagne, PT pour le Portugal…" error={invalid('countryCustom')}><input {...inputProps('countryCustom')} autoCapitalize="characters" maxLength={2} /></Field>}
            </> : <><Field label="Adresse" wide error={invalid('address')}><textarea {...inputProps('address')} rows={3} defaultValue={supplier?.address} maxLength={1_000} autoComplete="street-address" /></Field><Field label="Numéro IDE" hint="Facultatif. Reprenez le numéro d’identification de l’entreprise." error={invalid('uidNumber')}><input {...inputProps('uidNumber')} defaultValue={supplier?.uidNumber} maxLength={80} /></Field></>}
          </div>
        </section>
        {kind === 'supplier' && <section className="contact-form-section"><h3>Comment régler ses factures ?</h3><p>Ces réglages préremplissent les nouveaux achats. Aucun virement n’est envoyé depuis cette fiche.</p><div className="form-grid">
          <Field label="IBAN CH / LI" wide hint="Facultatif. Vous pouvez le compléter plus tard." error={invalid('iban')}><input {...inputProps('iban')} defaultValue={supplier?.iban} autoCapitalize="characters" spellCheck={false} /></Field>
          <Field label="Délai de paiement (jours)" required error={invalid('paymentTermsDays')} hint="Nombre de jours après la date de facture."><input {...inputProps('paymentTermsDays')} inputMode="numeric" value={terms} onChange={event => setTerms(event.target.value)} /></Field><Field label="Devise"><output className="field-output">CHF · franc suisse</output></Field>
        </div><div className="contact-form-choices" role="group" aria-label="Délais habituels">{[0, 10, 30, 60].map(days => <Button type="button" variant="secondary" key={days} aria-pressed={terms === String(days)} onClick={() => { setTerms(String(days)); if (issue?.field === 'paymentTermsDays') setIssue(null); }}>{days ? `${days} jours` : 'Immédiat'}</Button>)}</div></section>}
        <section className="contact-form-section"><Field label="Notes internes" wide hint="Conservées dans la fiche, sans ajout automatique aux documents." error={invalid('notes')}><textarea {...inputProps('notes')} rows={3} defaultValue={item?.notes} maxLength={10_000} /></Field></section>
        {item?.archivedAt && <p className="info-strip">Cette fiche est archivée. La modifier ne la réactive pas et son historique est conservé.</p>}
      </fieldset>
      {failure && <div ref={alertRef} className="contact-form-failure" role="alert" tabIndex={-1}><strong>La fiche n’a pas pu être enregistrée.</strong><p>{issue ? 'Le champ à vérifier est signalé dans le formulaire.' : 'Vos informations sont conservées. Vous pouvez réessayer.'}</p><details><summary>Voir le message complet</summary><p>{failure}</p></details></div>}
      <FormActions onCancel={close} busy={locked} disabled={readOnly} submitLabel={kind === 'client' ? 'Enregistrer' : item ? 'Enregistrer les modifications' : 'Ajouter le fournisseur'} />
    </form>
  </Modal>;
}
export function ClientForm(props: CommonProps & { item?: Client }) { return <ContactForm {...props} kind="client" />; }
export function SupplierForm(props: CommonProps & { item?: Supplier }) { return <ContactForm {...props} kind="supplier" />; }
