# Action Engine — A5 : reprise avant fusion

## Résultat

Le serveur peut maintenant retrouver une publication d'origine avant que l'application prépare à nouveau son archive ou tente une fusion. Cela évite de prendre une réponse perdue pour une nouvelle branche locale, notamment quand un autre appareil a déjà publié une révision plus récente.

**Ce lot est validé localement côté serveur, pas déployé.** Les sources natives sont écrites et relues ; leur compilation et leurs tests restent bloqués par le refus Windows App Control 4551 constaté en A3. Ce blocage n'a été ni retenté ni contourné. Rustfmt a seulement parsé les deux fichiers A5, sans modifier les sources : cela ne constitue pas une compilation ou une exécution de test.

Code serveur : `db417589dfb0fa753688bef5180f3648c47ad547`, parent `2dbc301306d7d985710a90a99ce0ead04a64921a`.

Code natif : `528d7f599327b6890ae87037306a931126182e14`, parent `e7ae48848a529a368b238ac57f724f1c8aff10df`.

## Modifications et fichiers

Créés côté serveur :

- `lib/action-engine/publication-recovery.ts` : récupération authentifiée, captures fermées, comparaison de l'identité et du manifeste avec la tentative immuable, corroboration PG avant tout accusé positif.
- `lib/action-engine/publication-recovery.test.ts` : 72 cas unitaires avec ports externes simulés et véritable validateur de fait.
- `lib/action-engine/publication-recovery.integration.test.ts` : 20 cas avec vraie SQLite, vraie migration D1 0102, vrais registre/coordinator/gateway/validateur et faits RPC déterministes.
- Ce rapport et `docs/evidence/action-engine-publication-recovery-20261011.json`.

Modifiés côté serveur :

- `app/api/account/collaboration/route.ts` : action `recover-publication` dans le transport existant, derrière session appareil, pays, limite de débit, borne de corps 1 MiB et réponses privées non mises en cache.
- `lib/company-collaboration-route.test.ts` : trois contrôles supplémentaires d'authentification, de débit, de taille et d'absence d'appel à prepare/commit/upload dans la sonde.
- `lib/action-engine/README.md`, `docs/action-engine/PUBLISHED-CONTEXT-CONTRACT.md` et `docs/action-engine/STATUS.md` : contrat, prérequis et état exact de livraison.

Côté desktop 1.90.15 :

- Modifié `desktop/src-tauri/src/company_collaboration.rs` : sonde avant préparation/fusion ; reprise exclusive du commit existant du même ID si nécessaire ; relecture des préférences et de la tête après résultat connu ; contrôles d'origine et du pending avant commit/confirmation. Aucun nouvel IPC.
- Créé `desktop/src-tauri/src/company_collaboration_publication_recovery_tests.rs` : **13 tests écrits, non exécutés**. Ils utilisent une archive locale réelle et un transport injecté, avec un facsimilé pour l'ordre tête/fusion ; ils ne prouvent pas le parcours Tauri complet ou HTTP.

Le checkout historique `C:/Users/alb/Documents/ChatGPT/chantier` n'a pas été modifié. Aucun ancien desktop 1.46.1 n'est distribué.

## Contrat de reprise

Entrée fermée : `{action:'recover-publication',id,baseRevision,manifest}`. Les champs entreprise/utilisateur/installation reçus du client sont refusés ; la session fournit l'identité. Les valeurs et le manifeste imbriqué sont copiés avant toute attente, sans invoquer d'accesseur.

La sonde retourne :

1. Absence réelle D1 : `{known:false}`. Aucun appel PG, aucune écriture, aucun effacement du pending local.
2. Tentative D1 pending sans fait committed : `{known:true,pending:true}`. Le client reprend le POST `commit` avec **le même ID** avant toute fusion, sans prepare/upload. Un crash entre la réservation D1 et l'appel PG peut ainsi progresser ; une réponse 503 permanente l'aurait bloqué.
3. Commit PG exact vérifié : `{known:true,committed:true,revision,snapshotId}`. Le settlement D1 doit réussir avant la réponse si la tentative était pending. La révision reste base + 1 d'origine, jamais la tête courante d'un autre appareil.
4. Annulation terminale D1/PG concordante : `{known:true,committed:false,revision,snapshotId}`. Elle n'est pas un accusé de l'archive et ne nettoie pas le pending local. Si seule PG est cancelled et D1 reste pending, la sonde retourne l'état 2 : le commit exact existant rapproche ensuite le tombstone.

Une panne, une table/RPC absente, une contradiction ou un résultat malformé arrêtent la reprise. Ils ne deviennent jamais une absence de reçu ou une autorisation de créer un nouvel ID. Un état PG pending durable avec résultat null reste un défaut de protocole ; les RPC A4 normaux rendent leur résultat terminal dans la même transaction.

