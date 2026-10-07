# Zentra US — raccord backend et persistance, 8 octobre 2026

## Périmètre de l'examen

Audit en lecture seule du socle `lib/international`, de son API, de la migration nationale et des tests dans `C:/Users/alb/Documents/ChatGPT/chantier`. Comparaison avec le site courant dans `D:/Codex-Zentra-Temporary/2026-10-07/site-tour-update`, commit vérifié **69a3981fd1f01ea6039325cd35ab09ca89754137**, checkout propre au début de l'examen. Lecture préalable de `AUDIT.md`, `DELIVERY.md` et de la note backend du 7 octobre.

Ce rapport est le seul fichier ajouté par cet audit. Aucune migration, écriture Supabase/D1, modification Stripe, donnée client ou publication n'a été réalisée. Les constats live du 7 octobre sont des observations antérieures : le présent audit vérifie les sources, pas le schéma de production du 8 octobre.

## Conclusion utile à la prochaine phase

Le socle US contient des calculs et des transitions utilisables, mais aucune facture, aucun client ni journal US n'est actuellement persisté par ces fonctions. L'API existante ne concerne que la configuration nationale. Ajouter une transaction PostgreSQL réelle est la prochaine étape pertinente, à condition de choisir une autorité métier unique et de construire également son raccord à l'application native. Une nouvelle table SQL et une API ne suffiront pas à rendre les menus existants de Gestion US opérationnels.

Le gateway compte du site courant est réutilisable pour l'identité, l'appartenance, les sièges et les sessions appareil. Le modèle `zentra_workspaces` est le bon parent de configuration pour cette source. En revanche, sa `revision` représente un snapshot d'entreprise SQLite. Il ne faut pas incrémenter ce head pour une facture SQL qui n'a aucun snapshot correspondant, ni écrire indépendamment dans un journal US SQL et le journal local.

## Divergences vérifiées entre les sources

| Source | État vérifié | Conséquence |
| --- | --- | --- |
| Root, socle international | `lib/international/**`, `app/api/international/workspaces/[organizationId]/country/route.ts`, migration `20261007194528_international_workspace_country_config.sql` présents, sans raccord métier persistant | Porter uniquement les ajouts internationaux après revue, pas tout le checkout ancien |
| Site actuel, commit `69a3981f` | Ces trois ensembles sont absents, y compris `docs/internationalization` | Le prototype local n'est pas une fonctionnalité du site courant |
| Root, audit précédent | Contrats historiques 60/61 et version courante 62 documentés | Ce contrat ne décrit pas automatiquement le site courant |
| Site actuel, `lib/business-sync-transaction-format.ts:61`, `:103`, `:151` | Type et validation imposent `schema_version: 60` | Ne pas copier les fichiers `business-sync-*` du root en bloc ni transformer des reçus historiques |
| Site actuel, `/api/sync/transactions/commit` | Réponse explicite `canonical_committed: true`, `replication_active: false` | Le reçu canonique D1 ne constitue pas une passerelle US déjà répliquée dans les installations |
| Site actuel, `/api/account/collaboration` | Gateway appareil, snapshots Supabase et contenu, watch Realtime privé serveur | Conserver ce transport CH et ses invariants ; un nouveau head US devra avoir son propre protocole |

La version native autoritaire doit être rapprochée séparément de ces deux sources. Cet audit n'a pas modifié l'application native ni vérifié un binaire installé.

## Garanties déjà présentes

### Configuration nationale

`workspace-server.ts` refuse l'accès lorsque `INTERNATIONAL_CORE_ENABLED` n'est pas exactement `true`. Identité et appartenance D1 sont vérifiées avant l'ouverture du client Supabase privilégié. Écriture réservée au propriétaire, origine vérifiée, JSON borné à 16 KiB et liste de champs exacte. La configuration soumise doit désigner l'organisation autorisée ; aucun rôle ou entitlement fourni par le client n'est accepté.

