# Zentra US — achats, paiements enregistrés et compatibilité des clients

Base de développement : `3d4c287ba470ea735ad63a19d89cac9723e1cf9c`. Cette étape poursuit le même ERP international, dans une copie isolée. Aucun fichier de l'application suisse native, donnée client, prix, abonnement, région Supabase ou site commercial publié n'est remplacé. La page commerciale reste la publication 354 dans son checkout distinct ; cette branche ne doit pas être déployée par-dessus ce site sans alignement explicite de ses sources.

## Résultat et périmètre

Le parcours ajoute un fournisseur, une facture fournisseur approuvée manuellement, puis des paiements enregistrés, entiers ou partiels. Le montant restant découle uniquement de la facture et de ses paiements durables. Le nom et l'adresse du fournisseur sont figés à l'approbation de la facture ; modifier ensuite sa fiche ne modifie pas l'historique. Les factures validées et les paiements ne sont pas réécrits ou supprimés par une commande courante.

Les commandes sont `save_vendor`, `record_vendor_bill` et `record_vendor_payment`. Leur exécution exige les droits Gestion US du même espace et un propriétaire, administrateur ou comptable réellement admis. Un membre ou lecteur peut consulter les données autorisées sans recevoir de permission financière. Le navigateur ne transmet ni rôle, ni identité d'approbation faisant autorité, ni total calculé, ni journal comptable. Les dates de facture, de paiement, de comptabilisation et la période restent distinctes.

Premier périmètre : achats en USD imputés au compte de charges `purchases` (5000). Le net et la taxe d'achat sont saisis au centime ; la taxe est incluse dans le coût, sans créer de crédit de TVA suisse. Les montants sont des chaînes d'entiers canoniques, calculées avec `BigInt`, limitées explicitement à 36 chiffres. Un paiement doit être positif et ne peut dépasser le solde enregistré. Une facture est unique par espace, fournisseur, référence exacte et date de facture ; aucune normalisation silencieuse de la référence n'est appliquée.

En méthode accrual, la facture alimente la charge et les comptes fournisseurs, puis son paiement diminue la dette. En méthode cash, le paiement enregistré alimente le coût et la trésorerie. Les postes, soldes et journaux passent par les primitives financières existantes et la relecture déterministe du grand livre. Ce traitement opérationnel ne détermine pas automatiquement une déduction fiscale. Stocks, immobilisations, charges constatées d'avance, remboursements et avoirs fournisseurs nécessitent des traitements supplémentaires et une validation professionnelle.

Une référence de justificatif est conservée. Elle n'est pas un archivage de PDF, une preuve d'existence du justificatif ou une garantie de durée de conservation réglementaire. Un paiement **enregistré** n'exécute pas un virement, un ACH ou un débit Stripe.

## Version du livre et protocole

Les livres historiques restent exactement `schemaVersion:1`, sans nouvelles collections facultatives ajoutées lors d'une lecture. Même un client capable de version 2 initialise un livre en version 1. La première commande d'achat le promeut explicitement en version 2, avec les trois collections requises `vendors`, `vendorBills` et `vendorPayments`. Il n'existe pas de rétrogradation implicite.

L'en-tête reste composé des cinq champs historiques : version, révision, configuration, compteurs et ledger. Les compteurs de devis et factures clients ne sont pas employés pour les références fournisseurs. La révision globale et le CAS restent communs aux ventes et achats. Les événements et reçus historiques ne sont pas réécrits ; un flux de version 2 peut contenir les événements historiques de version 1 dans leur forme originale.

Les ports serveur et les lecteurs de delta sont explicitement capables de version 1 ou 2. Leur défaut est 1. Le header `X-Zentra-Erp-Schema-Version: 2` indique seulement la capacité du client ; il ne confère aucun droit, abonnement ou activation de fonction. Les factories serveur plafonnent le port à cette capacité et au flag serveur `INTERNATIONAL_US_PURCHASING_V2_ENABLED`, fermé par défaut. Les flags US existants restent nécessaires. La page d'espace reçoit sa capacité d'une décision serveur, jamais d'un paramètre d'URL ou du stockage du navigateur.

