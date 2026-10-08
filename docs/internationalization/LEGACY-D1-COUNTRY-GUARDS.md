# Gardes D1 des transports legacy — revue locale du 8 octobre 2026

Préparation additive locale, sans déploiement, push ni activation US. Le lot comprend [0086](../../drizzle/0086_international_legacy_country_guards.sql), le [précontrôle applicatif](../../lib/international/legacy-country-guard.ts) et ses [tests SQL/D1](../../lib/international/legacy-country-guard.migrations.test.ts). Il dépend de la table créée par 0085 ; il ne crée et ne modifie aucune intention.

## Garantie à l’écriture

Les 114 triggers `BEFORE INSERT/UPDATE/DELETE` couvrent les 38 tables réelles ci-dessous. Une intention dont `country_code='US'` ferme immédiatement les mutations legacy, sans condition sur son état. Un échec ou une reprise de création conserve donc la fermeture. Les UPDATE vérifient `OLD` et `NEW`, et les enfants vérifient chaque référence de transfert/source/sauvegarde en plus de leur éventuel `organization_id`.

Les INSERT vérifient aussi les conflits sur les clés primaires et les index uniques réels : `INSERT OR REPLACE` peut supprimer implicitement une ligne sans exécuter les triggers DELETE quand `recursive_triggers` est désactivé. Le refus utilise `RAISE(ABORT,'international_legacy_transport_forbidden')`, y compris sous `OR IGNORE`, et annule la mutation/le batch D1 concerné.

Les quatre tables possédant `object_key` vérifient également le namespace exact `business-sync/<organizationId>/`. Le segment d’organisation extrait fait une recherche dans l’index unique des intentions. Un parent CH falsifié ou manquant n’efface pas cette référence US. Aucun `LIKE` n’interprète un underscore ou un pourcentage comme joker.

L’absence d’intention conserve le comportement legacy. Elle n’atteste aucune juridiction CH. Aucun trigger de ce lot ne cible `organizations`, `subscriptions`, `organization_members`, une invitation ou une session appareil.

## Tables et relations vérifiées

| Tables | Références contrôlées |
| --- | --- |
| `business_sync_transfers` | `organization_id`, identité `transfer_id` existante |
| `business_sync_spaces`, `business_sync_number_floors` | `organization_id`, `bootstrap_transfer_id` |
| `business_sync_versions`, `business_sync_publications` | `organization_id`, `transfer_id` |
| `business_sync_transaction_changes` | `organization_id`, `transaction_id` |
| `business_sync_transaction_commits` | `organization_id`, `transfer_id`, `source_transfer_id` |
| `business_sync_transaction_reviews` | `transfer_id`, `source_transfer_id` |
| `business_sync_audit_branches`, `business_sync_retirements`, `business_sync_retirement_cancellations` | `organization_id` |
| `business_sync_transaction_parts` | `transaction_id`, namespace `object_key` |
| `business_sync_transfer_chunks`, `business_sync_file_parts`, `business_sync_transaction_delivery_parts` | `transfer_id`, namespace `object_key` |
| `business_sync_audit_nodes`, `business_sync_candidate_order`, `business_sync_credit_lines`, `business_sync_credit_movements`, `business_sync_credit_projection`, `business_sync_file_blobs`, `business_sync_file_entries`, `business_sync_file_pages`, `business_sync_file_sets`, `business_sync_integrity_checks`, `business_sync_row_order`, `business_sync_structural_checks`, `business_sync_transaction_accounting_states`, `business_sync_transaction_canonical_order`, `business_sync_transaction_conflicts`, `business_sync_transaction_document_states`, `business_sync_transaction_effects`, `business_sync_transaction_fingerprints`, `business_sync_transaction_validations` | `transfer_id` |
| `company_copies` | `organization_id`, `backup_id` |
| `document_number_reservations` | `organization_id` |
| `workspace_backups` | `organization_id`, identité `backup_id` existante |
| `workspace_backup_chunks` | `backup_id` |

Les tables/colonnes/index sont vérifiés contre le schéma final obtenu en exécutant les migrations réelles 0000–0084, et non contre un schéma de test simplifié. Le fichier custom est enregistré après 0085 par `node node_modules/drizzle-kit/bin.cjs generate --custom --name international_legacy_country_guards` ; la génération conserve les entrées de journal précédentes.