`workspace-service.ts` charge le workspace correspondant et traite une configuration absente comme juridiction inconnue. Il ne crée ni workspace ni ligne CH implicitement. La réponse privilégiée est validée avant exposition. CAS et reçu idempotent sont reliés à la requête exacte.

La migration proposée verrouille le workspace lors de la création/mutation, conserve un reçu append-only, refuse un rejeu modifié et verrouille pays, devise et base comptable après confirmation. RLS et révocations `PUBLIC/anon/authenticated` sont explicites ; RPC `SECURITY INVOKER`, `search_path` vide, serveur seul. Elle nécessite le schéma workspace réconcilié et n'est pas une migration appliquée en production.

### Calculs et transitions US

- `money.ts` et `accounting/ledger.ts` manipulent des unités mineures entières sérialisées en chaînes ; aucun calcul financier en flottants n'est nécessaire.
- `invoicing.ts:87` exige devis accepté, devise de configuration, dates valides et détermination fiscale correspondant à la révision, localisation et date de transaction.
- `ledger.ts:95` recontrôle scope, permission financière et entitlement avant rejeu ; CAS, comptes, période ouverte et débits égaux aux crédits sont vérifiés.
- Les écritures sont corrigées par contrepassation liée ; le code ne supprime pas l'historique validé.
- `postings.ts` sépare cash/accrual, émission et encaissement, AR/AP et taxe d'achat incluse dans le coût US. Il ne réutilise pas le crédit de TVA suisse.
- `documents.ts:552` définit un port de numérotation et une identité de conversion ; le port exige compteur, reçu et conversion atomiques, mais son adaptateur réel est absent.

Ces garanties existent à la portée de fonctions pures ou de ports. Les `Object.freeze` et la révision mémoire ne remplacent pas des contraintes de stockage concurrent.

## Lacunes de code à fermer

1. **Pas d'adaptateur métier persistant.** `invoiceFromEstimate`, `recordCustomerPayment`, `postJournal`, `postCustomerInvoice` et les rapports ne reçoivent que des objets mémoire. Il n'existe ni CRUD de clients/devis US, ni transaction de conversion, ni migration de journal SQL.
2. **Numéro et émission restent séparés.** `reserveDocumentNumber` ne persiste pas une facture. Employer sa réservation puis une autre insertion libre permettrait une émission partielle ou des doubles conversions ; l'opération doit avoir un seul commit.
3. **Validation HTTP métier absente.** Les types `Contact`, `Estimate`, `SalesLine` et `JournalInput` ne sont pas des validateurs de payloads inconnus. `validateEstimate` vérifie une partie des invariants métier, mais ne fournit pas la liste de champs exacte, les limites HTTP, les références persistées de client/projet, ni l'autorité d'acceptation. Le gateway doit charger les références de la même entreprise et construire les objets validés.
4. **Les booléens d'autorité ne sont pas un entitlement réel.** `InvoicingAuthority.managementEntitled/canIssue` et `FinancialAuthority` sont des contrats serveur. Aucun lecteur de droit Gestion effectif n'est raccordé au socle. Dans le site actuel, `requireBrowserMembership` appelle les sièges, mais `requireMemberSeat` ne vérifie pas systématiquement l'expiration des abonnements Stripe ordinaires ; `requireDeviceSession` vérifie une validité effective supplémentaire. Un nouveau endpoint navigateur ne doit donc pas interpréter membership/siège comme accès Gestion payant actif.
5. **Révocation distribuée non atomique.** D1 détient les membres/droits et PostgreSQL les nouveaux effets. Le `p_actor` de la RPC country est un acteur déjà validé par le gateway ; PostgreSQL ne peut pas relire les membres D1 dans sa transaction. Recontrôler avant commit est nécessaire, mais ne prouve pas une barrière transactionnelle avec une révocation concurrente. Il faudra une décision d'architecture explicite pour les effets financiers/Automation : autorité/admission versionnée synchronisée dans le store de l'effet, ou orchestrateur avec point de linéarisation documenté et reprise. Ne pas prétendre qu'une seconde lecture D1 résout seule ce problème.
6. **Preuve fiscale encore forgeable si directement exposée.** `validateTaxAssessment` vérifie cohérence et dates, pas l'authenticité d'un fournisseur. L'utilisateur propriétaire peut marquer `taxConfiguration.status` comme `configured` sans enregistrer une intégration fiscale réelle. Le serveur doit charger une preuve fiscale durable issue du prestataire approuvé, ou une exemption explicitement autorisée et documentée ; le JSON libre du client ne doit pas devenir cette preuve. Aucun taux US universel ou provider fictif ne doit être activé pour compenser cette absence.
7. **Archive du vendeur incomplète.** La facture fige la configuration, mais `PublicSellerDetails.displayName/contactEmail/contactPhone` est fourni à la projection depuis un loader externe. La transaction d'émission doit archiver également ces données publiques, le contexte documentaire et la version de règles ; une réimpression doit utiliser cette archive.
8. **Pas de bridge US dans l'app.** Les objets de la fixture ne sont pas dans les tables SQLite, le workspace, les soldes, les listes ou les rapports des écrans existants. Ajouter une API sans ce raccord ne rendra pas Gestion US fonctionnel sur Windows/Mac/mobile.
9. **Événements et restauration à définir.** Les écritures SQL US ne déclenchent ni head consommé par l'app, ni delta, ni notification durable ou backup/recovery international. Le broadcast doit rester une indication : reprise et reconnect doivent relire le head durable et les changements.
10. **Limites des tests SQL actuels.** Le runner country crée un parent réduit à `organization_id`, avec PGlite en mémoire. Il ne valide ni PostgREST réel, ni le parent workspace complet, ni les transactions concurrentes sur deux connexions PostgreSQL, ni les frontières D1/Postgres.

