// Logiciels dont Zentra reprend les exports. Chaque source a ses consignes
// d'export ; la lecture du fichier, la détection des en-têtes et la
// correspondance des colonnes sont communes. Les formats publiés par Banana,
// Crésus et Abacus sont vérifiés ; pour WinBIZ et AbaNinja/Swiss21, Zentra
// reconnaît les en-têtes usuels et la correspondance reste modifiable.

export type MigrationSource = 'bexio' | 'winbiz' | 'cresus' | 'banana' | 'abaninja' | 'generic';
export type MigrationKind = 'clients' | 'suppliers' | 'catalog' | 'accounts' | 'invoices' | 'balance';

export const migrationSources: readonly { id: MigrationSource; name: string }[] = [
  { id: 'bexio', name: 'bexio' },
  { id: 'winbiz', name: 'WinBIZ' },
  { id: 'cresus', name: 'Crésus' },
  { id: 'banana', name: 'Banana' },
  { id: 'abaninja', name: 'AbaNinja ou Swiss21' },
  { id: 'generic', name: 'Autre logiciel, Excel ou CSV' },
];

export const migrationKinds: readonly { id: MigrationKind; label: string }[] = [
  { id: 'clients', label: 'Clients' },
  { id: 'suppliers', label: 'Fournisseurs' },
  { id: 'catalog', label: 'Articles et services' },
  { id: 'accounts', label: 'Plan comptable' },
  { id: 'invoices', label: 'Factures ouvertes' },
  { id: 'balance', label: 'Bilan d’ouverture' },
];

/** Nom court du logiciel, pour les notes des fiches et l'historique : « Import WinBIZ ». */
export function sourceName(source: MigrationSource): string {
  return source === 'abaninja' ? 'AbaNinja' : source === 'generic' ? 'Excel ou CSV' : migrationSources.find((entry) => entry.id === source)!.name;
}

const guides: Record<MigrationSource, Partial<Record<MigrationKind, string>> & { default: string }> = {
  bexio: {
    default: 'Dans bexio, exportez la liste souhaitée au format Excel. Séparez vos clients et vos fournisseurs à l’aide du filtre Catégorie. Choisissez les adresses principales.',
    invoices: 'Dans bexio, exportez la liste des factures ouvertes et partiellement payées au format Excel. Reprenez d’abord vos clients : chaque facture est rattachée au client du même nom.',
    balance: 'Dans bexio, exportez le bilan à la date de clôture au format Excel ou CSV. Reprenez d’abord vos factures ouvertes, puis activez la comptabilité dans Zentra.',
    accounts: 'Dans bexio, ouvrez le plan comptable et exportez-le au format Excel.',
  },
  winbiz: {
    default: 'Dans WinBIZ, affichez la liste souhaitée (adresses, articles) et exportez-la vers Excel ou en CSV. Gardez une ligne d’en-têtes. Exportez clients et fournisseurs séparément.',
    invoices: 'Dans WinBIZ, affichez les factures débiteurs encore ouvertes et exportez la liste vers Excel. Reprenez d’abord vos clients : chaque facture est rattachée au client du même nom.',
    balance: 'Dans WinBIZ, imprimez le bilan à la date de clôture vers Excel ou en CSV, avec le numéro et le solde de chaque compte.',
    accounts: 'Dans WinBIZ, exportez le plan comptable vers Excel ou en CSV, avec le numéro et le nom de chaque compte.',
  },
  cresus: {
    default: 'Dans Crésus Facturation, exportez les adresses ou les articles en fichier texte (tabulé) ou en Excel, avec une ligne d’en-têtes.',
    invoices: 'Dans Crésus Facturation, exportez la liste des factures non payées en fichier texte ou en Excel. Reprenez d’abord vos clients.',
    balance: 'Dans Crésus Comptabilité, affichez le bilan à la date de clôture, puis Fichier › Exporter en texte tabulé.',
    accounts: 'Dans Crésus Comptabilité, affichez le plan comptable, puis Fichier › Exporter en texte tabulé. La catégorie (Actif, Passif, Charge, Produit) est reprise.',
  },
  banana: {
    default: 'Dans Banana, ouvrez le tableau souhaité (Adresses, Articles) et exportez-le en Excel ou en texte. Gardez la ligne des en-têtes.',
    invoices: 'Dans Banana, exportez la liste des factures clients ouvertes en Excel. Reprenez d’abord vos clients.',
    balance: 'Dans Banana, ouvrez le tableau Comptes et exportez-le en Excel : le numéro (Compte) et le solde (Solde) suffisent.',
    accounts: 'Dans Banana, ouvrez le tableau Comptes et exportez-le en Excel. La classe BClass (1 actif, 2 passif, 3 charge, 4 produit) est reprise.',
  },
  abaninja: {
    default: 'Dans AbaNinja ou Swiss21, ouvrez la liste souhaitée (Adresses, Produits) et exportez-la en CSV.',
    invoices: 'Dans AbaNinja ou Swiss21, filtrez les factures ouvertes et exportez la liste en CSV. Reprenez d’abord vos clients.',
    balance: 'Dans AbaNinja ou Swiss21, exportez le bilan à la date de clôture en CSV ou en Excel.',
    accounts: 'Dans AbaNinja ou Swiss21, exportez le plan comptable en CSV ou en Excel.',
  },
  generic: {
    default: 'Préparez un tableau Excel (.xlsx) ou CSV avec une ligne d’en-têtes. Zentra propose la correspondance des colonnes ; vous pouvez la changer avant de confirmer.',
  },
};

export function migrationGuide(source: MigrationSource, kind: MigrationKind): string {
  return guides[source][kind] ?? guides[source].default;
}

export type ImportOrigin = { source: MigrationSource; fileName?: string };

export function originToRaw(origin: ImportOrigin) {
  const fileName = origin.fileName?.trim();
  return { source: origin.source, ...(fileName ? { file_name: fileName.slice(0, 255) } : {}) };
}