## Réservation d’une identité neuve dans 0085

Le rejet des traces antérieures lors de INSERT intention doit couvrir les treize tables munies de `organization_id` dans cet inventaire : `business_sync_audit_branches`, `business_sync_number_floors`, `business_sync_publications`, `business_sync_retirement_cancellations`, `business_sync_retirements`, `business_sync_spaces`, `business_sync_transaction_changes`, `business_sync_transaction_commits`, `business_sync_transfers`, `business_sync_versions`, `company_copies`, `document_number_reservations`, `workspace_backups`.

Les quatre tables à `object_key` peuvent aussi révéler un orphelin par le namespace exact ci-dessus. Les autres enfants sans parent, sans `organization_id` et sans `object_key` ne permettent pas une attribution fiable à une entreprise. C’est aussi le cas de `workspace_backup_chunks` sans sa sauvegarde parent. Ne pas les présenter comme une preuve de vacuité par organisation. L’allocation serveur d’un identifiant neuf et le refus des traces attribuables restent nécessaires.

Une inspection `PRAGMA table_info` de toutes les tables après l’application de 0000–0086 ne trouve aucune colonne D1 `source_organization_id`, `from_organization_id` ou `to_organization_id`. Les sources métier réelles passent par `source_transfer_id` (reviews/commits) et `bootstrap_transfer_id` (spaces/number_floors), puis `business_sync_transfers.organization_id`. Les références `referrer_organization_id` et `referred_organization_id` existent dans `referral_claims`, hors des 38 tables de ce lot.

## Points d’intégration API et stockage

`requireLegacyCountryTransport(organizationId, suppliedDatabase?)` ne lit que `SELECT 1`. Il lève une erreur publique 409 avec le code stable ci-dessus et propage une indisponibilité de la base ; une erreur de lecture ne devient jamais une autorisation. Il doit s’exécuter après l’authentification et la vérification de l’entreprise exacte, avant toute lecture de corps, accès stockage ou appel PG legacy. Les reprises sans écriture SQL doivent être gardées elles aussi.

| Surface | Intégration nécessaire |
| --- | --- |
| Tous `app/api/sync/**` | Précontrôle avant bootstrap, validation, intégrité, publication, historique, transferts, review, fingerprint, delivery, commit et retirement. Une lecture/status ou un reçu existant ne doit pas contourner le refus. |
| [Numérotation](../../app/api/sync/numbers/route.ts) | Précontrôle **avant** la sélection PG/D1. Aucun repli legacy fondé sur une révision zéro. Le trigger D1 ne ferme pas le RPC PG. |
| Tous `app/api/backups/**` | Inclure les accès navigateur `account` et `account/file`, pas seulement la session appareil. Respecter les droits propres à la récupération ; ne pas introduire une exigence de paiement pour les récupérations CH existantes. |
| [Copie partagée](../../app/api/account/company-copy/route.ts), action `company-copy` dans [team](../../app/api/account/team/route.ts) | Refuser publication, lecture et téléchargement legacy pour l’identité US. |
| [Collaboration PG legacy](../../app/api/account/collaboration/route.ts) | Précontrôle avant prepare/prepare-content/commit, watch/read et réception de fragments/blobs. Les garde SQL PG restent nécessaires sous le même verrou PG. |
| Fonctions de bibliothèques appelables directement | Garder aussi leurs entrées/contextes : une garde de route ne couvre pas un appel interne hors HTTP. Les exports de `business-sync-bootstrap`, `business-sync-files`, `business-sync-transactions`, review/validation/fingerprint/delivery/commit/retirement, `workspace-backup` et `company-copy` ont des lectures et retries sans mutation. |
| Autres transports legacy identifiés | `app/api/projects/sync/**`, `app/api/archive/invoices/**` et la récupération `archive/account/**` utilisent d’autres tables/objets. Ils ne sont pas fermés atomiquement par ces 38 tables ; leur admission/routage doit également refuser l’identité US. |

Ne pas ajouter aveuglément cette interdiction à toute authentification internationale : le futur moteur US doit conserver sa propre autorité d’édition. La sélection du transport doit être explicite. Les intentions incomplètes doivent rester absentes des sélecteurs et appareils legacy.

### Uploads extérieurs à la transaction D1