## Implémentation persistée proposée, incrémentale

### 1. Choisir et figer la source de livraison

Créer une branche dérivée du site courant, transférer les seuls ajouts internationaux après comparaison, préserver les contrats CH. Réconcilier l'app actuelle, le site et le schéma avant toute activation. Le déploiement et les migrations de production restent soumis à l'approbation explicite requise par la mission.

### 2. Store US et transaction d'émission

Ajouter un store US lié au workspace, sans backfill ni modification des snapshots CH. Prévoir des tables relationnelles pour clients, devis et lignes, preuves fiscales, compteurs/reçus de conversion, factures archivées, paiements, comptes/périodes, écritures/lignes, audit et outbox. Toute FK métier est composite avec `organization_id`. Les montants sont `numeric(...,0)` bornés selon le contrat exact partagé, ou un entier adapté ; aucun `real/double precision`.

Un RPC/service de commit unique doit charger la configuration nationale, verrouiller son contexte et le head US, revalider les revisions des références/devis/période, vérifier la preuve fiscale autorisée, allouer le numéro, enregistrer la facture et le vendeur historiques, inscrire le journal équilibré selon la méthode choisie et écrire un reçu/outbox durable. Aucun échec de notification ne doit masquer le succès du commit. Les permissions de tables/RPC restent fermées aux clients ; triggers/contraintes empêchent la modification/suppression d'écritures validées et l'altération du reçu.

Unicités minimales : `(organization_id, request_id)`, numéro par type et organisation, conversion `(organization_id, estimate_id, estimate_revision)` et paiement/effet par clé stable. Même requête après réponse perdue = même reçu, même numéro et aucun nouvel effet. Nouvelle charge utile avec ancienne clé = conflit explicite. CAS périmé = aucune écriture.

Une simple mise à jour JSON de toute l'entreprise à chaque opération ne convient pas à un journal croissant : lectures paginées, comptes et périodes ciblés, indices sur scope/date/source et calculs SQL exacts sont nécessaires.

