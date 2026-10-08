# US workspace subscription admission — plan and boundaries

## Problem verified before development

`runtime-bindings.ts` and the national configuration binding currently use
`teamSeats`, whose plans and prepaid amounts are Swiss/CHF. An admission receipt
in PostgreSQL establishes the company identity; it does not establish payment.
The legacy account purchaser also converts account trials and moves licence
activations. It must not finalize a new US intention.

## Incremental scope

1. Add a US authority and membership registry, using the existing authenticated
   user identity and the server-allocated organization from the creation intent.
   Do not manufacture a Swiss subscription or copy a licence.
2. Validate a server-approved USD offer, its Stripe price and its evidence before
   admission. There is no default US offer or production price. Public request
   bodies must never provide a trusted authority, price or payment proof.
3. Commit authority, owner membership and intent finalization in one D1 batch.
   The admission requires the exact PostgreSQL receipt. Readiness is durable
   setup state, not permanent permission to use the ERP.
4. Read scoped membership and current US rights on every ERP authorization.
   Expiry, revocation, wrong country/currency/environment/catalogue and missing
   schema deny access. Keep CH membership, prices and subscriptions untouched.
5. Verify SQL constraints, atomic rollback and replay using a local database,
   and run the actual HTTP bindings with denied and allowed US authorities.

## Explicit limits

This phase is an internal admission boundary, not a live US purchase flow.
The existing production webhook and checkout remain unchanged. A future US
checkout/webhook must obtain Stripe objects on the server, verify the event and
invoice, then call this admission boundary. Merely deserializing an evidence
object is not Stripe signature or payment verification.

Initial authorities and their evidence are immutable; revocation is irreversible.
Renewals, plan changes, refund reconciliation, trials and additional independent
module subscriptions need their own versioned lifecycle before commercial launch.
The existing native device licence issuer cannot issue a US session through its
CHF tables; native US enrollment and account discovery remain future work.
No production migration, USD price, real payment or installation is authorized
by this local implementation. The US feature flags remain disabled by default.

## Planned files

- `lib/international/saas-authority.ts`, `saas-authority-d1.ts`, and tests
- `lib/international/subscriptions.ts` (shared validation export)
- `lib/international/runtime-bindings.ts` and its authority tests
- `lib/international/workspace-creation.ts` and D1 reader (ready receipt support)
- `drizzle/0087_international_saas_authorities.sql` and migration tests
- migration journal entry and this phase's evidence documentation

## Migration and rollback

Apply only to a disposable local/staging database first. Keep all historical SQL
unchanged. The new tables do not reference legacy subscriptions or move business
data. A rollback disables US flags/admission and retains authorities, memberships
and receipts for audit; it must not delete companies or reinterpret them as CH.
Production needs explicit approval and previous country/admission migrations.

## References checked

- D1 batch transactions: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 foreign key enforcement: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- Stripe subscription objects and entitlements: https://docs.stripe.com/billing/billing-apis
- Stripe subscription webhooks: https://docs.stripe.com/billing/subscriptions/webhooks

Results, exact changed files and remaining risks are appended after execution.

## Livraison locale du 8 octobre 2026

### Résultat et périmètre

L'admission US dispose maintenant de sa propre autorité SaaS et de ses membres. L'accès ERP et la configuration nationale ne dépendent plus d'un droit CHF. La création devient `ready` seulement avec l'autorité, le membre propriétaire et le reçu PostgreSQL exact, dans une même transaction D1. Rejeu identique, collisions, interruption de réponse et révocation sont traités sans fabriquer d'abonnement suisse ni déplacer une licence.

Les contrôles relisent les droits et les membres ; une dernière lecture SQL vérifie aussi la durée et les révocations intervenues entre les lectures. Le propriétaire est compris dans les sièges. Le catalogue US reste vide et tous les flags restent désactivés par défaut.

### Fichiers créés

- `.env.international.example`
- `drizzle/0087_international_saas_authorities.sql`
- `lib/international/saas-authorities.migrations.test.ts`
- `lib/international/saas-authority.ts`
- `lib/international/saas-authority-d1.ts`
- `lib/international/saas-authority.test.ts`
- `lib/international/saas-authority.workerd.test.ts`
- `scripts/qa-us-subscription-admission.mjs`
- `docs/internationalization/US-SUBSCRIPTION-ADMISSION-20261008.md`
- `docs/evidence/us-subscription-admission-20261008.json`

### Fichiers modifiés

- `drizzle/meta/_journal.json`
- `lib/international/runtime-bindings.test.ts`
- `lib/international/runtime-bindings.ts`
- `lib/international/subscriptions.ts`
- `lib/international/workspace-creation-d1.ts`
- `lib/international/workspace-creation.ts`
- `lib/international/workspace-server.bindings.test.ts`
- `lib/international/workspace-server.native.test.ts`
- `lib/international/workspace-server.ts`

### Migration proposée

`0087_international_saas_authorities.sql` est additive et journalisée après 0086. Les autorités et membres sont séparés du modèle CHF. Des clés étrangères différées rendent le grant, son propriétaire et l'intention finalisée indivisibles à la validation de la transaction. Les identités et preuves sont immuables ; les révocations sont irréversibles et l'historique n'est pas effacé. Aucun abonnement legacy ne peut reprendre cet identifiant d'entreprise.

