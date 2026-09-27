export const settingsGroups = [
  { title: 'Entreprise et équipe', ids: ['readiness', 'company', 'account', 'payroll'] },
  { title: 'Documents et gestion', ids: ['documents', 'accounting', 'time', 'migration'] },
  { title: 'Connexions', ids: ['automation', 'mail'] },
  { title: 'Préférences et protection', ids: ['appearance', 'personalization', 'language', 'assistant', 'storage'] },
] as const;

export const settingsSearchTerms: Record<string, string> = {
  readiness: 'Configuration initiale, étapes à terminer',
  company: 'Logo, adresse, coordonnées, TVA, IBAN, délais de paiement, numérotation',
  account: 'Connexion, abonnement, invitation, collaborateurs, rôles, espace partagé',
  payroll: 'Salaires, assurances, accidents, pension, LPP, AVS, cotisations',
  documents: 'Logo, couleurs, police, mise en page, devis, factures, bilan, fiches de salaire',
  accounting: 'Comptabilité, plan comptable, comptes de liaison',
  time: 'Horaires, coût horaire, dépenses, catégories',
  migration: 'bexio, importer clients, fournisseurs, articles',
  automation: 'Automatismes, factures fournisseurs, habitudes, consentement',
  mail: 'E-mail, SMTP, Infomaniak, expéditeur, modèles, signature, logo',
  appearance: 'Mode sombre, mode clair, thème, taille du texte, lisibilité',
  personalization: 'Raccourcis, barre du bas, accueil, navigation mobile',
  language: 'Langue, français, allemand, italien, anglais',
  assistant: 'Qwen, IA locale, aide, téléchargement du modèle',
  storage: 'Sauvegarde, restaurer, exporter, mise à jour, réinitialiser, recommencer',
};

export const settingsScopes: Record<string, string> = {
  company: 'Pour cette entreprise', payroll: 'Pour cette entreprise',
  documents: 'Pour les documents de cette entreprise', accounting: 'Pour cette entreprise', time: 'Pour cette entreprise',
  automation: 'Pour toute l’équipe de cette entreprise',
  mail: 'Connexion sur cet appareil · modèles pour l’entreprise',
  appearance: 'Sur cet appareil', personalization: 'Sur cet appareil', language: 'Sur cet appareil', assistant: 'Sur cet appareil',
};

export function normalizeSettingsSearch(value: string): string {
  return value.replace(/\be[\s-]?mails?\b/gi, 'email').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchesSettingsSearch(query: string, values: string[]): boolean {
  const text = normalizeSettingsSearch(values.join(' '));
  return normalizeSettingsSearch(query).split(/\s+/).filter(Boolean).every(word => text.includes(word));
}

// Navigation only, for this app session. No form values or company data are retained here.
export const settingsNavigationSession: { category: string | null | undefined; query: string } = { category: undefined, query: '' };