### 3. API et autorité réutilisées

Boundary navigateur : `getZentraUser({ refreshSession: true, offerAccess: false })`, membership/rôle/siège, droit Gestion effectif courant, pays US explicitement confirmé et capacités configurées. Boundary appareil : `requireDeviceSession`, scope fourni par la session, jamais rôle/tenant/entitlement dans le JSON. Les deux utilisent une validation métier commune et le même service ; les cookies navigateur et Bearer appareil ne se substituent pas.

Les créations de drafts peuvent être accessibles au rôle commercial autorisé ; la validation du journal exige les rôles financiers actuels. Lire les droits avant et au moment du commit selon l'admission choisie ; une réponse de rejeu ne contourne pas une révocation. JSON borné, erreurs publiques typées/redactées, request ID de corrélation, logs sans contenu de facture ni secrets, rate limits sur acteur/entreprise et pagination sont requis.

### 4. Raccord à l'application et synchronisation

Ajouter un bridge US distinct depuis la source native actuelle. Choisir explicitement si PostgreSQL est l'autorité US et SQLite une projection/cache avec drafts et file locale idempotente ; dans ce cas, la commande ne publie pas simultanément un snapshot financier indépendant comme nouvelle autorité. Les effets approuvés sont appliqués localement à partir des reçus/deltas durables et mis à jour sur tous les appareils.

Le head US a sa révision propre, indépendante de `zentra_workspaces.revision`. Réutiliser les motifs du watch serveur, avec channel privé propre et lecture du head après wake/reconnexion. Une file outbox garantit reprise ; notification absente/dupliquée ne peut perdre un changement. Les données hors ligne doivent conserver l'identité de l'opération et être soumises aux contrôles actuels au retour réseau. Émission/effet fiscal nécessitant un service indisponible reste explicitement en attente, sans prétendre que le numéro ou la taxe est définitif.

### 5. Tests de sortie de cette étape

- PostgreSQL de recette représentatif : toute migration additive, grants/RLS, clés composites, exact money, périodes, équilibre, immutabilité, inversion et rollback.
- Deux connexions réelles : deux conversions concurrentes, compteur et journal CAS, clôture concurrente, réponse perdue/rejeu, clé réutilisée avec payload différent.
- Gateway réel sur fixtures D1 : anonyme, autre entreprise, membre révoqué, `read_only`, abonnement expiré, rôle modifié pendant une requête, différence cookies/Bearer, référence client/projet d'un autre tenant.
- Cycle réellement persisté : client → devis accepté → facture USD/Letter sans QR CH → paiement partiel → journal/AR/cash et rapports → réouverture après redémarrage.
- App + deux appareils de recette : delta reçu, offline/reconnect, conflit conservant les edits, changement d'espace CH/US, absence de mélange des devises et données.
- Régression CH sur la source de livraison : QR/TVA/anciens documents, contrats et reçus inchangés, Stripe CHF et langues existantes.

Les opérations bancaires, le prestataire de sales tax, les Price IDs USD approuvés et les autres modules US restent des étapes obligatoires du but global. Ce premier flux persisté ne doit pas être présenté comme l'ERP US entier achevé.

## Plan de fichiers proposé

