# Pilote US V5 — intégration de la présentation vendeur B1

11 octobre 2026. Livraison locale commencée le 10 octobre, sous gates privées TEST fermées par défaut. L'objectif ERP US complet reste actif.

Code : `863a43a174a5230ce66e786b3e6244914e4c69ea`. Plan préalable : [B1](US-FINANCIAL-PILOT-SELLER-INTEGRATION-PLAN-20261010.md), commit `cab04c30fdff72626cef1bfb07e43c478f724b8c`. [Preuve structurée](../evidence/us-financial-pilot-seller-integration-20261011.json), SHA256 `8a54843b7c520f2285ddc4769132ca3b64457693cca1114d1e8a09f61b4d720a`. Les 38 sources et les commandes finales correspondent au même arbre de 3672 fichiers, SHA256 `963f597475f16d028825cc8ee0e3894e9c0f1ccfb98ef47302ff68d417afeef3` ; la preuve garde les commandes, diagnostics et empreintes originaux.

## 1. Résumé des modifications

Le propriétaire du pilote peut corriger le **nom commercial imprimé** et ses contacts e-mail/téléphone, avec comparaison avant/après et approbation. La présentation est versionnée séparément des écritures financières, de la banque et de la configuration fiscale. Le changement n'autorise pas une modification de l'entité légale, de l'EIN, de l'adresse, du pays, du nexus ou des registrations.

Les devis utilisent la présentation courante. Les nouvelles factures préparent un contexte privé version2 : les faits fiscaux originaux restent intacts et la présentation commerciale possède sa propre preuve. La première réservation exige la présentation courante sous verrou ; une facture déjà réservée/calculée conserve son profil, ses hashes, sa clé fournisseur et sa fenêtre de reprise historiques. Les factures commises et leurs reçus restent inchangés. Aucun contexte fiscal absent ou expiré n'est renouvelé par cette maintenance.

La session financière commune gère le vendeur sans second timer ni verrou indépendant. Son observation composite F/B/S utilise le cycle existant de trois secondes. Un changement S seul invalide une revue ordinaire et les URL de devis, sans recharger inutilement le snapshot financier ; un changement bancaire seul ne les invalide pas. Un pending conserve son UUID/body exact et bloque les nouvelles intentions et les exports. Le F historique d'un reçu n'est jamais adopté comme head actuel.

L'interface conserve les styles du pilote, ses langues FR/DE/IT/EN et ses thèmes clair/sombre. La livraison ne publie aucune app et n'active aucune gate hébergée.

## 2. Fichiers créés

- `app/api/international/workspaces/[organizationId]/financial-pilot/seller/route.ts`
- `components/account/us-financial-pilot-seller.tsx`
- `lib/international/browser-us-financial-pilot-seller-copy.ts`
- `lib/international/browser-us-financial-pilot-seller-input.test.ts`
- `lib/international/browser-us-financial-pilot-seller-input.ts`
- `lib/international/browser-us-financial-pilot-seller.test.ts`
- `lib/international/us-financial-pilot-seller-bindings.test.ts`
- `lib/international/us-financial-pilot-seller-bindings.ts`
- `lib/international/us-financial-pilot-seller-server.test.ts`
- `lib/international/us-financial-pilot-seller-server.ts`
- `lib/international/us-financial-pilot-seller-store.test.ts`
- `lib/international/us-financial-pilot-seller-store.ts`
- `lib/international/us-financial-pilot-seller.postgres.test.ts`
- `supabase/migrations/20261010212730_international_us_financial_pilot_seller_test_v1.sql`

Documentation créée séparément : la présente livraison et `docs/evidence/us-financial-pilot-seller-integration-20261011.json`. Le plan B1 avait été créé et committé avant l'implémentation. Les scripts, captures, données fictives et sorties sous `.qa/us-pilot-seller-integration/` restent ignorés et ne sont pas des routes produit.

## 3. Fichiers modifiés

