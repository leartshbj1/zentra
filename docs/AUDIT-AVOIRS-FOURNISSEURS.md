# Avoirs fournisseurs : remboursement reçu — travail local du 6 septembre 2026

Le dossier devis/acompte/solde est publié en 1.35, comme décrit dans `RELEASE-1.35.md`. Le présent travail poursuit l’audit général ; il n’est pas encore publié et ne constitue pas une fin d’audit.

## Parcours désormais implémenté

Depuis Achats et fournisseurs, un avoir validé en CHF peut recevoir un remboursement total ou partiel. La somme disponible déduit les compensations et les remboursements actifs. Une correction datée rétablit le montant exact et conserve l’événement initial. L’enregistrement et son écriture bancaire sont atomiques ; le compte fournisseur reprend celui de l’avoir d’origine, même après changement des paramètres.

Le schéma 51 conserve les demandes pour éviter les doubles écritures, protège les événements, les montants, les dates, le solde historique et les liens au journal. Une extourne isolée depuis le journal est refusée. Les remboursements sont présents dans la sauvegarde, l’export CSV des achats et le journal du dossier comptable. La migration ne crée aucun règlement.

En méthode TVA reçue, le remboursement règle les lignes de l’avoir à sa date effective ; sa correction reprend leurs centimes exacts. En méthode convenue, le virement ne crée pas une seconde correction de TVA. La ventilation existante entre catégories déductibles et non déductibles est conservée. Références relues : [LTVA, art. 40 et 41](https://www.fedlex.admin.ch/eli/cc/2009/615/fr#art_41), [contrôles AFC](https://www.estv.admin.ch/fr/deroulement-dun-controle-tva). L’inspiration de parcours est la distinction entre avoir et paiement dans la [documentation officielle Odoo](https://github.com/odoo/documentation/blob/19.0/content/applications/finance/accounting/customer_invoices/credit_notes.rst).

Le formulaire fonctionne au clavier et au toucher, conserve le montant d’origine lors d’une correction et respecte la lecture seule. Une lecture échouée après succès de l’écriture ne relance que les lectures. Les statuts `pending` et `partial` ont leurs libellés français et les cartes d’achats affichent la devise de leur document.

## Vérification actuelle

- 702 tests d’interface réussis ; TypeScript et compilation de production réussis ; Clippy sur toutes les cibles avec avertissements interdits réussi.
- Huit parcours de navigateur sur interface compilée : 320, 390, 768 et 1440 pixels, chacun avec et sans droit d’écriture. Saisie, plafond disponible, compensation après remboursement, correction et reprise d’une lecture échouée sont contrôlés. Les captures ont été inspectées ; pas de débordement détecté ni d’erreur JavaScript.
- Première suite native complète : 543 succès, deux échecs, un test ignoré. Le premier échec provenait du libellé d’un refus, qui conserve maintenant l’indication de chronologie. Le second provenait d’une fixture v42 qui conservait une vue v51 dépendante d’une colonne supprimée : la fixture reconstruit maintenant le schéma historique avant migration. Ces échecs sont conservés dans le journal de contrôle.
- Après corrections, les 30 tests natifs filtrés sur `credit` réussissent, y compris les deux tests ci-dessus et les neuf nouveaux tests. Ils couvrent notamment les écritures concurrentes, les corrections, les dates fermées, le compte d’origine, les arrondis par taux de TVA, les périodes TVA antérieures, la restauration, le CSV, le dossier comptable et la migration depuis le schéma 50.

Preuves locales : `.qa/supplier-credit-refund-native-full.log`, `.qa/supplier-credit-refund-native-credit.log`, `.qa/supplier-credit-refund-ui-full.log`, `.qa/supplier-credit-refund-clippy.log`, `.qa/supplier-credit-refund-web-build.log`, `.qa/supplier-credit-refund/report.json` et captures du même dossier.

## Travail restant avant publication de ce parcours

Relier le remboursement au crédit du relevé bancaire, avec exclusivité entre les différents types de rapprochement, dissociation et création atomique depuis le relevé. Ajouter les justificatifs au remboursement avec sauvegarde et index dans le dossier comptable. Puis vérifier le parcours complet et les nouveaux paquets avant publication. La version publique reste 1.35 ; aucune nouvelle publication ni validation sur téléphone physique n’est annoncée ici.