| Ensemble | Fichiers/zone | Travail |
| --- | --- | --- |
| Socle commun à porter | `lib/international/**` + route country existante | Ajouts ciblés dans la source actuelle, dépendances compatibles |
| Boundary métier | `lib/international/management-validation.ts`, `management-service.ts`, `management-server.ts` | Validation inconnue, droits réels, chargement scoped, erreurs et admission |
| Persistance | `lib/international/persistence/postgres-store.ts`, `receipts.ts` | RPC atomiques et contrôle des réponses privilégiées |
| HTTP | `app/api/international/workspaces/[organizationId]/{customers,estimates,invoices,payments,ledger,changes}/route.ts` | CRUD/drafts, actions bornées, lecture paginée, device/browser boundary distinct |
| Base | Nouvelle migration créée avec le CLI Supabase, `supabase/tests/database/international_management.test.sql` | US relationnel, reçus, FKs tenant, ledger immuable, outbox, RPC/grants |
| Recette SQL | `scripts/international/test-management-migration.mjs` | Fixture complète et, séparément, concurrence PostgreSQL multi-connexions |
| Recette API | `lib/international/management-*.test.ts`, `persistence/*.test.ts` | Auth, isolation, expiration, CAS, rejouabilité et tax evidence |
| Native, source actuelle | Bridge/commands US + migrations SQLite additives + store UI par espace | Projection/cache, drafts, delta, émission US ; aucune modification silencieuse du moteur CH |
| Documentation | `docs/internationalization/{PERSISTENCE,DELIVERY,MIGRATIONS}.md` | Autorité choisie, état activé/non activé, preuves, limites et restauration |

Ces noms sont un plan, pas des fichiers livrés ni des routes disponibles.

## Vérification exécutée dans cet audit

Le 8 octobre, commande réelle : Node fourni → `node_modules/vitest/vitest.mjs run lib/international/workspace-service.test.ts lib/international/workspace-server.test.ts lib/international/documents.test.ts lib/international/finance.test.ts --maxWorkers=1` dans le root.

Résultat : **4 fichiers, 132 tests réussis**, code de sortie 0 (service 25, boundary HTTP 18, documents 33, finance 56). Ces tests utilisent mémoire et doubles de stockage ; ils ne prouvent pas une transaction PostgreSQL métier, la précision fiscale, la compatibilité de production ou la synchronisation multi-appareils. Les tests SQL, le build, Stripe et les binaires n'ont pas été relancés par cet audit.

## Suite autorisée après l'audit : persistance US de recette, 8 octobre

Le plan initial ci-dessus était un diagnostic avant implémentation. Une étape additive a ensuite été autorisée : un premier flux US transactionnel dans le root, sans appliquer de migration à un projet distant ni activer de fonctionnalités de production.

Fichiers livrés pour cette étape :

- `supabase/migrations/20261007222349_international_us_erp_persistence.sql`, créée initialement avec `supabase migration new international_us_erp_persistence` (CLI 2.119.0) ;
- `scripts/international/test-us-erp-migration.mjs`, recette SQL synthétique reproductible ;
- `lib/international/runtime-postgres.test.ts`, tests du vrai moteur métier, de son adaptateur Supabase et du boundary HTTP sur PostgreSQL WASM ;
- `docs/internationalization/evidence/us-erp-sql-20261008.json` et `us-erp-runtime-postgres-20261008.json`, sorties des essais effectivement exécutés.

Les types, moteur, adaptateur TypeScript, boundary HTTP et route associés sont réalisés en parallèle par l'agent principal dans `lib/international/runtime*` et `app/api/international/workspaces/[organizationId]/erp/route.ts`. Les noms de fichiers du plan précédent ne signifient donc pas que ces routes détaillées ont toutes été créées.

### Contrat PostgreSQL

Trois fonctions `SECURITY INVOKER`, avec `search_path` vide, réservées à `service_role` :

| RPC | Paramètres | Résultat |
| --- | --- | --- |
| `zentra_read_us_erp` | `p_organization` | État agrégé de l'entreprise, ou `null` |
| `zentra_us_erp_receipt` | `p_organization`, `p_idempotency_key` | Reçu de cette entreprise, ou `null` |
| `zentra_commit_us_erp` | `p_organization`, `p_expected_revision`, `p_header`, `p_changes`, `p_ledger_audit`, `p_receipt`, `p_actor` | Reçu après commit atomique, ou même reçu au rejeu |

