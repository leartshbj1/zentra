# Achats US — sources officielles consultées le 10 octobre 2026

Recherche limitée à la verticale privée de saisie manuelle de factures reçues. Elle ne constitue pas une étude exhaustive des cinquante États ou une certification.

## Documents et coût

- IRS Publication 583 (12/2024), « Supporting Documents », « Inventory », « Expenses » et « Recording Business Transactions » : https://www.irs.gov/publications/p583 . Les pièces originales étayent les inscriptions et déclarations. Une note de source manuelle dans Zentra ne remplace ni le document ni sa conservation. L'inventaire et les dépenses sont distingués.
- IRS Publication 334 (2025), « Sales tax », section Business Expenses : https://www.irs.gov/publications/p334 . La taxe payée sur une acquisition fait partie du coût du service ou bien ; son traitement dépend notamment de la dépense, de la marchandise ou de l'actif amortissable. Le compte purchases fixe du pilote ne constitue donc pas un moteur d'imputation universel, ni une déductibilité automatique, ni une gestion des stocks ou immobilisations. Cette publication vise les situations qu'elle décrit, pas une règle US GAAP universelle pour toute forme juridique.
- Texas Comptroller, Use Tax : https://comptroller.texas.gov/taxes/sales/use-tax.php . L'absence de taxe facturée peut laisser une obligation de use tax selon les circonstances, l'usage et les exemptions. Un zéro saisi explicitement décrit le document reçu ; il ne certifie aucune exemption et n'évalue pas la use tax. Aucun taux de cette page n'est codé dans le pilote.

Conséquence produit : net et taxe explicitement saisis, montant total exact, approbation humaine, source manuelle identifiée. Comptabilisation de test net + taxe sur purchases contre payables ; pas de TVA suisse récupérable. Évaluation fiscale, stock, capitalisation, original document et validation professionnelle restent à résoudre avant usage réel.

## Supabase

- Changelog https://supabase.com/changelog.md récupéré dans `.qa/us-pilot-purchasing/supabase-changelog.md`. Index courant : 8 octobre 2026. Dépréciation des adapters @supabase/server et changements PostgreSQL du 25 septembre inspectés pour pertinence ; ce jalon réutilise le store/RPC/cookies existants, sans SDK framework, extension, schéma ou migration nouveau.
- Documentation officielle recherchée par MCP search_docs : Database Functions et Row Level Security. https://supabase.com/docs/guides/database/functions ; https://supabase.com/docs/guides/database/postgres/row-level-security . Contrôles frais serveur, isolation organisation, permissions RPC et fences existantes conservés ; aucun nouveau accès public au livre privé.

Preuve locale PostgreSQL/PGlite requise ; elle ne valide pas une migration hébergée, la concurrence multiconnexion, un crash, une charge ou un SLA.

## État de livraison

Les hypothèses sont limitées au pilote privé TEST décrit dans [le rapport de phase](US-FINANCIAL-PILOT-PURCHASING-20261010.md). Aucune migration hébergée ou opération fiscale réelle ne découle de cette documentation. Une validation professionnelle et juridictionnelle reste nécessaire avant activation pour des clients réels.
