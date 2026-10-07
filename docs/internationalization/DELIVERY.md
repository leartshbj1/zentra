# Zentra International — livraison incrémentale du 7 octobre 2026

État daté du socle initial. Le raccord transactionnel du8octobre est décrit séparément dans [DELIVERY-20261008.md](DELIVERY-20261008.md) ; les fonctions absentes et résultats historiques ci-dessous ne doivent pas être confondus avec cette étape suivante.

## État de cette livraison

L'audit et un socle international partagé sont livrés dans le dépôt. Des contrats de ventes, comptabilité, documents, abonnements et Automation sont testés, avec un parcours navigateur US fictif. **Ce n'est pas encore une édition américaine commerciale ou une mise à jour native.** Aucun changement de production, Stripe, région, compte client ou donnée métier n'a été effectué. Les fichiers préexistants, y compris les changements locaux non commités, sont conservés.

L'application de ce checkout est déclarée 1.46.1 ; les sources Site348 et les worktrees natifs plus récents ne lui correspondent pas. Publier cet arbre par-dessus l'application actuelle risquerait une régression. Le branchement doit être réalisé depuis un commit de livraison réconcilié et testé avec les contrats réellement déployés. Voir [AUDIT.md](AUDIT.md).

## Compte rendu par phase

| Phase | Résumé et fonctions terminées à leur portée | État, risque et suite |
| --- | --- | --- |
| A — Audit | Architecture site/Tauri/D1/R2/Supabase, autorisations, langues, schémas, abonnements et modules inspectés ; métadonnées live et prix Stripe lus sans écriture ; couplages CH et divergences documentés | Audit effectué. Aucun parcours de production, certification ou test de charge multi-appareils déduit de l'inventaire |
| B — International Core | CH/US typés, adresses, régions, langues fr/en/de/it conservées, devise exacte, dates/fuseaux, téléphone syntaxique, adaptateurs ; configuration d'entreprise et API autorisée avec feature flag désactivée | Bibliothèque et composant testés. Migration proposée et exécutée uniquement sur fixture locale. API non activée ; identification des workspaces historiques à confirmer administrativement |
| C — Gestion US | Contrats client, devis accepté → facture, échéance, remises, taxes validées, paiements partiels, numérotation via port atomique ; rendu US Letter/USD sans QR CH et historique d'émission | Prototype testé, pas CRUD natif/persistant. Fournisseurs/projets/documents existants ne sont pas entièrement branchés US ; commandes, livraisons, récurrence, dépôts, avoirs et envoi réel restent à intégrer |
| D — Comptabilité US | Journal équilibré, périodes, contrepassations, rôles, CAS/idempotence ; AR/AP, cash/accrual, grand livre, balance, résultat, bilan, flux directs et rapprochement exact | Transitions pures testées, sans transaction de stockage financière réelle. Hypothèses documentées ; aucune certification US GAAP, automatisation fiscale ou clôture réglementaire annoncée |
| E — Taxes et paiements | Détermination fiscale liée aux données/revision/localisation, refus sans configuration, sources CH/US séparées ; catalogue national strict et distinction abonnement SaaS/paiement de facture | Ports et blocages prêts. Aucun moteur Stripe Tax, marchand Connect, ACH, lien ou remboursement client activé ; aucun tarif USD inventé. Sandbox et validation professionnelle nécessaires |
| F — Support / Automation | Contrats indépendants du pays pour facture fournisseur, demande client et rendez-vous ; fixtures FR/EN, DST, scope, abonnement, approbation, logs, idempotence, effets incertains et droits recontrôlés | Mocks testés, pas nouvelle mesure de précision JEV ni connexion live US. À brancher depuis la source publiée alignée, avec stockage atomique, scheduler et sinks vérifiant les droits |
| G — Pilote américain | Onboarding partagé, client fictif, devis, blocage fiscal, exemption explicitement fictive, facture USD, aperçu/impression PDF, encaissement et rapports cash/accrual | Fixture de développement en mémoire. Aucun compte cloud, licence, SMTP, banque ou donnée réelle ; staging multi-utilisateur, monitoring et feedback restent à préparer |