- `app/compte/espaces/us/[organizationId]/page.tsx`
- `components/account/us-financial-pilot-invoice.tsx`
- `components/account/us-financial-pilot.tsx`
- `lib/account-workspace-pages.test.ts`
- `lib/international/browser-us-financial-pilot-export-session.test.ts`
- `lib/international/browser-us-financial-pilot-export-session.ts`
- `lib/international/browser-us-financial-pilot-invoice-copy.ts`
- `lib/international/browser-us-financial-pilot-invoice.test.ts`
- `lib/international/browser-us-financial-pilot-session.test.ts`
- `lib/international/browser-us-financial-pilot-session.ts`
- `lib/international/us-financial-invoice-test.test.ts`
- `lib/international/us-financial-invoice-test.ts`
- `lib/international/us-financial-pilot-export-bindings.test.ts`
- `lib/international/us-financial-pilot-export-bindings.ts`
- `lib/international/us-financial-pilot-invoice-bindings.test.ts`
- `lib/international/us-financial-pilot-invoice-bindings.ts`
- `lib/international/us-financial-pilot-invoice-server.test.ts`
- `lib/international/us-financial-pilot-invoice-store.test.ts`
- `lib/international/us-financial-pilot-invoice-store.ts`
- `lib/international/us-financial-pilot-invoice.test.ts`
- `lib/international/us-financial-pilot-invoice.ts`
- `lib/international/us-financial-pilot-seller.test.ts`
- `lib/international/us-financial-pilot-seller.ts`
- `lib/international/us-team.migrations.test.ts`

Le plan B1 suivi est complété pour fixer les cinq aliases facture et la sélection explicite par installation. Son amendement préalable du11octobre remplace le fichier serveur optionnel non utilisé par le test de page nécessaire à la correction SSR. `STATUS-20261009.md` reçoit ce jalon en tête ; sa queue historique est préservée octet pour octet. Inventaire code/test/SQL : **14 créations et 24 modifications**, plafond amendé de38 ; `us-financial-pilot-invoice-server.ts` demeure inchangé. Aucun déplacement massif, dépendance ou nouvelle CSS.

## 4. Migration additive proposée

`20261010212730_international_us_financial_pilot_seller_test_v1.sql`, générée officiellement par Supabase CLI2.120.0, ajoute deux relations privées (changes/heads), quatre RPC vendeur et cinq aliases facture compatibles. La chaîne cumulative locale contient **35 migrations**. Les anciennes migrations restent inchangées. Aucun db push/reset, migration hébergée, backfill, effacement, déplacement de région ou abonnement modifié.

RLS activée sur les nouvelles tables ; rôles navigateur refusés ; fonctions privées SECURITY INVOKER avec search_path vide et droits service_role explicites. Admission réelle du pilote, grant/opt-in/version et propriétaire courant requis pour append, y compris en reprise. Reçu exact ensuite recherché avant CAS F/S et conditions de nouvelle écriture. Historique immuable, head référencé par FK différée, triggers de séquence/horloge/atomicité, plafond1000 changements par entreprise et lecture ponctuelle bornée64KiB ; corps HTTP4096octets.

La provenance S est reconstruite depuis les vrais préfixes financiers SQL. Le lecteur public vendeur conserve le contrôle strict du curseur F/hash stable. La corroboration interne d'une facture utilise la reconstruction pendant l'append, lorsque l'événement est présent avant l'avancement du curseur ; les guards et triggers différés contrôlent toujours la fin atomique. Aucun booléen de bypass ou livre fourni par le navigateur.

`ZENTRA_US_FINANCIAL_SELLER_TEST_INSTALLED` garde les lecteurs/reprises compatibles ; `ZENTRA_US_FINANCIAL_SELLER_TEST_ENABLED` ouvre les seuls nouveaux changements, avec toutes les gates privées TEST existantes. Aucun fallback S0 en cas de panne. Retour arrière : fermer les nouvelles écritures et conserver tables, audit, lecteurs2 et reprises ; ne pas rétrograder vers un binaire ignorant les corrections S.

## 5. Tests exécutés et résultats

Tous les contrôles suivants ont été sérialisés par root, avec vérification de l'arbre avant/après :

| Contrôle final | Résultat réellement exécuté |
| --- | --- |
| Ciblés | 858/858, 20 fichiers ; 71870 ms |
| Régression sélectionnée | 7151/7151, 211 fichiers ; 887262 ms |
| TypeScript global | exit 0 ; 29838 ms |
| Lint typé des37 fichiers TS/TSX, avertissements refusés | exit 0 ; 2760 ms |
| Marque | exit 0 ; 439 ms |
| Build production | exit 0 ; 21942 ms |

