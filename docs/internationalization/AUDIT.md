# Zentra International — audit initial CH / US

Date : 7 octobre 2026. Périmètre : dépôt `C:/Users/alb/Documents/ChatGPT/chantier`, HEAD `dd64a18c`, avec les modifications locales préexistantes. Cet audit est écrit avant toute modification majeure du produit. Aucun déploiement, changement Stripe, déplacement de région, suppression ni migration de production n'a été réalisé.

## 1. Périmètre et niveau de preuve

L'inventaire couvre les arborescences application, API, bibliothèque, base, application native, migrations et CI : 87 fichiers dans `app`, 93 dans `components`, 188 dans `lib`, 844 dans `desktop`, 79 dans `drizzle`, 8 dans `supabase`, 10 dans `.github` au début de l'audit. Les points d'entrée, contrats, contrôles d'autorisation, schémas et chemins financiers critiques ont été lus. Il ne s'agit pas d'une affirmation selon laquelle chaque ligne du dépôt a été exécutée ou toutes les fonctions publiées ont été certifiées.

Le dépôt contient de très nombreux changements non commités, dont un pilote commercial US récemment ajouté. Aucun de ces changements ne doit être effacé, réinitialisé ou intégré automatiquement à une autre copie. Les secrets, données clients, pièces financières et sessions privées n'ont pas été utilisés comme données de test.

Les notes détaillées et preuves complémentaires sont conservées dans `audit-notes/desktop.md`, `audit-notes/backend.md`, `audit-notes/billing-support.md` et `audit-notes/live-supabase.json`. Leur provenance doit rester distincte de la version publiée.

### Divergence de sources à résoudre avant livraison commerciale

- Ce checkout déclare l'application native **1.46.1** dans `desktop/package.json` et `desktop/src-tauri/Cargo.toml`. Des copies isolées plus récentes existent ; leur existence ne prouve pas leur intégration ici.
- `D:/Codex-Zentra-Temporary/2026-10-06/site-postfinance-durable`, HEAD `82871714b1b56eb17eb43b4f1351959d8be880ff`, contient Support, Automation et les offres groupées absents de l'arbre courant. Cette copie a été inspectée en lecture seule, sans mélange de sources.
- Supabase live contient les relations `zentra_workspaces`, snapshots, chunks, contenus et profils d'entreprise que ce checkout ne référence pas. La région et les métadonnées sont vérifiées ; les règles de publication/rejeu du runtime publié ne sont pas validées à partir de ce checkout.
- La commercialisation US exige un alignement explicite du commit source de l'application, du site, des contrats de synchronisation et du schéma déployé. Le socle international peut être construit ici de façon additive ; il ne doit pas servir à publier le checkout ancien par-dessus une version plus récente.

## 2. Architecture actuelle

| Couche | Vérifié dans le dépôt | Conséquence |
| --- | --- | --- |
| Site / API | React 19.2.8, TypeScript 5.9.3, Vinext 1.0.0-beta.5, Vite 8 ; structure App Router | Réutiliser les composants et les routes, éviter un second site/app autonome |
| Runtime serveur | Cloudflare Workers, binding D1 `DB`, R2 `FILES`, Sites `.openai/hosting.json` | D1 et Supabase sont deux autorités différentes ; pas de FK possible entre ces bases |
| Auth | Client REST Supabase interne, cookies d'accès/refresh, `getZentraUser`; repli Sites dans ce checkout | Aucune décision d'accès ne doit provenir de `user_metadata` ou du pays transmis par le navigateur |
| Entreprises | D1 `organizations`, `organization_members`, invitations, appareils ; `requireBrowserMembership`/`requireDeviceSession` | Le pays doit être porté par l'espace, jamais par l'identité utilisateur |
| Application | Tauri 2, React/Vite, Rust, SQLite locale, commandes IPC via bridge | Les règles financières natives et le schéma de synchronisation doivent évoluer ensemble |
| Métier synchronisé | Contrats, snapshots/rejeu et validations D1/R2 présents ; versions historiques protégées | Ne pas ajouter une colonne métier sans adapter/versionner le contrat native/serveur |
| Documents | PDF natifs, modèles, personnalisation, QR suisse et archivage de versions | Conserver le renderer ; sélectionner les blocs de paiement par adaptateur national |
| Tests | Vitest root, Vitest desktop, parcours navigateur, Rust, tests SQL Supabase | Les mocks/UI ne prouvent pas le fonctionnement multi-appareils ou réglementaire |