### Migrations et résultats par phase

| Phase | Migration | Tests exécutés liés à la phase |
| --- | --- | --- |
| A | Aucune | Baseline root : 993 passés, 6 échecs de transport Miniflare, 102 ignorés. Réexécution complète séquentielle ensuite : 1 315 passés, 71 ignorés |
| B | Configuration nationale additive proposée, locale uniquement | Core 82, téléphone 14, service/API 43, onboarding 15 passés ; 17 assertions SQL et parcours localisés passés |
| C | Aucune migration métier ; modèles en mémoire | Documents 33 passés ; cycle de facturation dans les 56 tests finance et les quatre parcours US passés |
| D | Aucune migration de journal métier ; adaptateur persistant absent | Finance 56, rapprochement 11 passés ; sélection native CH : QR 5 et `vat` 108 passés |
| E | Aucune ; aucun Price USD ni ressource marchande créé | Contrats fiscaux dans finance 56 ; abonnement national dans intégration 68 ; régression Stripe 110 passés |
| F | Aucune ; store et sink réels non livrés | Workflow FR/EN, autorisations, approbations, idempotence et DST dans intégration 68 passés, avec providers fictifs |
| G | Aucune ; pilote éphémère sans compte cloud | Quatre cycles cash/accrual PC/mobile passés, focus modal et PDF ; huit inspections et dix parcours d'onboarding passés |

Ces ensembles se recouvrent. Les mêmes 56 tests finance et 68 tests d'intégration servent plusieurs phases ; ce tableau n'ajoute aucun test au total du dossier international.

### Fichiers créés par phase

Tous les fichiers listés ci-dessous sont additifs. Aucun fichier métier historique suivi par Git n'a été modifié par cette mission. Les ajustements pendant les revues concernent uniquement ces nouveaux fichiers : validation SQL, snapshot historique, dates, gardes de révision, contrôle de focus, sémantique des statuts et documentation.

**A — Audit**

- `docs/internationalization/AUDIT.md`
- `docs/internationalization/audit-notes/desktop.md`
- `docs/internationalization/audit-notes/backend.md`
- `docs/internationalization/audit-notes/billing-support.md`
- `docs/internationalization/audit-notes/live-supabase.json`

**B — Socle et configuration**

- `lib/international/types.ts`, `country-config.ts`, `money.ts`, `localization.ts`, `addresses.ts`, `phone.ts`
- `lib/international/core.test.ts`, `phone.test.ts`
- `lib/international/workspace-service.ts`, `workspace-server.ts`, `workspace-service.test.ts`, `workspace-server.test.ts`
- `lib/international/countries/adapters.ts`
- `desktop/src/InternationalCompanySetup.tsx`, `international-company-setup.css`, `internationalCompanySetup.test.ts`
- `desktop/tests/international-company-harness.html`, `international-company-harness.tsx`
- `app/api/international/workspaces/[organizationId]/country/route.ts`
- `supabase/migrations/20261007194528_international_workspace_country_config.sql`
- `supabase/tests/database/international_country.test.sql`
- `scripts/international/test-country-migration.mjs`
- `docs/internationalization/CORE.md`, `MIGRATIONS.md`, `ONBOARDING.md`

**C — Ventes et documents**

- `lib/international/invoicing.ts`, `documents.ts`, `documents.test.ts`
- `docs/internationalization/DOCUMENTS.md`

**D — Comptabilité**

- `lib/international/accounting/ledger.ts`, `postings.ts`, `reports.ts`, `reconciliation.ts`, `reconciliation.test.ts`
- `lib/international/countries/ch/accounting.ts`, `countries/us/accounting.ts`
- `lib/international/finance.test.ts`
- `docs/internationalization/FINANCE.md`

**E / F — Abonnements et Automation**

- `lib/international/subscriptions.ts`, `automation.ts`, `integration.test.ts`
- `docs/internationalization/INTEGRATIONS.md`

**G — Parcours de développement et livraison**

