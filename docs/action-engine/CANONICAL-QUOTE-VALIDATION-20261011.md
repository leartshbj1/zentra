# Action Engine — A6 : preuve du vrai brouillon

## Résultat et périmètre

Le serveur possède maintenant un vérificateur privé du client, du devis et de toutes ses lignes dans la vraie base SQLite d'une archive publiée. Une déclaration de l'appareil, un audit, un reçu ou un sidecar cohérents entre eux ne remplacent jamais les lignes métier. La première preuve refuse un devis modifié, émis, supprimé ou incomplet et demande une revue ; elle ne recrée rien.

**Ce lot est local, désactivé et non déployé.** Il ne crée aucun nouvel endpoint, IPC, déclencheur Support ou notification. Il ne constitue pas encore le raccord authentifié complet entre le fait PostgreSQL, les chunks de transport et la confirmation centrale. Le refus de confirmation de `published-fences.ts` reste `sql: '0'` ; une composition historique distincte exige désormais une preuve canonique durable.

Code serveur : `0e9330c7efaf143acf0998a96a251477b75a8d0b`, parent `4f2d9d8`.
Code desktop 1.90.15 : `3eee678aa16fc0eeb9f559232aa7a5ac66fb6453`, parent `23b4b34a`.

## Sources et contrat

Créés côté serveur :

- `lib/action-engine/quote-archive.ts` et son test : ZIP complet borné, annuaire central, chemins, doublons, tailles, CRC, déflation exacte et SHA de l'archive ; extraction du vrai `database.sqlite3`.
- `lib/action-engine/sqlite-reader.ts` et son test : SQLite réel via WASM statique, lecture seule, requêtes constantes, tables physiques, stockage INTEGER exact et texte UTF-8 strict. Les vues, tables virtuelles, colonnes générées et conversions trompeuses des tables de preuve sont refusées.
- `lib/action-engine/canonical-quote.ts`, son fixture et son test : recorroboration des vrais client/devis/lignes/reçu/audit, arrondis BigInt, IDs déterministes, SHA de la source initiale et du bloc de création ; capacité privée scellée par WeakSet, non remplaçable par un JSON désérialisé.
- `lib/action-engine/reservation-binding.ts` : capture fermée de la provenance d'origine, sans cycle entre vérificateur et journal.
- `lib/action-engine/quote-publication-evidence.ts` et son test : journal permanent acceptant seulement cette capacité, appariement exact à la réservation, au contexte lié et aux deux publications historiques committed.
- `lib/action-engine/historical-quote-fences.ts` : lecture/délégation actuelle, confirmation historique conditionnée à la preuve exacte. Ce helper privé n'est appelé par aucune route.
- `drizzle/0103_action_engine_quote_publication_evidence.sql` : liaison et preuve append-only, contraintes et triggers contre remplacement, modification, suppression et rattachement rétroactif.
- `scripts/sqlite-worker-plugin.mjs`, `sqlite-wasm-runtime.d.ts`, `lib/action-engine/sqlite-wasm.test-runtime.ts` : intégration du module WASM précompilé et alias Node de test vers les mêmes octets.