Les anciennes RPC de lecture, révision, delta et reçu refusent un livre promu (`PU008`, traduit en `client_upgrade_required`, HTTP 409). Elles ne renvoient pas un sous-ensemble cachant les achats ou leurs écritures. Un client récent capable de version 2 continue à lire les livres de version 1 et leurs reçus exacts. Les quatre nouvelles RPC portent le suffixe `_v2` ; le commit atomique garde son nom et valide la version, le rôle et la transition.

La clé d'un nouveau paiement fournisseur est limitée à 225 caractères pour conserver son préfixe de journal `vendor-payment:` dans la borne de 240. Les clés historiques des autres commandes conservent leur borne de 232, sans troncature ni migration.

## Admission, commit et synchronisation

Une opération est relue et autorisée après les attentes critiques. La facture approuvée ou le paiement est composé avec **l'acteur et l'instant de la dernière admission**, utilisés aussi pour le commit. Une horloge Auth qui avance ne crée pas de divergence entre document, journal et acteur transmis à SQL. Les nouveaux reçus de version 2 conservent cet instant d'admission ; les événements le formatent en UTC à la milliseconde. Les dates équivalentes sans fraction et avec `.000` sont comparées comme instants. Les horodatages et lignes historiques de version 1 restent inchangés.

Le commit sous verrou conserve la portée de l'espace et du pays, le CAS, l'identité acteur/clé/hash du replay et l'écriture atomique du document, paiement éventuel, journal, audit, reçu et événement. Les gardes SQL refusent aussi les insertions directes incohérentes sous `service_role` : document orphelin, mauvaise action du reçu, solde excessif, mauvais fournisseur, mutation d'un paiement ou journal validé. Elles ne constituent pas une authentification utilisateur à partir de `p_actor` ; cette autorité appartient à l'admission serveur Auth/D1 réellement vérifiée.

Le lecteur de delta exige la corrélation de l'action, de l'entité, de la révision, de l'utilisateur et de l'instant d'approbation. Une nouvelle facture fige exactement le fournisseur courant au moment de son événement. La clé du paiement correspond à celle du reçu et du journal. Une page invalide ne laisse pas échapper une application partielle. Le résultat public ne contient pas l'EIN privé de la configuration.

La reprise conserve le corps et la clé initiaux. Une réponse perdue après commit n'entraîne pas de nouvelle facture ou de nouveau paiement. Aucun changement n'est affiché comme enregistré avant un reçu confirmé puis une relecture ; les autres opérations sont bloquées tant que le résultat reste incertain. Les brouillons restent en RAM dans le panneau ouvert et ne constituent pas un mode hors ligne durable.

La revue indépendante a découvert et corrigé trois régressions de composition : le wrapper fiscal privé perdait la capacité 2 et bloquait une émission après activation des achats ; un delta cash acceptait un instant d'approbation ou un snapshot fournisseur incohérent ; la clé du reçu pouvait différer de celle d'un paiement. La revue SQL a aussi corrigé le tri des paiements par identifiant au lieu de révision, des valeurs nulles qui traversaient un CHECK et des tentatives d'insertion directe liées à une action non financière. Deux insertions directes complètes pouvaient associer à la facture cash ou au paiement accrual un reçu horodaté différemment : elles sont désormais refusées avec rollback, avant de produire un événement rejeté par la synchronisation. Les régressions ciblées restent dans les tests.

## Migration proposée et retour arrière

Nouvelle migration versionnée, créée avec le CLI existant : `supabase/migrations/20261008081825_international_us_purchasing_v2.sql`. Elle élargit les contraintes du seul ERP US, ajoute les gardes/relations/index et les RPC de lecture version 2 et adapte le commit/capture existants. Aucune ancienne migration, table métier CH, donnée, historique, politique RLS globale ou publication Realtime n'est supprimé ou désactivé. Les fonctions et tables restent côté serveur ; aucune permission financière publique n'est ouverte.