La sonde ne fait aucun `begin`, `enableGuard`, `commit`, `close`, téléchargement, upload, annonce ou purge. Sa seule mutation possible est le settlement D1 d'un commit PG corroboré. La reprise historique reste possible après retrait de l'allowlist ; elle conserve les contrôles de transport et de pays actuels.

Après accusé positif, le natif utilise sa propre archive figée comme référence et conserve son horloge d'origine. Les changements métier postérieurs restent à publier ; aucune ancienne copie n'est réimportée sur les données de travail. Une confirmation seule laisse `changed=false`, évitant un rechargement inutile des formulaires. Lecture seule et acceptation explicite d'une version distante ne prennent pas cette nouvelle voie.

## Tests réellement exécutés

- Ciblés A5 : **103/103**, trois fichiers — 72 unitaires, 20 SQLite et 11 de route dont huit préexistants. Ces cas sont inclus dans la régression et ne s'ajoutent pas à son total.
- Régression : **1 365/1 365**, **43 fichiers**, zéro échec ou test en attente. Ce total comprend 1 270 cas de la baseline A4 et 95 nouveaux cas A5. Durée de la commande : 105,89 secondes.
- Périmètre : Action Engine, Automation, les connecteurs Infomaniak sélectionnés, Support/classification, documents mail, collaboration, transport cloud et gardes pays historiques. Les tests PostgreSQL A4 et les compositions SQLite/PostgreSQL ont été réexécutés dans cette commande.
- Typage : `tsc --noEmit --incremental false`, code de sortie 0.
- Lint : noyau Action Engine, schéma D1, route collaboration et ses tests, code de sortie 0. Cela ne signifie pas que tout le dépôt est sans diagnostic : les 29 diagnostics Support préexistants consignés en A3/A4 ne sont pas corrigés par ce lot.
- Format : les trois nouveaux fichiers TypeScript A5, réussi.
- Assets de marque, `git diff --check` et build de production `vinext build`, réussis. Un build n'est pas un déploiement.
- Rustfmt `--emit stdout --config skip_children=true` sur les deux fichiers natifs A5, codes de sortie 0. Aucun Cargo check/test ni exécutable natif n'a été relancé.

La première exécution ciblée a échoué sur un nouveau test de route dont la requête omettait `Content-Type: application/json`. Le fixture a été corrigé ; les 103 cas ciblés puis les 1 365 de régression ont effectivement réussi. Aucun échec n'est masqué dans les résultats finaux.

Les commandes, suites, assertions et empreintes des sources sont consignées dans le manifeste de preuves. Les fixtures SQLite A5 simulent les RPC PG ; elles ne constituent pas une nouvelle preuve PostgREST/hébergée. Les tests A4 réexécutés utilisent PostgreSQL local PGlite. Aucun test ne prouve ici un échange entre deux vrais appareils.

## Migrations, déploiement et retour arrière

**Aucune nouvelle migration A5.** Prérequis de la récupération : migration D1 0102 et registre/RPC PostgreSQL de `20261011011348_action_engine_publication_coordination.sql`, avec leurs schémas historiques déjà réconciliés. Les migrations A0–A4 restent locales et proposées ; rien n'est appliqué en production.

Ordre requis avant une future distribution :

1. Valider les migrations additives A4 et les parcours multi-connexions sur staging approuvé.
2. Installer les schémas D1/PG A4 et le serveur A5 avant le client natif A5.
3. Compiler/exécuter les 63 tests natifs A3/A5 et les régressions de fusion/restauration sur un hôte autorisé.
4. Vérifier des pertes de réponses et le rapprochement réel, avec données fictives et plusieurs appareils.

Retirer l'allowlist ne retire pas un garde PG permanent. Une entreprise déjà gardée ne doit pas revenir à un serveur antérieur à A4 ; son transport doit conserver le gateway coordonné et la reprise de ses reçus. Aucun indicateur de fonctionnalité ne justifie une suppression de registre ou de données métier.

## Terminé, limites et suite

Terminé localement : sonde serveur, validation du contrat, rapprochement des résultats déjà committed, reprise du commit exact dans les sources natives et protections contre les faux accusés.

Encore à valider : les **63 tests natifs écrits** (50 A3 + 13 A5), l'exécution Tauri/HTTP complète, l'interopérabilité d'une vraie archive Rust, les connexions PostgreSQL concurrentes hébergées et le déploiement coordonné. Les limites préexistantes d'un premier partage jamais publié, sans référence historique, ne sont pas résolues par cette sonde.

Toujours absent : commande Action Engine native exposée de manière sûre, déclenchement Support, preuve canonique du devis/lignes/reçu publiés, confirmation métier et notification ouvrant le vrai devis. La confirmation reste **`sql: '0'`**. Un reçu de transport, un catalogue ou un sidecar hashé ne prouvent pas à eux seuls la création du devis. L'objectif global reste actif et incomplet.

Aucun appel JEV réel, envoi d'e-mail, paiement Stripe, donnée client réelle, suppression ou changement de production n'a eu lieu.
