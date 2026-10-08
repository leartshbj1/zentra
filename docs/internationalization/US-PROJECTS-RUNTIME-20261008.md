# Zentra US — dossiers projets et validation du lot

Base locale : `42d516ad70d8547a8914f19daa5597b5ce2d00b9`, branche `codex/international-runtime`. Ce lot reste dans le checkout international isolé. Le site commercial a été publié séparément en Sites354 : l'accueil met les résultats en avant et son lien vers la visite de l'app est direct. Un contrôle HTTP du 8 octobre retourne 200 et retrouve ces deux éléments. Ce checkout ERP n'a pas remplacé cette publication.

## Comportement livré

Les projets US possèdent maintenant leur registre dans le même livre ERP schema3, avec la révision globale, les reçus idempotents, les événements et les deltas existants. Ils comportent un client, un nom explicite, des notes, un statut actif/archivé, des dates réelles, un budget net en USD exact et les associations vers des factures fournisseurs déjà enregistrées. Aucun montant financier n'est calculé avec un flottant. Une facture fournisseur ne peut appartenir à deux dossiers.

Les dossiers dérivent les devis, factures émises, paiements et achats du livre autorisé. Devis, montants facturés, taxes enregistrées, encaissements et soldes restent séparés : un devis converti n'est pas ajouté une seconde fois au chiffre d'affaires. Le budget et les devis ne deviennent pas du revenu ; les taxes d'achat ne constituent pas une affirmation de déductibilité. Archiver un projet conserve les documents et paiements historiques.

Seule une commande explicite `save_projects` peut promouvoir un ancien livre. Tous les identifiants de projets déjà référencés doivent être confirmés ensemble avec leur vrai nom et leur client, sinon la promotion est refusée. Les livres schema1/2 conservent leur forme exacte. Après liaison de documents commerciaux, le client du projet est verrouillé. Les nouvelles liaisons de devis exigent un projet actif pour le bon client ; les documents historiques restent utilisables après archivage.

Le dossier est disponible en français, allemand, italien et anglais américain, avec thèmes clair/sombre, lecture mobile et contrôles des brouillons lors d'un changement de rôle ou d'espace. Les données saisies par l'utilisateur ne sont pas traduites. Une duplication réelle de panneaux due à des clés React communes a été corrigée ; le scénario vérifie désormais qu'un seul dossier, panneau et éditeur sont présents.

Les exports JSON, CSV, HTML imprimable et PDF reprennent le port d'export authentifié existant. Ils retirent les identifiants fiscaux privés, acteurs et preuves internes. Les contrôles d'accès, de capability, de session, d'entitlement et de flags sont refaits après rendu ; un changement d'autorité en attente empêche le téléchargement. Les PDF utilisent les polices fixes côté serveur et le format Letter. Des coordonnées très longues passent par une pagination sûre : le test indépendant conserve les 2 112 glyphes synthétiques, sans débordement. Le dossier n'est ni un stockage d'originaux ni une preuve d'archivage réglementaire.

## Migration et sécurité

La migration additive `supabase/migrations/20261008105120_international_us_projects_v3.sql` a été générée via Supabase CLI puis exécutée localement dans PGlite. Les **134 anciens fichiers SQL** sont inchangés par rapport à la base (normalisation des fins de ligne seulement). Aucune migration, suppression, activation ou modification de production n'a été réalisée.

Schema3 exige la capability client3 et les flags serveur US/purchasing/projets, fermés par défaut. Les gardes des achats schema2 sont conservées et appliquées aussi à schema3. Les écritures de projets et leurs timestamps sont corrélés à l'acteur final, au reçu et à l'événement ; les modifications directes isolées sont refusées. Le test exécute un lot réel de 1 000 projets et les essais d'injection, faux compteurs, révisions, clients et liens étrangers.

Le patch local `braces@3.0.3` borne la profondeur à 100 et préserve les cas ordinaires observés upstream. **42 tests Node passent** sur le paquet effectivement installé, dont 132 comparaisons de référence et deux processus à pile/heap bornés. Il n'existe pas de correctif officiel publié dans la preuve consultée ; ce patch est une mitigation locale. L'audit de dépendances reste non propre : métadonnées production 3 high ; audit complet 6 low, 20 moderate, 14 high et 4 critical. Les deux exceptions préexistantes restent documentées, sans nouvel ignore. Voir le rapport BRACES-DEPTH-HARDENING pour les limites et rapports bruts.

## Validation exécutée

La relance de la suite de régression sélectionnée, après correction de la liste de migrations de fixture, donne **3570 tests réussis dans 94 fichiers**, zéro échec et zéro ignoré. Les six parcours navigateur optionnels sont explicitement activés. TypeScript global, lint avec analyse de types de **38 fichiers**, build Vinext de production et diff-check passent. Les **45 sources** ont les mêmes hashes pendant/après tests, types, lint et compilation. Les premiers échecs de fixture et de lint sont conservés dans les journaux, puis corrigés et confirmés par la suite finale. La liste exacte des tests figure dans la preuve ; ce lot n'annonce pas une recette exhaustive de chaque module natif.

Le diff-check des fichiers indexés est sans erreur pour les sources, SQL et documents. Le fichier de patch unifié contient vingt lignes de contexte vide composées d'un espace, nécessaires à son format : elles sont vérifiées séparément, sans espace final dans les lignes de code ajoutées. Le diff-check global signale ces lignes de format ; aucune exclusion de sécurité ou modification du patch installé n'est ajoutée.