Recette préalable au déploiement : base locale puis staging représentatif, inspection des contraintes et états existants, copie de sécurité vérifiée, ancienne lecture encore exacte pour les livres 1, émission historique/fiscale toujours intacte, validation sous les rôles réels et avec deux connexions PostgreSQL indépendantes. Installer les lecteurs capables de version 2 avant d'autoriser une première promotion ; tester ensuite le flag et un espace US pilote en staging. Une ancienne version du lecteur doit afficher un refus explicite, jamais un livre tronqué. Aucune migration de production n'est exécutée par cette étape.

Retour arrière : avant toute promotion, garder le flag fermé et le protocole 1 ; après promotion, **ne pas supprimer les collections ni revenir à un lecteur 1**. Conserver les lecteurs 2 et les données, suspendre les nouvelles écritures si nécessaire et corriger par une migration avant. Retirer la migration après création d'achats requerrait une migration explicite de données et une validation séparée. Les points de rollback du code ne rendent pas une rétrogradation des données sûre.

## Interface et limites

Le panneau US existant accueille les achats lorsqu'une capacité 2 serveur est présente, avec une copie française, anglaise, allemande et italienne. L'interface et les textes historiques restent inchangés par défaut en capacité 1. Elle suit le même canal ERP et les mêmes clôtures Auth, révision, attente et reprise que les clients/devis ; les achats manuels n'exigent pas une configuration de sales tax clients réussie. L'approbation humaine et l'enregistrement d'un paiement sont distingués de la fiscalité et d'un virement.

Les formulaires d'achat sont regroupés en volets fermés au départ. Toute édition d'une facture déjà relue annule son ancienne confirmation et impose une nouvelle revue du montant courant. Le focus clavier des trois nouveaux volets est placé à l'intérieur pour ne pas être rogné par leur bordure ; Tab et l'indicateur visible ont été vérifiés aussi sur les volets fermés.

Cette étape reste expérimentale et fermée en production. Elle ne livre pas encore commandes fournisseurs, avoirs, extraction automatique de pièces, conservation documentaire, rapprochement bancaire, application native US ou abonnement USD réellement encaissable. Le provider fiscal actuel reste `null` ; les tests d'émission utilisent un gateway de TEST fictif explicite, pas Stripe réel.

## Vérifications et fichiers

Validation finale du 8 octobre 2026 : **3 138 tests passent dans 78 fichiers**, zéro échec et zéro test ignoré, avec les quatre QA navigateur explicitement activés. Les 358 tests du lot achats incluent 133 tests de domaine, 63 de moteur, 57 PostgreSQL, 27 de transport, 15 de composition, 8 de bindings, 54 de builders/interface et un parcours navigateur. La création d'espace US repasse ses six essais avec la nouvelle migration explicitement admise dans le manifest fermé.

TypeScript global, lint avec analyse de types des 28 sources TypeScript/TSX concernées, compilation de production et `git diff --check` terminent avec sortie 0. Les empreintes des 30 sources TS/TSX/CSS/SQL concernées sont identiques avant et après la suite, puis après la compilation. Les **133 fichiers SQL historiques** restent identiques à la base Git, dont 110 fichiers de migrations Supabase/Drizzle et 23 autres fichiers SQL.

Le parcours navigateur emploie les vrais composants React, handlers HTTP, commandes ERP et application des deltas, avec Auth et CAS RAM explicitement fictifs. Il vérifie sept commits, les paiements partiels, le refus d'un paiement excessif sans POST, la reprise exacte après une réponse 503 perdue après commit, les brouillons conservés lors d'une révision concurrente puis purgés au refus d'accès, et le refus d'une écriture forgée par un membre. Une réponse GET tardive n'affiche pas l'ancien compte après un événement Auth. Aucune réussite de la configuration fiscale ou vendeur n'est requise pour un achat manuel, et aucun provider fiscal ou hook vendeur n'est appelé.

