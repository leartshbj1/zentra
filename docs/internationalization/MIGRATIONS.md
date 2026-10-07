# Configuration internationale : migration proposée

Date : 7 octobre 2026. Cette proposition est additive et désactivée par défaut. Aucun SQL n'a été exécuté en production, aucune région n'a été déplacée et aucune donnée historique n'a été convertie.

## Migration et prérequis

Fichier créé par Supabase CLI 2.120.0, conformément à `migration new` :

```powershell
pnpm --config.store-dir=D:/CodexCaches/pnpm-store dlx supabase@2.120.0 migration new international_workspace_country_config
```

Le fichier obtenu est `supabase/migrations/20261007194528_international_workspace_country_config.sql`. Il ne contient aucun INSERT de données métier préexistantes, aucun UPDATE de données historiques et aucun pays par défaut.

La migration exige une table existante `public.zentra_workspaces` avec `organization_id text` unique. Ce prérequis provient des métadonnées live en lecture seule conservées dans `audit-notes/live-supabase.json`. Il n'est pas assuré par les anciennes migrations plateforme de ce checkout. La migration échoue explicitement si cette table manque.

Avant tout déploiement, rapprocher les migrations réellement appliquées et leurs définitions avec les fichiers locaux. Ne pas lancer un `db push` global sur l'historique divergent. Vérifier sur une copie de schéma sans données clients la FK, les signatures, le propriétaire des fonctions, les grants effectifs et les politiques existantes. Le rôle `service_role` doit déjà pouvoir SELECT et UPDATE le workspace pour son verrou `FOR UPDATE` ; cette migration ne lui ajoute aucun droit sur les tables historiques.

## Relations et règles

| Objet | Rôle |
| --- | --- |
| `zentra_workspace_country_configs` | Une configuration explicite par workspace : version 1, document JSON, pays, devise, révision, acteur serveur et date |
| `zentra_workspace_country_config_changes` | Journal des confirmations et modifications, avec requestId, document précédent, document nouveau et révisions ; aucune mise à jour ni suppression |
| `zentra_put_workspace_country_config` | RPC transactionnelle SECURITY INVOKER réservée à `service_role`, avec CAS et rejeu exact |
| `zentra_country_config_valid` | Validation SQL supplémentaire du document : champs permis, version, entreprise, paires CH/CHF ou US/USD, langues, zones, adresses et paramètres |

Les deux tables ont RLS activée. PUBLIC, anon et authenticated n'ont aucun grant, aucune politique permettant l'accès, ni EXECUTE de la RPC ou du validateur. Le rôle serveur dispose de SELECT/INSERT/UPDATE sur la configuration, SELECT/INSERT sur le journal et EXECUTE sur les fonctions nécessaires. Aucune fonction nouvelle n'est SECURITY DEFINER. Les fonctions fixent `search_path = ''` et qualifient leurs relations.

Une FK lie la configuration à son workspace et une autre à la révision du journal. Un trigger exige un reçu correspondant exactement au document, à l'acteur et à la date. Les triggers refusent la suppression de configuration et les UPDATE/DELETE du journal, y compris lors d'un appel SQL privilégié. Le service n'a pas de grant TRUNCATE sur ces tables. Un superutilisateur ou propriétaire SQL conserve naturellement la capacité d'altérer le schéma ; ce journal ne constitue pas un stockage externe inviolable.

Le pays, la devise et `accountingBasis` deviennent immuables après la confirmation initiale. Un changement de juridiction ou de base comptable nécessite une procédure explicite future et une analyse des documents historiques. Il n'est pas couvert par ce PUT. La langue, le fuseau, l'adresse, l'EIN optionnel, le préfixe et le statut de configuration fiscale peuvent évoluer avec une nouvelle révision et un journal. Ces changements ne convertissent aucune facture, aucun montant ni aucun exercice.