Zéro échec de suite ou d'assertion, pending ou todo sur les deux sélections finales. Les858 ciblés recoupent les7151 de régression et ne s'y ajoutent pas. La sélection211 fichiers comprend des canaris CH/TVA/country-guard, Auth, abonnements/Stripe, compte et Support ; ce n'est pas une couverture totale CH/US ni une recette QR/natif/hébergée.

Deux recettes cumulatives locales PGlite (ciblée et régression) passent les **9 cas B1**, enregistrent **13 invariants** et appliquent les mêmes35 migrations : S seul sans variation F/L/B/C/fiscal/anciens documents, reçu exact après S avancé, première réservation périmée refusée avant calculate, reprises reserved/calculated au S/hash/providerKey/TTL d'origine, nouvelle facture au nouveau S imprimé et ancien S fiscal, legacy1 durable conservé, owner/grant/opt-in, rollback entre audit/head, DML/truncate refusés, preuve cohérente fabriquée/horloge antérieure refusées, lecteur stable refusant un curseur corrompu, privilèges INVOKER et réouverture NodeFS propre. Le registre bancaire de cette fixture vendeur est initialement vide : sa conservation ne démontre pas un changement S contre une banque non vide. La falsification du curseur est une fixture privilégiée locale annulée par rollback, pas une modification runtime.

Les diagnostics ayant trouvé les défauts restent conservés :

| Diagnostic | Réussis/total | Échecs d'assertion |
| --- | --- | --- |
| diagnostic-v1 | 693/701 | 8 |
| diagnostic-v2 | 700/705 | 5 |
| diagnostic-v3 | 701/705 | 4 |
| regression-v2 | 7149/7150 | 1 |

Le premier typecheck a révélé5 erreurs ; le premier lint a révélé8 erreurs. Les corrections portent sur les annotations de types, les URL synthétiques, les éléments output accessibles et le cleanup de session. Les bugs SQL corrigés comprennent la priorité des opérateurs JSON, le BEFORE INSERT déclenché par UPSERT (remplacé par UPDATE/INSERT explicite sous les mêmes verrous), et le contrôle de curseur stable appliqué à tort pendant l'append. Les fixtures de replay ont été reconstruites canoniquement. Trois chemins navigateur ont été protégés contre la réentrance : refreshSeller, envoi commun et prepareInvoice ; les tests vérifient stop synchrone, double intention refusée et absence de pending ressuscité.

La première régression complète termine exit1 : 7 019 assertions passent, mais la suite account-workspace-pages refuse son import à cause d'un mock transitoire incomplet. Elle est conservée en diagnostic et n'est pas présentée comme réussie. La contrelecture découvre aussi une véritable fenêtre SSR : deux gates vendeur étaient attendues après la dernière vérification des droits/session, permettant de rendre les métadonnées de l'ancien espace après changement de compte pendant cette attente. Les gates sont maintenant capturées avant cette barrière et le rendu ne comporte plus ces attentes. Seize nouveaux cas vérifient les quatre combinaisons de flags, les changements de compte/déconnexion/rôle/révocation/discovery pendant chaque gate et l'absence d'appels legacy/unavailable ; les destinations hors gestion gardent également cette absence. Les booléens SSR ne deviennent jamais une autorité API. Cette correction est revalidée dans les sélections et contrôles finaux ci-dessus.

La seconde régression complète termine également exit1 : 7 149/7 150 assertions passent, avec un échec dans l'ancien test d'expiration d'invitation. Sa durée de validité d'une seconde pouvait être consommée avant même la création en base ; il échouait avant son attente chronométrée. Le plan est amendé avant l'édition de ce seul fichier de test. Ce scénario utilise maintenant une horloge synthétique unixepoch sans argument, limitée à sa connexion SQLite isolée, et avance ensemble le temps du port et de SQL. Il contrôle la place réservée avant expiration, sa libération exactement à l'expiration et une seconde après, une nouvelle invitation possible et l'ancienne acceptation refusée. Aucun trigger, règle runtime, helper partagé ou migration n'est modifié ; aucune tolérance ni retry automatique ne masque le défaut. Cette horloge ne constitue pas une preuve de temps mural ou hébergé. Les ciblés, la qualité et la régression sont réexécutés sur l'arbre corrigé.