Il n'y a pas de middleware global donnant un droit implicite à une entreprise. Les contrôles sensibles sont dans les routes/services. Les nouvelles routes doivent réutiliser ces contrôles, vérifier les rôles côté serveur et refuser les identifiants d'entreprise non autorisés avant toute requête avec un secret serveur.

## 3. Supabase : schéma et état observé

Lecture seule MCP le 7 octobre : projet **Zentra Zurich** `xvfohjdlhlirksrvkiqu`, région **eu-central-2**, PostgreSQL **17.6.1.166**, état `ACTIVE_HEALTHY`. Aucune Edge Function listée. `supabase/config.toml` local prévoit PostgreSQL 15 : cette différence doit être couverte par la recette de migrations.

Le schéma plateforme versionné contient profils, abonnements, organisations, membres, invitations, licences, appareils, archives, domaines, tentatives Checkout, événements/proofs Stripe, rate limits et audit. Toutes les tables publiques observées ont la RLS activée. Les droits, policies, fonctions, triggers, publications et paramètres publics des buckets sont conservés dans la preuve metadata ; une RLS activée seule ne prouve pas l'isolation de toutes les routes utilisant `service_role`.

Les tables `organizations` et `subscriptions` Supabase sont vides dans l'observation, tandis que les tables workspace sont utilisées. L'autorité des membres et abonnements de la version inspectée est D1. Il serait incorrect d'ajouter un FK sur les organisations Supabase puis de supposer qu'il couvre les entreprises D1 existantes.

Les migrations live récentes (scheduler privé, PostFinance, pilote US) ne correspondent pas intégralement aux migrations présentes dans ce checkout. **Aucun `db push`, reset ou rejeu du dossier entier n'est autorisé.** Une nouvelle migration doit être additive, isolée, testée, puis revue avec la liste réellement appliquée.

### Plan de configuration nationale

Préparer une relation additive liée à `zentra_workspaces.organization_id`, sans backfill. La persistance est réservée au serveur ; la RLS refuse les accès directs anonymes et utilisateurs. Avant activation, le serveur vérifie l'appartenance D1, son rôle et l'espace Supabase correspondant. Les membres d'une autre entreprise ne peuvent pas choisir un autre `organization_id`. Les changements de pays/devise après premières opérations nécessitent une procédure explicite ; aucun changement automatique n'est admis.

Ce lien doit être testé sur une base de recette représentative du schéma workspace live. Le nouveau socle ne modifie ni les snapshots historiques, ni les organisations, ni la région, ni les documents existants.

## 4. Stripe

La bibliothèque existante est `stripe@22.6.0`, avec contrats/version Dahlia, webhook signé sur corps brut, preuve du secret courant, traitement idempotent et droits issus des périodes effectivement payées. Les licences et abonnements sont distincts des encaissements comptables des factures clientes.

Lecture seule du compte **Zentra** `acct_1UAaBrRTk1mJWGz3`, mode live, liste complète des prix actifs (`has_more=false`) : **11 prix, tous CHF ; aucun prix USD**. Les offres comprennent les anciens prix Gestion et les prix Support, Automation et Complet. Les prix et abonnements n'ont pas été modifiés. Le checkout courant n'implémente pas toutes les offres observées ; les modules correspondants existent dans la copie Site348 précitée.

Le futur catalogue national doit associer explicitement pays, devise, module, formule, mode Stripe et Price ID. Un Price CHF ne peut jamais servir de repli à une offre US. En l'absence de prix US approuvé et vérifié, le Checkout US est indisponible. Aucun tarif arbitraire ni achat live de recette ne sera créé.

Les paiements des factures des entreprises clientes nécessitent une autorité marchande et des modèles séparés ; on ne peut pas réutiliser la clé du vendeur SaaS comme si chaque entreprise était Zentra. Les adaptateurs cartes/ACH/virement peuvent être préparés ; leur activation, mandats et éventuelle architecture Connect restent à valider.

## 5. Modules : réutilisable, couplé ou absent