- `desktop/tests/international-erp-pilot.html`, `international-erp-pilot.tsx`, `international-erp-pilot.css`
- `scripts/international/check-browser-pilot.mjs`
- `docs/internationalization/DELIVERY.md`, `evidence.json`

Les fichiers `lib/us-pilot/**`, `app/us/**` et `supabase/tests/database/us_pilot_rls.test.sql` préexistaient : ils ne sont pas une réalisation de l'ERP dans cette mission. Leur pilote commercial et ce parcours ERP fictif restent distincts.

## Migration proposée et retour arrière

Une seule nouvelle migration concerne la configuration nationale. Elle ajoute deux relations et une RPC auditée/CAS liées à `zentra_workspaces.organization_id`, sans backfill, conversion, suppression ou désactivation de RLS. Accès directs anon/authenticated refusés ; serveur vérifié et propriétaire seuls peuvent confirmer une juridiction. Pays/devise/base comptable sont ensuite verrouillés. Les inconnus historiques restent inconnus, avec revue administrative.

**Non appliquée en production.** Le test local utilise PGlite 0.5.8 / PostgreSQL 18.3 et un parent workspace synthétique ; le projet observé était PostgreSQL 17.6. La validation staging doit rapprocher les migrations et grants réellement présents et tester les connexions concurrentes. Retour arrière fonctionnel : laisser `INTERNATIONAL_CORE_ENABLED` désactivé, retirer les consommateurs, préserver les nouvelles configurations et leur journal. Aucun DROP automatique du journal n'est proposé. Procédure détaillée dans [MIGRATIONS.md](MIGRATIONS.md).

## Tests exécutés et résultats

Les résultats ci-dessous se chevauchent ; **ne pas les additionner** pour annoncer un total de tests uniques. Le JSON [evidence.json](evidence.json) conserve les fichiers et empreintes ; les logs complets restent dans le dossier de travail indiqué ci-dessous.

| Vérification | Résultat observé | Portée et limite |
| --- | --- | --- |
| Vitest root complet, séquentiel | 81 fichiers, **1 315 tests passés**, 71 ignorés | Dépôt courant avec les ajouts disponibles au départ du run ; nouveaux derniers tests rerun séparément ci-dessous. N'est pas un test live |
| Vitest desktop complet | 189 fichiers, **1 692 tests passés** | Interface et fonctions couvertes par les tests existants, pas exécution des commandes Rust |
| Dossier international final | 8 fichiers, **307 tests passés** | Monnaie, pays, dates, téléphone, ventes, finance, documents, API, abonnement et workflow ; services externes simulés |
| Onboarding ciblé | **15 tests passés** | Inclus dans le desktop complet, puis réexécutés après correction sémantique |
| SQL nouvelle migration | **17 assertions passées** | RLS/grants, scopes, CAS, rejeu, audit et immutabilité sur PostgreSQL WASM isolé ; pas le schéma live complet |
| QR-factures CH natifs Rust | **5 tests passés**, 1 096 filtrés | QRR officiel, SCOR, identité du snapshot, payload SIX et pays ISO ; compilation réelle locale, sans réseau |
| Régression native sélection `vat` | **108 tests passés**, 993 filtrés | TVA, avoirs, remboursements et certains chemins historiques/privés ; 242,51 s, bases fictives, pas suite Rust complète |
| Régression Stripe | 15 fichiers, **110 tests passés** | Contrats/webhooks/offres CHF simulés ; aucun paiement réel |
| Régression Auth | 2 fichiers, **22 tests passés** | Tests existants de sessions/HTTP, pas connexion de vrais utilisateurs |
| Régression D1/Miniflare séquentielle | 4 fichiers, **253 tests passés**, 63 ignorés | Les collisions EADDRINUSE de la baseline à deux workers ne se reproduisent pas avec exécution séquentielle |
| Onboarding navigateur | **8 inspections + 10 parcours passés**, 34 captures | FR/EN/DE/IT à 390/1280 px ; CH/US existants à 320 px, validation/retry/double submit, sans débordement observé |
| Pilote ERP navigateur | **4 parcours passés**, 8 captures | Cash/accrual à 390/1280 px, facturation USD, blocage fiscal, paiement et équilibre ; finalisé avec contrôle modal/focus |
| Documents / PDF navigateur | US Letter et CH A4 imprimés, une page chacun | Fixtures hors réseau ; aucun rendu QR CH natif remplacé. Historique réimprimé après modification de configuration |
| Typecheck root / desktop / fixture | **Passés** | TypeScript selon cibles existantes ; fixture testée séparément du bundle natif |
| Lint root + nouveaux fichiers | **Passés** | Aucun changement de règles ou dépendances root |
| Build production site + frontend desktop | **Passés** | Vinext et Vite ; avertissements de taille/classement conservés dans les logs. Aucun paquet natif signé généré |