Le commit verrouille le workspace et sa configuration nationale, puis vérifie la révision propre au nouveau head US. Il conserve un petit header, les seuls enregistrements modifiés (client, devis, facture, journal), les nouveaux événements d'audit et le reçu. Les compteurs, facture, écriture et reçu sont engagés dans une seule transaction. Aucun numéro n'est consommé si le commit échoue. `zentra_workspaces.revision` reste inchangé : aucun nouveau snapshot historique n'est simulé.

Les tables US ont la RLS et aucune permission de lecture/écriture/exécution pour `anon` ou `authenticated`. L'autorisation de session, membership D1, rôle et abonnement reste à la charge du serveur avant l'appel privilégié ; cette migration ne crée pas un modèle de membership PostgreSQL fictif. Les rôles métier sont revérifiés même pour le rejeu d'un reçu. Les codes publics `PU001` à `PU006` distinguent conflit de révision, conflit d'idempotence, historique immuable, état invalide, workspace indisponible et configuration modifiée.

Les écritures validées, reçus et événements d'audit sont append-only. Les factures émises ne changent que par ajout d'un paiement, avec préservation exacte des paiements précédents. La base refuse un journal équilibré dont montant, comptes, dates, identité ou source ne correspondent pas à la facture ou à l'encaissement. Les comptes utilisés doivent conserver leur sens (créances actif, banque actif, ventes revenu, taxe due passif). Quantités, remises, montants et allocation progressive cash utilisent des entiers décimaux exacts et un arrondi explicite, sans flottants. Le plafond financier reste **36 chiffres**, identique à `accounting/ledger.ts` ; l'outil mathématique générique `money.ts` peut accepter davantage de chiffres, ce qui ne définit pas le plafond du journal.

L'émission US conserve le contenu du devis accepté, sa version et son client. Subtotal, remise, somme fiscale et total sont réconciliés avec les lignes. La preuve fiscale doit correspondre au pays US, à l'entreprise, à la devise USD, au document/version, à ses lignes, à sa date et aux adresses de la requête. Sa source ne peut pas être la TVA suisse. Ces contrôles ne certifient ni le prestataire externe ni les obligations de nexus : la preuve provient obligatoirement du service serveur autorisé, jamais du JSON de commande soumis par l'utilisateur.

La commande propriétaire `refresh_configuration` permet de passer explicitement d'une fiscalité non configurée à configurée et d'actualiser langue, fuseau, adresse, EIN, préfixe et état fiscal. Organisation, pays, devise, base comptable et schéma restent immuables. Les configurations archivées dans les anciennes factures sont conservées ; les futures émissions utilisent les nouveaux paramètres. Les périodes fermées ne sont pas rouvertes silencieusement.

### Résultats exécutés

Le 8 octobre à 00:44 heure suisse (22:44 UTC le 7), sur **PostgreSQL 18.3 / PGlite 0.5.8**, avec une base éphémère et des données entièrement fictives :

- **57/57 contrôles SQL réussis** : migration additive, RLS/grants, isolement par clés, compteur et CAS, idempotence, rollback, preuve fiscale incohérente, mauvais effet comptable malgré équilibre, immutabilité, paiements, périodes, actualisation propriétaire, conservation du head snapshot et absence d'effets sur CH ;
- **9/9 tests Vitest réussis**, avec `PGLITE_MODULE_DIR` effectivement défini : vraie chaîne `executeErp → createSupabaseErpStore → RPC SQL`, comptabilité cash/accrual, 3 encaissements fractionnés et arrondi final, rapports reconstitués, réponse perdue après commit, deux requêtes conflictuelles, prestataire absent, configuration initiale non terminée puis actualisée, nouvelles factures après changement de préfixe, montants exacts au-delà de `Number.MAX_SAFE_INTEGER`, chaîne HTTP et contrôle d'abonnement sur doubles d'autorité ;
- SHA-256 de la migration testée : `80a2fae2ddf7e59d64d2ffb49c51ba61842c02f57700f3f013fa4a877a5bf68c`.