| Domaine | Réutilisable et présent | Couplage / limite vérifié |
| --- | --- | --- |
| Clients / fournisseurs | Fiches, contacts, projets, documents, soldes et flux locaux | Fournisseurs/factures fournisseurs ont des CHECK CHF ; format d'adresse et fiscalité à adapter |
| Ventes | Devis, acomptes, conversion, commandes, factures, avoirs, paiements, relances, récurrence | `issue_invoice` exige CH/LI ; commandes, temps facturé et récurrence imposent CHF |
| Comptabilité | Partie double native, journal, clôtures, pistes de correction et rapports | Devises CHF/EUR seulement dans un chemin natif ; rapports base CHF ; aucune certification US GAAP |
| Fiscalité | TVA suisse et contrôles natifs | Aucun moteur de sales tax US, aucun taux national US acceptable |
| Banque | CAMT et rapprochements suisses, QR-factures | ACH / banques US / références documentaires US non intégrés ici |
| Langues | Desktop fr/de/it/en | Locales fr-CH/de-CH/it-CH/en-CH ; pas de contexte pays d'entreprise |
| Support / Automation | Modules et abonnements inspectables dans Site348 | Absents de l'arbre courant ; leurs traitements live ne sont pas certifiés par les tests de ce checkout |
| Pilote US actuel | `/us`, candidatures, analytics, protection anti-abus Supabase | Aperçus marketing simulés ; ne crée ni entreprise ni licence ni opération ERP |

Le nouveau développement doit conserver les langues existantes. Les données des clients (noms, textes, références, notes) ne doivent jamais être traduites automatiquement. Le choix d'une langue ne change pas la juridiction d'une entreprise.

## 6. Couplages et fichiers concernés

Points d'entrée critiques vérifiés :

- `desktop/src/types.ts`, `desktop/src/bridge.ts`, `desktop/src/language.ts`, `desktop/src/WorkspaceApp.tsx` : contrats et orchestration d'interface.
- `desktop/src-tauri/src/schema.rs`, `database.rs`, `accounting.rs`, `accounting_closure.rs`, `recurrence.rs`, `sales_fulfillment.rs`, `time_billing.rs` : contraintes et calculs CH.
- `lib/account.ts`, `app/zentra-auth.ts`, `lib/team-seats.ts`, `lib/supabase-server.ts`, `lib/supabase-server-runtime.ts` : autorité serveur et persistance.
- `lib/business-sync-*`, `desktop/src-tauri/src/business_sync/**` : contrats de synchronisation versionnés.
- `lib/stripe-*`, `lib/license-*`, `app/api/stripe/**` : abonnement CHF et licences existants, à préserver.
- `supabase/migrations/**`, `supabase/tests/database/**`, `drizzle/**`, `db/schema.ts` : schémas distincts et migrations.
- `lib/markets/us.ts`, `lib/us-pilot/**`, `components/us/**`, `app/us/**` : pilote commercial existant, indépendant du futur contexte ERP.

Ajouts prévus sans déplacement massif : `lib/international/**` pour les contrats partagés, localisation/devise/pays et autorisations, `lib/international/countries/{ch,us}/**` pour les adaptateurs, nouvelles migrations/tests et `docs/internationalization/**`. Les branchements natifs/Support sont séparés en phases et ne déverrouillent pas un module réglementaire prématurément.

## 7. Risques et décisions

1. **Provenance / schémas divergents** : aligner la version de livraison avant de brancher les nouvelles migrations en production.
2. **Mauvais pays implicite** : configuration absente = juridiction non confirmée. Conserver le comportement historique sans écrire CH automatiquement ; prévoir revue administrative.
3. **Devise et historique** : ne pas convertir/réétiqueter les montants existants. Montants du nouveau socle en unités mineures exactes, sérialisés en chaînes ; types SQL décimaux/entiers adaptés.
4. **Sales tax manquante** : devis brouillons possibles, émission nécessitant une détermination fiscale fiable ; pas de taux inventé. Exemptions documentées et statut de validation explicite.
5. **Partie double** : journal validé immuable, contrepassation liée, clôture, autorisation et idempotence ; dates métier et comptables séparées.
6. **Cash/accrual** : méthodes distinctes, pas un simple filtre sur le même rapport ; les cas fiscaux complexes restent à revoir professionnellement.
7. **Automatismes financiers** : résultat d'analyse non fiable par défaut ; permissions, abonnement, preuves, approbation et clé d'idempotence obligatoires au moment d'exécuter.
8. **Souscriptions US** : rien n'est activé tant que catalogue USD approuvé et cohérence Stripe/droits/espace ne sont pas établis.
9. **Résidence / droit** : pas de déplacement Supabase ; examiner contrats, traitements transfrontaliers, sous-traitants, conservation et notices avec un juriste. Aucune revendication SOC2 ou conformité US automatique.

## 8. Plan incrémental et critères de livraison