`taxConfiguration.status = configured` est un état de paramétrage ; il ne constitue pas une preuve de conformité, une registration fiscale ou une autorisation de calculer la sales tax. Un fournisseur fiscal et ses preuves devront être traités séparément.

## Frontière API et autorité

Route : `GET /api/international/workspaces/{organizationId}/country` et PUT au même emplacement. Le binding Cloudflare `INTERNATIONAL_CORE_ENABLED` doit être exactement la chaîne `true`. Binding absent ou toute autre valeur : réponse 404 `feature_unavailable`, avant authentification ou accès Supabase. Aucun consommateur legacy ou natif n'est basculé automatiquement.

La route appelle `getZentraUser`, puis `requireBrowserMembership` de l'autorité D1 existante, avec son contrôle de place. GET accepte les membres actuels, y compris en lecture seule. PUT exige le propriétaire (`owner`) ; le rôle admin est insuffisant pour confirmer une juridiction. L'organisation renvoyée par l'autorité doit correspondre au chemin. Aucun rôle, userId ou entitlement transmis par le navigateur n'est utilisé.

PUT applique `requireAccountSameOrigin`, un corps JSON limité à 16 KiB et une liste exacte de champs. Les paramètres inconnus sont refusés avant l'ouverture du client Supabase. Le document est revalidé côté serveur avec `validateCompanyConfiguration`, et son `organizationId` doit correspondre à l'organisation autorisée.

```json
{
  "expectedRevision": 0,
  "requestId": "10000000-0000-4000-8000-000000000001",
  "configuration": {
    "schemaVersion": 1,
    "organizationId": "example-org",
    "country": "US",
    "currency": "USD",
    "language": "en",
    "timeZone": "America/New_York",
    "address": {
      "country": "US", "line1": "10 Example Road",
      "postalCode": "10001", "city": "New York", "subdivision": "NY"
    },
    "accountingBasis": "cash",
    "invoiceNumberPrefix": "INV",
    "taxConfiguration": { "status": "unconfigured" }
  }
}
```

Le premier PUT explicite du propriétaire, avec expectedRevision 0 et un document complet, constitue la confirmation initiale. L'interface qui l'utilisera devra rendre cette confirmation compréhensible. Aucune sélection ne doit provenir du pays du navigateur, de la langue, de l'adresse IP, de Stripe, d'un profil utilisateur ou des anciens settings.

GET vérifie aussi que le workspace existe avant de chercher sa configuration. Une absence de configuration renvoie `status: unconfigured`, `country: unknown`, `revision: 0`, `requiresAdministrativeReview: true` et `preserveLegacyBehavior: true`. Un workspace absent renvoie `workspace_unavailable` (409) ; la route ne le crée pas et ne copie pas implicitement une organisation D1 dans Supabase. L'alignement des identifiants D1 et workspace doit être vérifié lors de l'intégration staging.

La RPC verrouille une ligne du workspace, compare la révision et insère journal et configuration dans la même transaction. Une révision devenue obsolète produit 409 `revision_conflict`, sans écriture partielle. Une demande initiale concurrente ne peut pas écraser la première confirmation. Une nouvelle requestId est requise pour une nouvelle modification. Le rejeu du même triplet acteur/requestId/document avec la même révision attendue renvoie le reçu initial et `replayed: true`, même si une modification plus récente a été confirmée depuis. Réutiliser cette requestId pour une autre demande produit `request_id_conflict`.

Les erreurs d'amont, paramètres soumis, URL de base et secrets ne sont jamais renvoyés. Les réponses utilisent `Cache-Control: no-store`, `nosniff` et `no-referrer`. Il n'existe pas d'endpoint public de lecture du journal. D1 et PostgreSQL restent deux transactions distinctes : l'appartenance est vérifiée avant chaque appel serveur, sans prétendre rendre atomique une révocation D1 et une écriture PostgreSQL simultanées.

## Validation locale et passage en environnement contrôlé