Commandes reproductibles, depuis le root, après installation séparée de PGlite :

```powershell
$env:PGLITE_MODULE_DIR='D:/Codex-Zentra-Temporary/2026-10-07/international/postgres-tests/node_modules/@electric-sql/pglite'
node scripts/international/test-us-erp-migration.mjs
node node_modules/vitest/vitest.mjs run lib/international/runtime-postgres.test.ts --maxWorkers=1
```

Si l'installation PGlite n'est pas explicitement disponible, les 9 tests Vitest sont marqués ignorés ; un résultat sans cet environnement ne constitue pas la preuve SQL. Le runner SQL, lui, refuse de démarrer sans chemin absolu valable. Aucune dépendance PGlite n'a été ajoutée au produit.

### Limites et sortie de recette

PGlite exécute du vrai PostgreSQL, mais utilise une connexion en file. Les conflits CAS y sont vérifiés ; une charge réseau multi-connexions, PostgREST, la région de Supabase, l'autorité D1 réelle, l'actualisation live des abonnements, le bridge SQLite natif et la synchronisation de deux appareils ne sont pas prouvés par ces tests. La fenêtre de révocation entre D1 et PostgreSQL, déjà identifiée dans l'audit, doit être traitée avant activation financière de production.

Les projets persistés US, fournisseurs/achats, documents finaux, vrais moyens de paiement clients, catalogue Stripe USD approuvé, moteur sales tax réel, replay/delta natif, fonctionnalités Support/Automation internationales et pilote multi-appareils restent des étapes distinctes. Cette livraison est le premier flux ERP US persisté de recette, pas un ERP américain complet ni une certification US GAAP.

Retour arrière non destructif : laisser les accès US désactivés, revenir à la version précédente du service et conserver les tables/reçus/audits. Aucun `DROP`, nettoyage des clients ou déclenchement de migration de production n'est proposé par défaut. Le schéma déployé doit être réconcilié puis la migration testée sur un staging représentatif avant toute approbation de production.

## Stabilisation suivante : curseurs et identité vendeur, 8 octobre

Deux migrations supplémentaires ont été créées séparément avec le CLI. La migration de persistance déjà validée n'a pas été réécrite :

| Migration | SHA-256 vérifié |
| --- | --- |
| `20261007224820_international_us_erp_delta_stream.sql` | `3df54310c2da0012d9065886df86a6524963ab594a1f314d10d45fac551af345` |
| `20261007225725_international_us_erp_seller_snapshot.sql` | `119e0c850c04c6772c0b002384c2cf86c8ab3427ec24586eb77f73a2a314f4f9` |

### Un curseur, les seuls changements

`zentra_us_erp_revision(p_organization)` renvoie uniquement `{ schemaVersion: 1, organizationId, revision }`, ou `null`. `zentra_us_erp_delta(p_organization, p_after_revision, p_limit)` renvoie une enveloppe scoped contenant `fromRevision`, `toRevision`, `headRevision`, `hasMore`, `resetRequired` et ses événements ordonnés.

Chaque événement contient la révision, un petit header, uniquement les records dont `state_revision` correspond à cette opération, les nouveaux éléments de ledger audit, son reçu, l'acteur et une date UTC ISO à la milliseconde. Son reçu et son header portent la même révision. Un trigger sur l'insertion finale du reçu conserve cet événement dans la même transaction que les données métier ; un rejeu du reçu ne crée rien de plus. Un échec d'insertion de l'événement annule aussi le head, le record et le reçu.

Les heads antérieurs à l'installation du stream sont conservés avec un curseur baseline correspondant à leur vraie révision. Les anciens changements ne sont pas inventés. Un curseur avant cette baseline ou un trou dans le stream renvoie `resetRequired: true`, sans événement et **sans avancer `toRevision`**. Le client doit charger un snapshot valide avant de reprendre. Si le head est inchangé, aucune donnée financière n'est renvoyée.

