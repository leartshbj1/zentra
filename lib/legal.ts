// Public business identity confirmed by the operator on 14 September 2026.
export const LEGAL_VERSION = '2026-09-14';
export const LEGAL_DATE = '14 septembre 2026';
export const LEGAL_OPERATOR = {
  name: 'Shabija Leart',
  brand: 'Zentra',
  street: 'Avenue de Châtelaine 72',
  locality: '1219 Châtelaine',
  country: 'Suisse',
  email: 'info@zentraapp.ch',
  website: 'https://zentraapp.ch',
} as const;

export function hasCurrentLegalAcceptance(body: Record<string, unknown>) {
  return body.acceptTerms === true && body.legalVersion === LEGAL_VERSION;
}