Navigateur : **deux rounds de17 vues**, quatre langues, clair/sombre, largeurs390/1280px et cas DE320 supplémentaire ; zéro erreur page ni débordement détecté. Quatre captures effectivement examinées. Une seule correction visuelle groupée a remplacé trois comparaisons répétitives par un avant/après compact, avec CSS existante. Workflow synthétique réel owner/handler/kernel : accord obligatoire, réponse perdue après succès, correction S externe, nouvelles écritures fermées, reprise avec body/UUID identiques et reçu rejoué ; deux appends seulement (demande initiale et correction externe), livre financier et banque inchangés.

Ces captures précèdent les corrections fonctionnelles de réentrance, les ajustements sémantiques/cleanup du composant vendeur et le déplacement de la barrière SSR. Les deux sources différentes parmi les sept sources capturées et leurs hashes avant/après sont explicités dans l'evidence ; la page SSR ne faisait pas partie de ces sept sources et n'a pas été recapturée en navigateur. Aucune troisième ronde ni prétention de capture du binaire final. Aucun test de provider, Auth/D1 hébergé ou durabilité PG ne provient du harnais mémoire. Le serveur local a été arrêté.

Une contrelecture indépendante de la migration et de la recette finale, puis du correctif de page et de ses tests, et enfin de l'horloge locale d'expiration, sont conservées dans l'evidence. Ces lectures ne sont pas des exécutions de tests. Les sorties financières antérieures répertoriées dans la preuve ont été archivées puis restaurées octet pour octet ; leurs empreintes sont vérifiées. Les anciens documents de livraison restent immuables.

## 6. Risques identifiés

- La frontière nom commercial/entité légale demande une revue professionnelle ; aucun statut de conformité, certification US GAAP ou garantie de résidence supplémentaire.
- Un hash cohérent reste structurel ; l'autorisation et la provenance viennent des données/admissions privées corroborées.
- Les relectures Auth/D1 et transactions PG ne forment pas une transaction distribuée. Recette hébergée multiutilisateur/multiappareil distincte.
- PGlite sérialisé ne démontre ni concurrence multiconnexion, crash, charge ou latence de production. Réouverture propre ne signifie pas reprise après panne brutale.
- Pending conservé en RAM ; purger une session n'est pas une preuve de non-commit. Aucune nouvelle persistance hors ligne de ces demandes sensibles.
- Les budgets capturent des JSON détachés ; ils ne garantissent pas la mémoire avant allocation ni le coût réseau/hébergement.
- Contexte fiscal absent/expiré toujours bloquant ; aucun renouvellement de marchand, credential, binding ou fenêtre de retry.
- Pas d'audit exhaustif d'accessibilité, de mesure de contraste ou d'essai natif Windows/macOS/iOS/Android dans ce lot.

## 7. Fonctionnalités terminées

Contrat/exécution propriétaire, port/store/RPC/HTTP fermés, audit S immuable, reçus exacts et CAS, distinction présentation/fiscal, devis au S courant, contexte facture2 et reprises historiques1/2, session commune avec observation composite, comparaison/approbation en quatre langues, purge de droits, barrière SSR après les capabilities et invalidation sélective des previews/exports. Tests locaux, compilation, régression sélectionnée et preuves de livraison sont consignés.

## 8. Fonctionnalités encore expérimentales et suite

Le pilote US reste privé TEST, fermé par défaut et non déployé. L'ERP US complet demeure en cours. Avant activation hébergée : approbation explicite, revue de la chaîne réellement appliquée et recette Auth/D1/PG réelle avec données fictives ; pas de données clients en démo.

Adresse et identité fiscale, renouvellement marchand, providers réels/sandbox, banque réelle, nouveaux tarifs USD, Stripe SaaS et distributions natives sont hors lot. Les données et abonnements CHF suisses ne sont ni migrés ni réinterprétés. Le relevé client CSV est une prochaine verticale locale à planifier ; les validations professionnelle, hébergée et native demeurent séparées. Aucun résultat local ne vaut autorisation de production.