Modifiés côté serveur : `ledger.ts`, `ledger-types.ts`, `published-fences.ts`, `support-source.ts` et son test, `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `vitest.config.ts` ; ce rapport, le manifeste de preuves, README, STATUS et le contrat de publication.

La réservation nouvelle lie les SHA des ressources et de la source ainsi que la publication de planification dans le **même batch D1** que sa création et son événement. Le hash global des ressources change naturellement après création d'un client : la preuve utilise la liaison d'origine, sans comparer arbitrairement le catalogue postérieur. Les anciennes réservations non liées ne sont pas réparées silencieusement.

Le journal ne conserve que les identités, le reçu et les empreintes, sans contenu brut d'e-mail ni nom/prix dans la preuve centrale. La première preuve exige un client et un devis aux IDs exactement égaux, un brouillon CHF non numéroté, toutes les lignes du plan, les quantités réelles et montants entiers recalculés, les nulls et dates initiaux, le reçu natif et l'audit `local_user` exact. Les collations SQLite falsifiées ne permettent pas de substituer un autre ID. Une erreur JSON produit un code borné, sans exposer le contenu.

Après enregistrement durable, la preuve historique reste utilisable malgré un catalogue ou une tête plus récents, une modification/émission/suppression du document ou la purge de son ancien transport. Elle conserve les permissions actuelles. Un ancien reçu sans preuve A6 ne doit pas être accepté comme confirmation A6 par le futur orchestrateur.

## Sources natives

Deux fichiers modifiés : `desktop/src-tauri/src/action_engine_quote.rs` et `action_engine_quote_tests.rs`, uniquement dans `app-current-corrections`.

Le writer relit par SELECT le client, le devis et toutes ses lignes après insertion, dans la même transaction IMMEDIATE, avant audit et outbox. Il compare les valeurs au plan et recalcule les cents en i128 ; une altération par trigger provoque le rollback global. La quantité REAL doit égaler exactement les millièmes du plan divisés par 1 000.

L'audit conserve ses champs antérieurs et ajoute `creationJson` version 1 et son SHA-256 : sérialisation typée ordonnée, nulls explicites, plafond 65 536 octets UTF-8, source initiale hashée et faits réellement stockés. Aucun schema 63, backfill ou changement de reçu historique. Le hash de chaîne n'est pas épinglé : une fusion peut le rebaser sans modifier l'ID/payload d'origine.

**5 nouveaux tests natifs écrits, 2 existants enrichis ; 68 avec A3/A5, aucun exécuté.** Les deux fichiers ont seulement été parsés avec `rustfmt --edition 2021 --emit stdout --config skip_children=true`, sortie jetée, codes 0. Le refus Windows App Control 4551 n'a été ni retenté ni contourné. Rustfmt ne prouve pas le typage, la liaison, l'exécution Rust, Tauri ou SQLite.

## Validation réellement exécutée

- Régression serveur : **1 524/1 524**, **47 fichiers**, zéro échec ou attente, 105,91 secondes. Baseline A5 1 365 + 159 nouveaux cas A6 : archive 74, lecteur SQLite 29, canonique 32, preuve/journal 22, accès source historique 2.
- Ciblés finaux canonique/lecteur : **61/61**, inclus dans ce total. Journal/ledger ciblés : **85/85**, également inclus.
- Smoke des vrais modules archive/lecteur/canonique sous **Workerd : 6/6**. Clients nouveau/existant, UTF-8 invalide, cents REAL/TEXT refusés, quantité REAL légitime acceptée. SQLite de fixture synthétique exécutant les vraies tables natives ; aucun writer Rust exécuté.
- Spike Workerd préalable : module WASM statique, zéro fetch/compilation dynamique, écritures/extensions refusées, INTEGER au-delà de MAX_SAFE préservé par `useBigInt`, inflation bornée et flux superflus détectés.
- Typage `tsc --noEmit --incremental false`, lint ciblé Action Engine/schéma/route/config, format, assets de marque, `git diff --check` et build `vinext build` : codes 0. Le périmètre Support élargi conserve ses 29 diagnostics préexistants ; aucune propreté globale n'est annoncée.

Les échecs intermédiaires sont conservés dans les preuves : import WASM Vitest incorrect, fixtures FK ou writable_schema impropres, assertions de binding de test, puis diagnostics lint/types corrigés. Les résultats finaux ci-dessus ont réellement été exécutés ; les décomptes ciblés ne s'ajoutent pas à la régression.

## Dépendance, limites et migrations

Production : `sql.js` **1.14.2**, licence MIT, version et lockfile épinglés ; `@types/sql.js` 1.4.11 en développement. Aucun script d'installation exécuté. Le plugin vérifie le SHA de la distribution JS originale et transforme uniquement son token d'environnement Emscripten connu pour Workerd, sans mutation globale ni `define`. WASM précompilé importé statiquement ; aucun chargement distant ou compilation dynamique de bytes client.

Bornes du pilote de preuve : archive 16 MiB, SQLite 8 MiB, total décompressé 32 MiB, 512 entrées. Ces bornes privées ne réduisent pas celles du transport ou des sauvegardes ordinaires. Les SELECT sont privés, constants, sans index utilisateur, et limités en requêtes/lignes/texte ; handles clos à la sortie. `hard_heap_limit` limite l'allocateur SQLite à 32 MiB, **pas toute la mémoire JS/WASM**. Le build upstream ne fournit pas progress_handler/interrupt/limit : **aucune garantie stricte de CPU/opcodes n'est revendiquée**. Une base hors contrat demande une revue, jamais une preuve permissive.

Migration D1 **0103 additive proposée et testée localement uniquement**, avec les migrations D1 réelles existantes. Aucune nouvelle migration Supabase, aucun déplacement de région ou désactivation RLS. Garder les tables de preuve ; rollback fonctionnel par désactivation du pilote, pas suppression des registres. Les prérequis A4/A5 restent requis avant distribution ; une entreprise déjà gardée ne revient pas au transport pré-A4.

## Suite et limites d'activation

Reste à raccorder : entrée appareil authentifiée, lecteur réservation/liaison/source, garde pays au point D1, récupération du fait PG exact committed et des chunks authentifiés, SHA complet, preuve A6, append durable puis confirmation du registre. Le replay avec preuve doit éviter l'ancien transport ; un reçu legacy seul reste insuffisant. Ce raccord ne doit pas lever les gardes de `published-fences.ts` pour une preuve de catalogue.

Il faut ensuite valider le natif sur un hôte autorisé, une vraie archive synthétique Rust, les pertes de réponse et plusieurs appareils, puis connecter le writer dédié, Support et une notification ouvrant le vrai devis. Aucun faux compte client ou véritable donnée client n'est utilisé ici. Aucun appel JEV réel, e-mail, paiement, suppression, migration distante ou déploiement. L'objectif global reste actif et incomplet.