32 vues passent : quatre langues × deux thèmes × trois largeurs (320, 390 et 1 280 px), plus huit vues à 200 % de taille de texte sur 320 px. Aucun débordement horizontal ni erreur JavaScript détecté. Les 96 vérifications du focus par Tab sur les trois volets fermés confirment un indicateur visible non rogné. Les captures clair/sombre à 390 px et le cas à 200 % ont été inspectés ; cela reste une preuve Chromium locale, pas un essai sur iPhone physique.

Diagnostics de compilation conservés : ancienne convention `middleware` dépréciée, diagnostic de temps passé dans les plugins et classification statique incomplète de certaines routes par Vinext. La compilation réussit ; ce résultat ne mesure pas la capacité ou la latence en production.

Fichiers créés :

- Domaine et capacité : `lib/international/contacts.ts`, `lib/international/erp-schema-capability.ts`, `lib/international/purchasing.ts`.
- Builders et copie locale : `lib/international/browser-purchasing.ts`, `lib/international/browser-purchasing-copy.ts`.
- Tests : `lib/international/purchasing.test.ts`, `purchasing-runtime.test.ts`, `purchasing.postgres.test.ts`, `purchasing-transport.test.ts`, `purchasing-composition.test.ts`, `purchasing-bindings.test.ts`, `browser-purchasing.test.ts`, `browser-purchasing.browser.test.ts`, tous dans `lib/international/`.
- Migration : `supabase/migrations/20261008081825_international_us_purchasing_v2.sql`.
- Livraison : ce rapport et `docs/evidence/us-purchasing-runtime-20261008.json`.

Fichiers modifiés :

- Écran : `app/compte/espaces/us/[organizationId]/page.tsx`, `components/account/us-erp-workbench.tsx`, `components/account/us-erp-workbench.css`.
- Moteur : `lib/international/erp-request.ts`, `runtime-types.ts`, `runtime.ts`, `runtime-validation.ts`, `runtime-store.ts`.
- Synchronisation et transports : `lib/international/runtime-sync.ts`, `runtime-sync-store.ts`, `runtime-server.ts`, `runtime-sync-server.ts`, `runtime-bindings.ts`, `browser-erp-session.ts`.
- Composition et recette : `lib/international/us-tax-invoice.ts`, `lib/international/workspace-creation.integration.test.ts`.

Les listes exactes complètes, empreintes, flags, résultats et limites sont consignés dans `docs/evidence/us-purchasing-runtime-20261008.json`. Les journaux et captures locaux sont sous `.qa/us-purchasing` et `.qa/us-purchasing-browser`, hors publication et hors commit.

Les tests locaux distinguent le domaine exact, le moteur et son CAS RAM, les transports HTTP réels avec Auth synthétique, les RPC réelles d'une instance PGlite PostgreSQL sérialisée en RAM et l'interface navigateur. Ces essais ne prouvent pas Supabase hébergé/PostgREST, Auth réel, deux connexions concurrentes, la durabilité après crash, une capacité de production ou une certification US GAAP.

## Références comptables et opérationnelles

- [IRS, Publication 583 : documents et conservation des transactions](https://www.irs.gov/publications/p583), édition affichée décembre 2024. Utilisée pour distinguer enregistrement et justificatif ; la présente référence métier ne réalise pas cet archivage.
- [IRS, Publication 538 : méthodes comptables](https://www.irs.gov/publications/p538), édition affichée janvier 2022. Utilisée pour distinguer cash/accrual et identifier les traitements qui exigent un examen ; aucun ancien seuil fiscal annuel n'est codé comme taux actuel.
- [Supabase : fonctions de base de données](https://supabase.com/docs/guides/database/functions), consulté pendant cette étape. Les RPC ne remplacent pas les autorisations applicatives de l'espace.

Prochaine étape après validation : poursuivre les ventes/documents et le pilote US avec un vrai environnement de staging, puis Support/Automation en anglais, sans présenter les traitements réglementaires non validés comme activés.