La chaîne complète de 88 migrations D1 a été exercée localement. Les 106 SQL historiques D1/Supabase ont les mêmes blobs Git que le commit de base `c14aacc74ffd4d752cdbf22597a0e5f20f0f6df5` (les fins de ligne Windows expliquent certaines différences de hash brut). Aucun SQL historique n'a été réécrit. Aucune migration de production n'a été exécutée.

Les tables internationales brutes de 0085–0087 suivent le mécanisme existant de migrations SQL ; elles ne sont pas encore décrites dans `db/schema.ts`. Avant tout nouveau `db:generate`, réconcilier le schéma générateur et ces tables : ne jamais accepter aveuglément des DROP proposés. Le retour arrière fonctionnel désactive les consommateurs/flags en conservant preuves et audit. Le déploiement nécessite le rapprochement staging de D1 et PostgreSQL puis l'approbation explicite prévue par la mission.

### Vérifications exécutées

| Vérification | Résultat | Limite |
| --- | --- | --- |
| Régression sélectionnée, 74 fichiers | **2 025 passés, 0 échec, 63 ignorés** | Pas la totalité du dépôt ; les cas ignorés ne sont pas validés |
| Contraintes SQL, incluses dans le résultat ci-dessus | 101 assertions passées | SQLite local, toutes les migrations, FK actives |
| Service et autorisation, inclus dans le résultat ci-dessus | 37 tests passés | Preuves et prix fictifs |
| D1 réel local Miniflare/workerd, inclus dans le résultat ci-dessus | 4 tests passés | Batch, rollback, concurrence de rejeu et révocation ; pas le serveur hébergé |
| Typecheck du projet | Passé | Types TypeScript |
| Lint des fichiers changés | Passé | Le lint global n'a pas été réexécuté ; erreurs préexistantes hors tranche |
| Build production marque + Vinext | Passé | Bundle local, pas publication |
| Préservation des migrations historiques | 106 / 106 | Comparaison canonique Git, pas hash des fins de ligne CRLF |

Ces sélections se chevauchent : ne pas les additionner. Les tests PGlite et le contrôle du runtime V4 étaient activés ; les preuves native de ce checkout reposent sur le prototype 1.46.1 et ne valident pas l'application installée 1.90.15. Un ancien test d'appel non contextualisé a échoué au premier run ; son assertion a été adaptée au nouveau contrat scindé par acteur, puis la sélection entière a été réexécutée avec le résultat ci-dessus. Aucun test n'a été retiré pour produire ce résultat.

### Terminé dans cette tranche

- Admission interne atomique/idempotente, sans fallback CHF.
- Catalogue explicite USD/test ou production, scope entreprise/membre/module et refus des prix ou durées incohérents.
- Droits frais, échéance exclusive, révocation pendant les lectures et préservation des preuves.
- Lecture de l'état `ready` dans le contrat de création, sans grant automatiquement créé par l'onboarding.
- Exemple d'environnement sans secrets et preuve reproductible dans `docs/evidence/us-subscription-admission-20261008.json`.

### Expérimental et restant avant un produit US utilisable

- L'objet `verified_payment` typé et la vérification d'un Price ne vérifient **pas** un paiement Stripe. Aucun nouveau checkout/webhook public n'appelle cette admission. Il faut encore le branchement Stripe serveur signé, la vérification de la facture/période/identité et les tests sandbox.
- Renouvellements, remboursements, changements de formule, essais et abonnements de modules indépendants nécessitent un cycle d'autorité versionné. La preuve initiale reste immuable ; cette phase ne promet pas leur fonctionnement.
- Découverte/choix d'espaces dans le compte, onboarding Auth US, sessions et installations natives US restent à brancher. Le pilote commercial `/us` n'est pas cet onboarding.
- Catalogue USD de production, validation fiscale/prestataire, sécurité staging complète, charge, reconnexion/hors ligne et multi-appareils physiques restent nécessaires. Aucun lancement US, certification GAAP/SOC 2 ou conformité automatique n'est annoncé.
- Les protections de transport legacy restent actives pour toute entreprise US, même après admission/révocation. Ne pas réutiliser les écrans, licences ou outils CH pour un espace US.

### Prochaine tranche revue

Ajouter une découverte **metadata-only** `Mes espaces`, avec une destination US distincte. Ne pas unir les espaces US dans `membershipsForUser`, utilisé par les licences et dispositifs CH. Le DTO public sera limité à l'identifiant, nom, édition et rôle ; il ne transportera ni preuve, abonnement, configuration ni identifiant fiscal. Une entreprise expirée pourra rester dans le choix, mais l'ouverture vérifiera de nouveau les droits frais. Aucun ID choisi ne fait office d'autorisation.

### Publication du site, indépendante de cette tranche US

Le site orienté résultats est déjà publié séparément : version Sites **354**, commit `5c165545fe6588bc118166dc023efd0dae39d0ee`, déploiement confirmé `succeeded`, https://www.zentraapp.ch. Les quatre langues, tarifs et fonctions sont conservés ; la démo est plus accessible. Rapport : `D:/Codex-Zentra-Temporary/2026-10-08/site-business-results/docs/SITE-BUSINESS-RESULTS-20261008.md`.

Ce checkout US n'est pas cette source publique à jour. Avant une publication ultérieure, rapprocher les branches en conservant la version 354 ; ne jamais écraser le site ou publier l'ancien prototype natif contenu dans cette branche.
