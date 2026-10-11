# A17 — préparation de la validation native isolée

## Résultat réel

La CI existante ne sélectionnait pas explicitement tout Action Engine. Ce lot prépare un profil **uniquement de vérification**, consommé depuis le catalogue de tests de la véritable bibliothèque compilée. Il n'est pas lancé : aucune compilation native, preuve d'exécution Rust ou publication n'est annoncée.

Source native : `3adcb83018280ef3d21953225cf72dada1659c94`, parent `b39daac0a88e580e907b8bd79ce1b5c320cd5aac`. Le runtime natif et serveur n'est pas modifié. Version **1.90.15**, schémas partagé et sidecar **62** conservés. Aucune migration, donnée client, clé fournisseur, requête JEV, opération financière, connexion applicative ou activation de production.

Le manifeste `docs/evidence/action-engine-native-ci-verification-20261011.json` conserve les empreintes des cinq fichiers, des contrôles locaux et de la documentation. Le présent rapport est copié à l'identique dans le checkout natif.

## Profil CI et fermeture des chemins de publication

Le nouveau sélecteur `action-engine` conserve `full` comme valeur par défaut. Le workflow `action-engine-native-verification` exige simultanément :

- branche exacte `codex/action-engine-native` ;
- `diagnostics-native-set: action-engine` et `verify-only: true` ;
- `release: false` ;
- `smoke-windows-job: 0` et `smoke-apple-job: 0`.

Sans cet opt-in, une simple poussée sur la branche réservée ne lance aucun job. Les 53 workflows antérieurs refusent explicitement le nouveau sélecteur. Les cinq workflows génériques release/smoke excluent aussi la branche réservée, indépendamment du sélecteur. Les autres branches/profils conservent les conditions, jobs et valeurs par défaut antérieurs.

Une première revue a trouvé un vrai défaut : protéger seulement les workflows génériques laissait les anciens workflows de packaging déclenchables par leur branche avec `action-engine`. La correction couvre maintenant tous les workflows historiques, dont ceux qui n'appellent pas le script Windows et ne pourraient donc pas être arrêtés par son garde.

Le script Windows refuse le profil avant bootstrap sans les deux gardes de vérification exactement vraies, le mode `all`, `CIRCLECI=true`, `OS=Windows_NT` et la branche dédiée. Le chemin diagnostics existant compare `CIRCLE_SHA1` au HEAD exact avant de préparer le harness. Le helper pur est importé après cette initialisation ; le plan provient de `Harness.TestNames`, résultat du vrai `--list` compilé. Les filtres sont exécutés avec leurs arguments, puis leurs résultats corroborés avant la preuve `diagnostics-action-engine-proof.json` et un `return` avant packaging.

Cette future preuve distingue le SHA source, les noms choisis, les compteurs d'exécution et la preuve du harness. Elle indique explicitement absence de build frontend, tests mobiles, suite fonctionnelle complète, benchmark, packaging, signature, publication et installation. Aucun export ZIP partiel n'est activé.