Les pages sont bornées à **100 événements** et **4 MiB sérialisés** (avec 4 KiB réservés à l'enveloppe). Un événement est borné à **2 MiB**. Une page coupée par la limite d'octets conserve `hasMore: true` et son dernier curseur exact ; elle n'est pas confondue avec un trou. Un événement isolé trop grand provoque `PU007` / `event_too_large`, pas une page vide qui ferait tourner le client en boucle. Le test de taille utilise des écritures serveur synthétiques ; ces gros payloads ne sont pas des requêtes publiques valides, dont le schema HTTP et la borne 256 KiB restent applicables.

Les streams, événements et wakeups sont réservés à `service_role`, avec RLS et historique immuable. La table wakeups ne contient que organisation, révision et date. Aucune publication Realtime, notamment `supabase_realtime`, n'est activée ou modifiée ; une connexion privée et autorisée de wakeups à l'app native reste à réaliser. Le curseur HTTP de recette est distinct d'une preuve de livraison live sur deux appareils.

### Archive vendeur et structures comptables

Les nouvelles factures doivent archiver `sellerSnapshot` avec organisation et nom public, et éventuellement e-mail, téléphone et référence logo UUID/hash. Les champs privés supplémentaires et les URL de logo arbitraires sont refusés. Cette whitelist ne prouve pas, à elle seule, l'accès au contenu d'un asset : son propriétaire et ses octets sont contrôlés par le loader serveur. L'immutabilité existante des factures protège cette archive.

La contrainte est ajoutée `NOT VALID` : aucune ligne historique n'est modifiée et aucun nom de vendeur n'est fabriqué. Les anciens documents US de test qui ne possèdent pas de snapshot restent physiquement intacts ; leur lecture par le nouveau moteur est refusée avec `invalid_stored_state` jusqu'à une revue et une migration administratives explicites fondées sur des informations fiables. Les anciens documents CH n'appartiennent pas à ces tables.

Un trigger additif complète les allowlists du header, du ledger, des compteurs, des comptes et des périodes. Les contrôles déjà présents refusent une modification silencieuse des catégories de comptes, un saut de compteur, une autre plage comptable ou la réouverture d'une période. Cette étape ne fournit ni ajout arbitraire de comptes ni nouvelle commande de modification de périodes.

### Preuves de l'état stabilisé

La commande PGlite/Vitest réellement exécutée à **01:04 heure suisse le 8 octobre**, sur les trois migrations ci-dessus et leurs dépendances pays, a obtenu **19/19 tests réussis, aucun test ignoré**, code de sortie 0. Le rapport est `docs/internationalization/evidence/us-erp-runtime-delta-seller-20261008.json`. Il couvre les 9 parcours précédents puis reprise/pagination jusqu'à l'état financier exact, polling inchangé, trous et baseline, deux entreprises avec le même ID client, droits SQL, rollback d'outbox et rejeu unique, borne de taille, vendeur scoped/archive immuable, legacy conservé et headers comptables incohérents refusés.

`docs/internationalization/evidence/us-erp-migrations-20261008.json` recense les trois hashes et les liens vers les preuves. Le runner initial reste archivé à **57/57** dans `us-erp-sql-20261008.json` et le premier rapport de **9/9** est une preuve historique de l'étape précédente, pas le total courant. `oxlint` avec typecheck ciblé sur les deux fichiers de test/runner et `git diff --check` ont terminé avec code 0.

Tous ces essais sont exécutés sur des fixtures PostgreSQL WASM jetables, avec providers et autorités synthétiques. Ils n'activent ni production, ni abonnements, ni prestataire fiscal, ni publication WebSocket, ni binaires natifs. Ils ne prouvent pas la concurrence réseau multi-connexions, une capacité de 150 entreprises, la latence live, ou la fin des phases C/D. Le diagnostic des étapes encore nécessaires indiqué précédemment demeure applicable.
