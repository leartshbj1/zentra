export type SwissFamilyAllowanceReference = {
  canton: string;
  name: string;
  child: string;
  education: string;
  note: string;
};

/**
 * Montants mensuels publiés par le Centre d'information AVS/AI pour 2026.
 * Ils servent de référence de contrôle, pas de barème automatique : la caisse
 * compétente, la priorité entre parents et les droits acquis restent à valider.
 */
export const SWISS_FAMILY_ALLOWANCES_2026: readonly SwissFamilyAllowanceReference[] = [
  { canton: 'AG', name: 'Argovie', child: 'CHF 225', education: 'CHF 278', note: '' },
  { canton: 'AI', name: 'Appenzell Rh.-Int.', child: 'CHF 245', education: 'CHF 298', note: '' },
  { canton: 'AR', name: 'Appenzell Rh.-Ext.', child: 'CHF 230', education: 'CHF 280', note: '' },
  { canton: 'BE', name: 'Berne', child: 'CHF 250', education: 'CHF 310', note: '' },
  { canton: 'BL', name: 'Bâle-Campagne', child: 'CHF 215', education: 'CHF 268', note: '' },
  { canton: 'BS', name: 'Bâle-Ville', child: 'CHF 275', education: 'CHF 325', note: '' },
  { canton: 'FR', name: 'Fribourg', child: 'CHF 265 / 285', education: 'CHF 325 / 345', note: 'Montant supérieur dès le 3e enfant.' },
  { canton: 'GE', name: 'Genève', child: 'CHF 311 / 411', education: 'CHF 415 / 515', note: 'Montant supérieur dès le 3e enfant.' },
  { canton: 'GL', name: 'Glaris', child: 'CHF 215', education: 'CHF 268', note: '' },
  { canton: 'GR', name: 'Grisons', child: 'CHF 240', education: 'CHF 290', note: '' },
  { canton: 'JU', name: 'Jura', child: 'CHF 275', education: 'CHF 325', note: '' },
  { canton: 'LU', name: 'Lucerne', child: 'CHF 215 / 260', education: 'CHF 268', note: 'Enfant jusqu’à 12 ans / dès 12 ans.' },
  { canton: 'NE', name: 'Neuchâtel', child: 'CHF 240 / 270', education: 'CHF 320 / 350', note: 'Montant supérieur dès le 3e enfant.' },
  { canton: 'NW', name: 'Nidwald', child: 'CHF 258', education: 'CHF 311', note: '' },
  { canton: 'OW', name: 'Obwald', child: 'CHF 220', education: 'CHF 270', note: '' },
  { canton: 'SG', name: 'Saint-Gall', child: 'CHF 245', education: 'CHF 298', note: '' },
  { canton: 'SH', name: 'Schaffhouse', child: 'CHF 230', education: 'CHF 290', note: '' },
  { canton: 'SO', name: 'Soleure', child: 'CHF 215', education: 'CHF 268', note: '' },
  { canton: 'SZ', name: 'Schwytz', child: 'CHF 230', education: 'CHF 280', note: '' },
  { canton: 'TG', name: 'Thurgovie', child: 'CHF 215', education: 'CHF 280', note: '' },
  { canton: 'TI', name: 'Tessin', child: 'CHF 215', education: 'CHF 268', note: '' },
  { canton: 'UR', name: 'Uri', child: 'CHF 240', education: 'CHF 290', note: '' },
  { canton: 'VD', name: 'Vaud', child: 'CHF 322 / 365', education: 'CHF 425 / 468', note: 'Montant supérieur dès le 3e enfant; règles cantonales particulières.' },
  { canton: 'VS', name: 'Valais', child: 'CHF 327 / 435', education: 'CHF 477 / 585', note: 'Montant supérieur dès le 3e enfant; règles cantonales particulières.' },
  { canton: 'ZG', name: 'Zoug', child: 'CHF 330', education: 'CHF 330 / 385', note: 'Formation jusqu’à 18 ans / dès 18 ans.' },
  { canton: 'ZH', name: 'Zurich', child: 'CHF 215 / 268', education: 'CHF 268', note: 'Enfant jusqu’à 12 ans / dès 12 ans.' },
];

export const SWISS_FAMILY_ALLOWANCES_2026_SOURCE = 'https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/OrwD3z_mIEOztplxBzs7qQ/Document/Kantone_2026_f-1.pdf';

export function familyAllowanceReferenceForCanton(canton: string) {
  const normalized = canton.trim().toUpperCase();
  return SWISS_FAMILY_ALLOWANCES_2026.find((item) => item.canton === normalized);
}

