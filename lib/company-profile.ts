import { AccountPublicError } from './account-security';

// Only the company identity and activity are shared at first setup. Local paths,
// bank numbering, payroll configuration and device preferences never cross over.
const fields = ['company_name','legal_form','owner_name','email','phone','address_line1','address_line2','postal_code','city','canton','country','noga_section','noga_division','activity_description','noga_detailed_code','uid_number','vat_number'] as const;
export function companyProfile(input: unknown): Record<string, string | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountPublicError('Les coordonnées de l’entreprise sont absentes.');
  const raw = input as Record<string, unknown>, profile: Record<string, string | boolean> = {};
  for (const field of fields) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') throw new AccountPublicError('Vérifiez les coordonnées de l’entreprise.');
    const value = typeof raw[field] === 'string' ? raw[field].trim() : '';
    if (value.length > (field === 'activity_description' ? 2000 : 300)) throw new AccountPublicError('Une coordonnée de l’entreprise est trop longue.');
    profile[field] = value;
  }
  for (const field of ['company_name','noga_section','noga_division','activity_description']) if (!profile[field]) throw new AccountPublicError('Complétez le nom et l’activité de l’entreprise dans les paramètres avant de partager ses coordonnées.');
  profile.vat_registered = raw.vat_registered === true;
  return profile;
}
