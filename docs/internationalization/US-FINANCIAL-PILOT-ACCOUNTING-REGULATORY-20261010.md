# Journaux et périodes US — sources officielles consultées le 10 octobre 2026

Recherche limitée au raccord navigateur privé TEST du livre américain existant. Elle ne constitue ni un avis comptable, ni une étude exhaustive de toutes les juridictions américaines.

## Tenue du livre et pièces

- IRS Publication 583, édition 12/2024, sections « Bookkeeping System », « Double-entry » et « Computerized System » : https://www.irs.gov/publications/p583 . La partie double relie journaux et comptes et exige l'égalité des débits et crédits. Les sources identifiables et contrôles contre les changements non autorisés restent nécessaires. Le pilote conserve les écritures d'origine, leurs inverses et l'audit ; ces contrôles seuls ne démontrent pas toute la conformité documentaire, la conservation des pièces ou une certification US GAAP.
- La même publication décrit le solde des comptes de revenus et dépenses en fin d'année fiscale. La commande technique close_period de cette verticale bloque de nouvelles inscriptions dans la période et ajoute l'audit ; elle ne passe aucune écriture de résultat et ne réalise pas une clôture annuelle complète.

Conséquence produit : montants exacts, équilibre obligatoire, comptes admis du livre courant, revue et confirmation humaines. La contrepassation porte uniquement sur un journal manuel, inverse ses lignes sans effacer l'original et ne modifie pas les sous-registres clients, fournisseurs, taxes ou acomptes. Aucun fonds n'est envoyé.

## Périodes et méthode comptable

- IRS Publication 538, édition affichée 01/2022, sections « Accounting Periods », « Change in Tax Year » et « Accrual Method » : https://www.irs.gov/publications/p538 . L'année fiscale et la méthode comptable dépendent de la situation. Un changement d'année peut nécessiter une procédure et une autorisation IRS. Aucun seuil ancien ni taux de cette publication n'est repris dans le code.

Une plage technique dans Zentra n'adopte ni ne modifie l'année fiscale de l'entreprise. Le pilote reste en USD et accrual ; il ne convertit pas la comptabilité en cash basis. L'ouverture chronologique et le verrouillage des périodes ne constituent aucune déclaration fiscale, clôture légale annuelle, sélection de méthode ou validation professionnelle. Ces traitements doivent faire l'objet d'une verticale distincte et d'une revue qualifiée avant activation réelle.

## Supabase et portée des preuves

Le store cumulatif invoicing V5 et les wrappers privés sont réutilisés. Les 33 migrations de la recette actuelle sont conservées sans nouvelle migration. Les admissions serveur, grant/opt-in PostgreSQL et fences de révision gardent l'isolation organisationnelle ; une recette PGlite locale sérialisée ne prouve ni une transaction distribuée Auth/D1/PostgreSQL, ni des connexions PostgreSQL concurrentes, une reprise après crash, une charge ou un SLA.

Aucune migration hébergée, publication native, modification de tarifs, abonnement ou région n'est autorisée par ce document. Les hypothèses de cette phase restent celles du pilote privé TEST et n'ouvrent pas une utilisation fiscale par des clients réels.