Le parcours projets effectue **9 commits et 10 POST**, dont le rejeu exact après une réponse perdue. Il exerce budget au-delà de la précision Number, liaison achat unique, devis accepté, facture TEST, paiement partiel, archivage/restauration, export PDF réel, refus d'autorité tardif et effacement des brouillons. Les 16 vues couvrent quatre langues, deux thèmes et 390/1 280 px, avec une vue supplémentaire 320 px à 200 % de texte ; zéro erreur JavaScript. Neuf captures ciblées ont été inspectées en une passe bornée. Le détecteur visuel n'a donné que trois conseils sur les couleurs fallback déjà cohérentes avec les variables du compte ; ce n'est pas une certification d'accessibilité.

Les tests utilisent les vrais composants React, handlers HTTP, commandes/deltas et générateurs de fichiers, mais Auth et CAS RAM sont synthétiques. PostgreSQL est testé sur une connexion PGlite RAM sérialisée avec les RPC service_role et la vraie chaîne SQL. Ce n'est pas une preuve PostgREST/Auth hébergée, concurrence multi-connexion, redémarrage, synchronisation physique Windows/iPhone/Mac ni capacité de charge. Le provider fiscal reste une fixture privée TEST ; en production il est absent et l'émission reste fermée.

La police PDF est absente du JavaScript client ; le chunk serveur fait 1526800 octets (720070 gzip). Cela ne mesure pas les ressources d'un Worker hébergé. Le build conserve ses diagnostics de middleware/routes statiques ; les harness de tests signalent un chunk supérieur au seuil conseillé de 500 kB.

## Fichiers créés

- `components/account/us-erp-projects.css`
- `components/account/us-erp-projects.tsx`
- `docs/evidence/us-projects-runtime-20261008.json`
- `docs/internationalization/BRACES-DEPTH-HARDENING-20261008.md`
- `docs/internationalization/NATIVE-US-ADMISSION-PLAN-20261008.md`
- `docs/internationalization/NATIVE-US-ALIGNMENT-AUDIT-20261008.md`
- `docs/internationalization/US-PROJECTS-RUNTIME-20261008.md`
- `docs/internationalization/US-PROJECTS-RUNTIME-PLAN-20261008.md`
- `lib/international/browser-projects-copy.ts`
- `lib/international/browser-projects-session.test.ts`
- `lib/international/browser-projects.browser.test.ts`
- `lib/international/browser-projects.test.ts`
- `lib/international/browser-projects.ts`
- `lib/international/projects-bindings.test.ts`
- `lib/international/projects-export-server.test.ts`
- `lib/international/projects-exports.test.ts`
- `lib/international/projects-transport.test.ts`
- `lib/international/projects.postgres.test.ts`
- `lib/international/projects.test.ts`
- `lib/international/projects.ts`
- `patches/braces@3.0.3.patch`
- `scripts/braces-depth.test.mjs`
- `scripts/fixtures/braces-3.0.3-compatibility.json`
- `supabase/migrations/20261008105120_international_us_projects_v3.sql`

## Fichiers modifiés

- `components/account/us-erp-reports.tsx`
- `components/account/us-erp-workbench.tsx`
- `lib/international/browser-erp-session.ts`
- `lib/international/browser-export-session.ts`
- `lib/international/erp-request.ts`
- `lib/international/erp-schema-capability.ts`
- `lib/international/export-bindings.ts`
- `lib/international/export-copy.ts`
- `lib/international/export-renderer.ts`
- `lib/international/export-server.test.ts`
- `lib/international/export-server.ts`
- `lib/international/export-snapshot.ts`
- `lib/international/export-test-fixture.ts`
- `lib/international/exports.postgres.test.ts`
- `lib/international/purchasing-transport.test.ts`
- `lib/international/runtime-bindings.ts`
- `lib/international/runtime-server.ts`
- `lib/international/runtime-store.ts`
- `lib/international/runtime-sync-server.ts`
- `lib/international/runtime-sync-store.ts`
- `lib/international/runtime-sync.ts`
- `lib/international/runtime-types.ts`
- `lib/international/runtime-validation.ts`
- `lib/international/runtime.ts`
- `lib/international/workspace-creation.integration.test.ts`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

## Statut, retour arrière et prochaine étape

Terminés dans ce lot : registre projets partagé, revue explicite de références historiques, dossiers liés aux ventes/achats, interface multilingue et exports autorisés. Expérimental : édition US, rapports internes et émission TEST. Aucun appel Stripe réel, prix USD nouveau, ACH/paiement carte, document fournisseur original, certification US GAAP ou conformité légale complète n'est annoncé.

Le prochain lot est l'admission native CH/US et un contrôleur US commun à tous les menus. L'audit natif confirme que le pilote actuel reste limité aux paramètres et que ses contrats TS/Rust n'acceptent que schema1. Il faut dispatch explicite, schemas1/2/3, sélection d'espace, autorité US dédiée et ports protégés ; créer une licence CHF de contournement serait incorrect. Le plan natif accompagne ce lot.

Le retour arrière commence par la fermeture du flag projets pour arrêter les nouvelles écritures. Un livre schema3 ne doit jamais être vidé ou rétrogradé pour un ancien client : il reste conservé et volontairement inaccessible à un client incapable jusqu'au rétablissement d'un accès compatible. La migration proposée n'est pas désinstallée automatiquement. Un staging réel avec données fictives, puis validation du prestataire fiscal, des règles complexes et des plans commerciaux, sont encore nécessaires avant activation de production.

Les listes, empreintes, résultats et limites sont dans `docs/evidence/us-projects-runtime-20261008.json`. Les logs détaillés restent locaux sous `.qa/us-projects`, `.qa/us-projects-browser` et `.qa/braces-hardening`.