Les chemins suivants écrivent les octets avant le reçu SQL :

- [bootstrap](../../lib/business-sync-bootstrap.ts#L493) ;
- [pages catalogue](../../lib/business-sync-files.ts#L364) et [fragments binaires](../../lib/business-sync-files.ts#L600) ;
- [fragments transaction](../../lib/business-sync-transactions.ts#L297) ;
- [fichiers transaction](../../lib/business-sync-transaction-files.ts#L151) ;
- [positions canoniques](../../lib/business-sync-transaction-delivery.ts#L200) ;
- [sauvegardes](../../lib/workspace-backup.ts#L249) ;
- [collaboration PG](../../lib/company-collaboration.ts#L115) et [contenu PG/R2](../../lib/company-content.ts#L60).

Le précontrôle ne constitue pas un verrou distribué. Exiger une réservation/admission autorisée avant upload, préserver la garde atomique au reçu/finalisation, contrôler l’édition et la portée de tout jeton de stockage, et traiter les objets orphelins séparément. Le rollback D1/PG ne supprime pas des octets déjà durables. Aucun test SQL de ce lot n’affirme « zéro upload R2 ».

## Vérifications locales et limites

La suite dédiée a passé 15 tests : précontrôle minimal, erreurs de lecture, trois états synthétiques, mutations sur les 38 tables, liens falsifiés OLD/NEW/source, namespace exact et voisin, chaque clé unique sous REPLACE, absence de changement CH et inventaire complet des 114 triggers. Les mêmes triggers sont exécutés dans le runtime workerd/D1 de la version Wrangler épinglée, avec les vrais schémas finaux et index, et un batch CH+US confirme le rollback atomique.

Un deuxième test workerd applique directement **tous les fichiers de migration 0000–0086**, y compris le dernier rejet 0085 des traces legacy. Il vérifie le rollback d’un batch « réservation US puis bootstrap legacy », le refus d’un bootstrap après réservation durable et le refus de READY. Le store réel `d1WorkspaceCreationStore` réserve simultanément huit candidats d’identités distinctes pour le même acteur/request : une seule intention durable gagne. `find` retrouve cette identité, `confirm` conserve son reçu exact même lorsqu’une reprise soumet `replayed:true`. Huit appels concurrents au service réel `createOrResumeUsWorkspace` aboutissent également à une seule intention et à sa reprise stable, sans créer d’organisation, de membre ni de droit US. **Le port d’admission de ce test est simulé ; ce n’est pas le RPC PostgreSQL réel.**

Les six suites legacy bootstrap/publication/fichiers/numérotation/sauvegardes/copie ont également passé 260 tests ; 51 fixtures optionnelles sont explicitement sautées. Elles incluent des cas workerd D1 existants. Le test de préparation canonique rapporte 84 requêtes de pointe pour un budget de 100. Les triggers n’ajoutent pas un appel Worker D1 par ligne ; leurs lectures s’exécutent dans la mutation existante et peuvent néanmoins accroître les lignes lues et le temps CPU. Chaque trigger est une instruction de migration distincte : 114 pour 0086, avec dépendance préalable aux six instructions DDL de 0085. La plus grande instruction 0086 mesure 2 413 octets UTF-8. Le budget de déploiement doit donc traiter les migrations via l’outil prévu, sans assembler les 114 instructions dans une seule requête applicative. Ces tests ne constituent pas une mesure de quota/coût D1 en production.

Le test SQLite charge également toute la chaîne de migrations, 0085 et 0086 incluses. Pour isoler la politique des gardes dans les trois états, les fixtures d’état reprennent le DDL réel de la table 0085 mais omettent explicitement ses triggers de transition et utilisent des reçus synthétiques. **Elles ne prouvent aucune admission READY, aucun reçu PG réel, aucun droit ou abonnement US.** Le trigger de production `international_intent_ready_unavailable` reste en place.

Commande dédiée : `node node_modules/vitest/vitest.mjs run --config vitest.config.ts lib/international/legacy-country-guard.test.ts lib/international/legacy-country-guard.migrations.test.ts`.

Les tests D1 locaux ne prouvent pas la concurrence interservices D1/PG, la sérialisation en staging, les pannes à chaque frontière, l’absence d’octets externes ni le retour d’un ancien appareil physique. Ces critères restent distincts avant toute ouverture US.