Tests HTTP/service : `lib/international/workspace-service.test.ts` et `workspace-server.test.ts`, exécutés avec Vitest 4.0.18 : **43 tests passés, 2 fichiers**, le 7 octobre 2026 à 22:01 heure locale. Ils couvrent feature flag absente/désactivée, session, rôles, périmètre d'entreprise, CSRF, taille/format, champs d'autorité, inconnus legacy, CAS, rejeu et erreurs expurgées. Ils utilisent des mocks d'autorité et de stockage : ils ne prouvent pas le déploiement Cloudflare ni les permissions d'une base live.

`supabase/tests/database/international_country.test.sql` contient **17 assertions SQL**, dans une transaction avec ROLLBACK : absence de backfill, RLS/grants/EXECUTE, rôle service_role réel, workspace absent, portée du document, validation, confirmation atomique, rejeu, conflit de requestId, CAS, verrou de juridiction/base, mise à jour auditée et journal append-only. Le runner reproductible ci-dessous a exécuté et validé les **17/17** assertions sur le fichier final le **7 octobre 2026 à 20:08:26 UTC**. SHA-256 migration : `097bcc42c4e2cd8835a62b240152038711d9b3e2d88dda8cc4da9cb8d151cae9` ; SHA-256 test : `fdea0dba2320ec1162154c92f71cd89cab2ebff40e2c7a886aee53ea45aa7699`. Le typecheck complet `tsc --noEmit --incremental false` a passé.

Le runner reproductible est `scripts/international/test-country-migration.mjs`. Il exige le chemin absolu d'une installation séparée de PGlite, sans ajout de dépendance au package root, sans résolution par un outil global et sans URL/clé de production. Il crée une base WASM éphémère, ses trois rôles et un parent workspace synthétique, puis applique uniquement la migration nommée ci-dessus et les assertions. Sa sortie JSON peut être archivée comme preuve.

```powershell
$env:PGLITE_MODULE_DIR='D:/Codex-Zentra-Temporary/2026-10-07/international/postgres-tests/node_modules/@electric-sql/pglite'
node scripts/international/test-country-migration.mjs
```

PGlite **0.5.8** utilise ici **PostgreSQL 18.3** ; le projet live observé utilisait **PostgreSQL 17.6**. Ce ne sont pas les mêmes versions. Une exécution sur ce stub vérifie le SQL et les permissions créées dans cette fixture ; elle ne prouve pas l'alignement du schéma Supabase déployé, des grants hérités, de PostgREST ou la contention de deux connexions simultanées. Les données de test sont fictives et aucune clé de production n'est nécessaire.

Avant activation, exécuter séquentiellement la migration et ces assertions sur une copie réconciliée du schéma ; tester aussi deux connexions concurrentes, l'erreur après insertion du journal, une réponse perdue puis rejeu, la révocation D1, la route déployée et l'absence de droits anon/authenticated. Inspecter les paramètres authentiques du client serveur et les noms de bindings sans imprimer leurs valeurs. Garder le flag désactivé tant que cette intégration n'est pas validée.

## Arrêt et retour arrière

Le retour opérationnel consiste à désactiver `INTERNATIONAL_CORE_ENABLED`. Le schéma et son journal restent présents sans modifier le comportement historique. Ne pas supprimer les tables pour masquer des confirmations existantes. Une correction de données ou un changement de pays/devise/base devra avoir sa propre procédure administrative, une migration distincte et une stratégie explicite pour les documents déjà émis. Aucun rollback destructif automatique n'est proposé.

Références : [audit initial](AUDIT.md), [preuves backend](audit-notes/backend.md), [fonctions PostgreSQL Supabase](https://supabase.com/docs/guides/database/functions), [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security). Changelog Supabase consulté le 7 octobre 2026 ; le client utilisé ici demeure le client REST interne, sans dépendance aux adapters `@supabase/server` dépréciés.