La logique `when` utilise uniquement paramètres/valeurs de pipeline et opérateurs `and`, `not`, `equal`, selon la [référence de configuration CircleCI](https://circleci.com/docs/reference/configuration-reference/) et la [documentation des paramètres](https://circleci.com/docs/guides/orchestrate/pipeline-variables/). L'évaluation locale ci-dessous ne remplace pas le compilateur de configuration hébergé.

## Sélection revue : 194 tests du moteur, 44 régressions complémentaires

Les nombres ci-dessous sont un **inventaire de sources et un attendu pour une future exécution**, pas des tests natifs réussis.

| Filtre | Attendu |
| --- | ---: |
| `action_engine_resources::tests::` | 20 |
| `action_engine_quote::tests::` | 67 |
| `action_engine_device_protocol::tests::` | 33 |
| `account_cloud::action_engine::tests::` | 28 |
| `backup::action_engine_archive_tests::` | 4 |
| `company_collaboration::action_engine_collaboration_tests::` | 3 |
| `company_collaboration::action_publication_tests::` | 17 |
| `company_collaboration::action_execution_tests::` | 8 |
| `company_collaboration::publication_recovery_tests::` | 13 |
| `company_merge::tests::actual_v60_and_v61_references_merge_v62_branches_receipts_and_republish_fresh_resources`, exact | 1 |
| **Action Engine** | **194** |
| `backup::recovery_tests::` | 5 |
| `company_collaboration::reference_worker_tests::` | 10 |
| `company_collaboration::content_version_compat_tests::` | 7 |
| `company_collaboration::merge_version_compat_tests::` | 3 |
| Tests actifs `backup::recovery_crash_tests::`, chacun exact | 19 |
| **Complément** | **44** |

Les 33 filtres sélectionnent 238 noms uniques. La fusion v60/v61 est un seul test libtest avec deux scénarios internes. Les deux tests ignorés `native_crash_child` et `native_crash_boundaries_restore_one_complete_profile_before_migration` restent explicitement exclus ; aucune option `--include-ignored`. Ce profil ne prouve donc pas un arrêt réel de processus.

Le helper reproduit le filtre substring du harness, ou l'égalité sensible à la casse avec `--exact`. Noms invalides/doublons, nombre changé, sélection vide ou chevauchement refusent le plan avant les suites. Un changement intentionnel des tests exigera de réviser l'inventaire. Des tests sans rapport peuvent être présents dans le catalogue sans être sélectionnés, y compris un nom valide à la racine.

La corroboration exige chaque filtre dans l'ordre attendu, contexte diagnostics, arguments complets dont `--test-threads=1` et `--exact` le cas échéant, compteurs numériques présents, exit/échecs/ignorés à zéro, nombre de réussites égal à la sélection attendue. Une suite manquante, supplémentaire ou partiellement exécutée ne devient pas un succès. Elle contrôle les enregistrements fournis par le harness ; elle ne relit pas elle-même chaque ligne libtest ou les fichiers d'archives.

## Fichiers

Créés dans `app-current-corrections` :

- `desktop/scripts/action-engine-verification.ps1` : fonctions pures de sélection/corroboration, aucun effet de bord à l'import ;
- `desktop/scripts/action-engine-verification.tests.ps1` : comportements sur catalogue et résultats entièrement synthétiques.

Modifiés dans ce checkout :

- `.circleci/config.yml` ;
- `desktop/scripts/cloud-release-windows.ps1` ;
- `desktop/scripts/diagnostics-native-selection.contract-tests.ps1`.

Documentation : rapport et copie native, manifeste, `STATUS.md`, plan d'intégration et README Action Engine côté serveur. Les scripts et journaux QA locaux ignorés sont empreintés dans le manifeste. Aucun fichier Rust, React, serveur runtime ou migration n'est modifié.

## Contrôles réellement exécutés

| Contrôle local | Résultat et portée |
| --- | --- |
| Comportements du helper | **37/37**, PowerShell 7.6.5, données synthétiques seulement |
| Contrats source/AST diagnostics | **450/450**, sans évaluer le script release/harness |
| Évaluation du YAML parsé | **16 000 combinaisons, zéro échec**, 50 branches |
| Détail matrice | 3 200 cas nouveau sélecteur ; 12 544 compatibilité antérieure ; 256 autres profils sur branche réservée |
| Inventaire source et plan pur | 194 + 44 noms actifs, deux exclus, 238 uniques ; pas un catalogue compilé |
| Parse Windows PowerShell 5.1 | Quatre scripts parsés, sans évaluation |
| Diff | `git diff --check` propre |
| Tests Rust | **194 écrits cumulés, zéro compilé/exécuté** ; 44 régressions existantes également non exécutées ici |

Les 16 000 cas utilisent les conditions du vrai YAML parsé et une comparaison avec la configuration `b39daac0` pour les anciens sélecteurs hors branche réservée. Valeurs zéro/non-zéro des smoke IDs, verify/release, plateformes et toutes les branches historiques sont combinées. Les définitions de jobs et defaults sont identiques. C'est un évaluateur local des opérateurs présents, pas un service CircleCI ou une validation hébergée.

La première exécution des nouveaux tests purs a signalé une concaténation PowerShell incorrecte des deux exclusions ; elle a été corrigée avant le passage final. Un contrat source intermédiaire a refusé le nombre de références pendant l'ajout des gardes globales ; la version finale conserve les contrôles historiques et passe.

L'essai du seul script de tests purs avec `powershell.exe -NoProfile -File` a été refusé par ExecutionPolicy. Aucun contournement ou nouvelle tentative équivalente. Le parse seul a ensuite réussi ; il ne prouve pas le comportement sous Windows PowerShell 5.1. Les 37 comportements ont été exécutés uniquement sous 7.6.5.

Deux revues indépendantes ont contrôlé l'inventaire/helper et le raccord CI ; la seconde relecture CI confirme la fermeture du défaut historique. Revues statiques seulement. Les 251 tests UI A16 et 2 242 tests serveur A15 restent historiques, non relancés : aucun runtime ne change dans ce lot.

## Limites et suite obligatoire

L'accès à CircleCI reste arrêté à la vérification GitHub 2FA signalée au lot A16 ; aucune nouvelle session, vérification de crédits ou demande de secret n'a été faite. Aucun push ou job lancé. Windows App Control 4551 n'est ni retenté ni contourné ; aucun Cargo, build script ou binaire/app natifs n'est exécuté.

Après rétablissement d'un hôte autorisé et vérification de sa capacité gratuite disponible, il faudra valider la configuration avec CircleCI, transmettre le HEAD exact, lancer explicitement ce profil puis examiner compilation, catalogue et journaux réels. Une réussite attendue de 194 + 44 ne prouvera toujours pas l'interopérabilité complète Rust vers TypeScript : le hook existant exporte facultativement un préfixe de ZIP plafonné à 8 Mio, sans garantie ni empreinte du ZIP entier. Un véritable export fictif complet et le staging coordonné restent nécessaires.

Les endpoints/IPC, caller Support, scheduler, ouverture réelle du devis, notifications et opt-in restent désactivés jusqu'à ces preuves. L'objectif global n'est pas atteint et aucune mise à jour Action Engine n'est publiée. Retirer ce profil/revenir au commit parent ne nécessite aucune restauration de données ; ne pas toucher aux reçus, outboxes ou historiques métier.