Les logs sont dans `D:/Codex-Zentra-Temporary/2026-10-07/international/`. Les nouvelles assertions spécifiques ne prouvent pas les tests ignorés, la charge, la latence réelle, la fiscalité ou les permissions de production. Les sélections natives QR/TVA ont été exécutées avec `cargo test --lib ... --locked --offline` et un target isolé sur D:. Elles ne constituent pas une recette de l'application installée ni des appareils physiques ; aucune compilation/signature macOS/iOS/Android n'a été réalisée.

La revue indépendante du pilote a révélé deux défauts : fond accessible au clavier derrière le document et capture trop précoce de l'onglet PC. Le viewer utilise maintenant `showModal`, focus initial/restauré et Escape ; les captures attendent l'état actif et deux frames. Le runner final a confirmé ces comportements dans ses quatre parcours ; la revue des captures finales a validé les deux corrections, uniquement pour ce pilote en mémoire.

### Reproduire les parcours

Prévisualisation desktop : `pnpm --dir desktop exec vite --host 127.0.0.1 --port 5371 --strictPort`.

- `/tests/international-company-harness.html?language=fr` : configuration seule, enregistrement dans la fixture.
- `/tests/international-erp-pilot.html` : cycle ERP US fictif avec méthode explicite, aucun serveur.

Le runner navigateur ne requiert aucun secret : définir `PLAYWRIGHT_MODULE_DIR` vers un package Playwright installé, `QA_OUTPUT_DIR` vers un dossier absolu d'artefacts, éventuellement `BROWSER_EXECUTABLE` et `PREVIEW_ORIGIN`, puis `node scripts/international/check-browser-pilot.mjs`. Il est limité à une prévisualisation locale. Les autres commandes sont `pnpm exec vitest run lib/international --maxWorkers=1`, `pnpm exec tsc --noEmit --incremental false`, `pnpm lint` et le runner SQL documenté dans MIGRATIONS.

## Conditions avant branchement à de vrais espaces

1. Fixer le commit source commun de livraison app/site et rapprocher D1/Supabase/contrats natifs. Ne pas publier cette version ancienne par-dessus la nouvelle.
2. Recetter la migration sur le schéma staging réconcilié, avec contention, révocation, réponse perdue/rejeu, storage et isolation des entreprises. Toute opération de production nécessite l'approbation explicite du propriétaire.
3. Construire les adaptateurs de persistance et transactions métier/journal/numéro/reçu, le bridge Rust/SQLite et les migrations locales additives. Archiver le contexte vendeur complet et préserver la lecture de toutes les factures CH.
4. Brancher les CRUD US et compléter commandes, fournisseurs, avoirs, dépôts et récurrence ; traduire progressivement les anciens écrans/messages sans traduire les données saisies.
5. Faire valider fiscalité/méthode et sélectionner/configurer le prestataire, le catalogue USD et l'autorité marchande. Tester paiements et webhooks sandbox, sans toucher aux abonnements CHF.
6. Relier Support/JEV aux contrats de workflow et valider sur des cas anglais réels mais fictifs, puis recette multi-appareils/hors ligne/reconnexion et monitoring. Préparer comptes de démonstration séparés.
7. Revue juridique des traitements transfrontaliers et fournisseurs. Aucune migration régionale, revendication SOC 2, résidence US ou conformité automatique n'est faite.
