import { isValidSwissIban } from './onboardingValidation';

export type ContactIssue = { field: string; message: string };
export type ContactValues = Record<string, string>;
export const contactCountries = [['CH', 'Suisse'], ['LI', 'Liechtenstein'], ['FR', 'France'], ['DE', 'Allemagne'], ['IT', 'Italie'], ['AT', 'Autriche'], ['BE', 'Belgique'], ['LU', 'Luxembourg'], ['GB', 'Royaume-Uni'], ['US', 'États-Unis'], ['CA', 'Canada']] as const;
export function contactFormIssue(kind: 'client' | 'supplier', values: ContactValues): ContactIssue | null {
  const text = (field: string) => (values[field] || '').trim();
  if (kind === 'client' && !text('contactPerson') && !text('company')) return { field: 'contactPerson', message: 'Indiquez le nom du contact ou celui de l’entreprise. Un seul des deux suffit.' };
  if (kind === 'supplier' && !text('name')) return { field: 'name', message: 'Indiquez le nom qui figure sur la facture du fournisseur.' };
  if (text('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text('email'))) return { field: 'email', message: 'Vérifiez l’adresse e-mail, par exemple contact@entreprise.ch, ou laissez ce champ vide.' };
  if (kind === 'client') {
    for (const [field, message] of [['street', 'Indiquez la rue ou la case postale utilisée pour la facturation.'], ['postalCode', 'Indiquez le code postal de l’adresse de facturation.'], ['city', 'Indiquez la localité de l’adresse de facturation.']] as const) if (!text(field)) return { field, message };
    const country = text('country') === '__other' ? text('countryCustom') : text('country');
    if (!/^[a-z]{2}$/i.test(country)) return { field: text('country') === '__other' ? 'countryCustom' : 'country', message: 'Choisissez le pays ou indiquez son code à deux lettres, par exemple ES pour l’Espagne.' };
  } else {
    if (text('iban') && !isValidSwissIban(text('iban'))) return { field: 'iban', message: 'Recopiez l’IBAN CH ou LI complet depuis la facture. Les espaces sont acceptés. Vous pouvez aussi le laisser vide et le compléter plus tard.' };
    if (!/^\d+$/.test(text('paymentTermsDays')) || !Number.isSafeInteger(Number(text('paymentTermsDays')))) return { field: 'paymentTermsDays', message: 'Indiquez un nombre entier de jours, par exemple 30. Saisissez 0 pour un paiement immédiat.' };
  }
  return null;
}

export function contactNativeIssue(kind: 'client' | 'supplier', message: string): ContactIssue | null {
  if (/iban/i.test(message)) return { field: 'iban', message: 'L’IBAN a été refusé. Comparez-le au document bancaire ou laissez-le vide pour compléter la fiche plus tard.' };
  if (/payment_terms_days/i.test(message)) return { field: 'paymentTermsDays', message: 'Vérifiez le délai de paiement : un nombre entier de jours, ou 0 pour un paiement immédiat.' };
  const names: Record<string, string> = { contact_name: 'contactName', contact_person: 'contactPerson', address_line1: 'street', address_line2: 'buildingNumber', postal_code: 'postalCode', uid_number: 'uidNumber', name: kind === 'client' ? 'contactPerson' : 'name', email: 'email', phone: 'phone', address: 'address', notes: 'notes', city: 'city', country: 'country' };
  const field = Object.keys(names).find(name => new RegExp(`\\b${name}\\b`, 'i').test(message));
  return field ? { field: names[field], message: 'Vérifiez ce champ. Le détail du refus est disponible sous le formulaire ; votre saisie est conservée.' } : null;
}