| Phase | Travail | Condition de sortie |
| --- | --- | --- |
| A — Audit | Inventaire, architecture, preuves, matrice de fonctions et risques | Ce document + notes, baseline testée, provenance des versions explicite |
| B — International Core | Pays CH/US, paramètres d'espace, exact money, formats/i18n, adaptateurs, permissions et compatibilité | Tests pays/langues/devises/arrondis/unknown legacy ; migration locale additive et retour arrière ; aucune modification de CH live |
| C — Gestion US | Brancher clients/fournisseurs/projets, documents et cycle estimate → invoice | Parcours US réellement persisté, aucune TVA/QR suisse, tests de conversion et accès d'entreprise |
| D — Comptabilité US | Journal partie double, périodes, contrepassations, AR/AP et rapports | Calculs déterministes et équilibrés ; méthodes explicites ; limites de conformité visibles |
| E — Taxes / paiements | Adaptateurs, preuve de détermination, séparation SaaS/factures client | Prestataires et règles validés, tests sandbox, blocage en l'absence de configuration |
| F — Support / Automation | Contexte pays, anglais/français, workflows et permissions | Branchements depuis la source réellement publiée, test de non-régression et approbations/idempotence |
| G — Pilote | Données fictives, onboarding, traces et retour utilisateur | Recette complète sur staging ; activation limitée ; aucun vrai document client dans la démo |

Chaque phase doit avoir un compte rendu de fichiers, migrations proposées/non appliquées, commandes de test réellement exécutées, limites, fonctions terminées et expérimentales. Une bibliothèque ou un test avec provider simulé n'est pas une preuve de fonction commerciale déployée.

## 9. Baseline exécutée avant implémentation

- `pnpm exec tsc --noEmit --incremental false` : **réussi**.
- Lint root (commande du package) : **réussi**.
- Vitest root complet, deux workers : **993 réussis, 6 échecs, 102 ignorés**, 70 suites réussies / 4 suites en échec. Les échecs observés sont des transports Miniflare `EADDRINUSE` ; un second run d'audit a été concurrent. Ne pas présenter la suite complète comme réussie. Relance séquentielle ciblée prévue.
- Un run d'audit backend distinct : 205 réussis, 1 échec Miniflare, 2 ignorés ; contrat statique Supabase réussi. Limite de concurrence consignée dans la note backend.
- Métadonnées Supabase et inventaire des prix Stripe : lectures seules réussies, aucun test de paiement réel, de connexion d'un client réel ou de publication multidevice.
- Pas de Docker/PostgreSQL natif détecté à cette étape ; une base PostgreSQL de test locale doit être fournie avant de qualifier la migration SQL.

Logs de baseline : `D:/Codex-Zentra-Temporary/2026-10-07/international/`. Les erreurs préexistantes et tests ignorés restent visibles ; leur existence ne sera pas masquée par la réussite des seuls nouveaux tests.

## 10. Références primaires et hypothèses

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) et [sécurisation des API](https://supabase.com/docs/guides/api/securing-your-api) : autorisations serveur et RLS sont complémentaires.
- [Supabase changelog](https://supabase.com/changelog) : version/checklist relue ; l'adaptateur REST existant n'emploie pas les framework adapters dépréciés. Les mises à niveau PG/extensions sont une opération séparée, pas un effet secondaire de cette mission.
- [Stripe Tax pour plateformes](https://docs.stripe.com/tax/tax-for-platforms) : déterminer l'entité responsable et ses registrations ; ne pas substituer le compte SaaS au vendeur de la facture.
- [Stripe Tax, intégration](https://docs.stripe.com/tax/custom) : calculs par localisation/produit/registration, pas de taux américain unique.
- [IRS Publication 538](https://www.irs.gov/publications/p538) : cash et accrual sont des méthodes distinctes ; le socle ne choisit pas la méthode fiscale adéquate à la place du comptable.
- [AFC, taux suisses](https://www.estv.admin.ch/en/development-swiss-vat-rates) : les règles CH existantes restent séparées ; aucune règle suisse n'est héritée par US.

Ces références guident les interfaces et les blocages, pas une certification ni une détermination fiscale automatisée sans prestataire et revue professionnelle.

## 11. Suite de l'audit

Le compte rendu de l'implémentation additive, des fichiers, tests exécutés, migration proposée et limites est dans [DELIVERY.md](DELIVERY.md). Ce complément ne réécrit pas la baseline : les collisions Miniflare initiales et la divergence des sources restent documentées. Le socle et le pilote expérimental sont séparés de l'édition native suisse publiée ; aucune activation ou migration de production n'a été effectuée.
