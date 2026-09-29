# Mesure locale du paquet Windows 1.90.9

Protocole préparé le 29 septembre 2026. Ce lot contient uniquement des scripts de recette. Il ne lance pas CircleCI, ne reconstruit pas l’application et ne conditionne pas la publication initiale. **Aucune mesure du paquet 1.90.9 n’est encore produite par ce protocole.**

## Paquet et isolation

La cible est le **job Windows 181**, source `01ad1279b934113006398504163f309948d92e07`, version `1.90.9`, schéma `60`. Le job 179 est Apple. Les correctifs postérieurs, dont celui du dialogue Modal, ne font pas partie de ce paquet et ne peuvent pas être crédités par ses mesures.

Exécuter uniquement dans un runner Windows jetable sans autre instance Zentra. Le garde d’instance unique utilise l’identifiant de l’application, pas le chemin de la base : un second lancement sur un poste utilisateur pourrait focaliser son application réelle. Le lanceur refuse donc toute instance Zentra existante. NSIS peut écrire des raccourcis et des métadonnées dans le profil Windows du runner ; ce n’est pas une installation à essayer dans le compte utilisateur habituel.

`desktop/scripts/windows-package-volume.py` réutilise le téléchargement HTTPS contrôlé de `cloud-package-smoke.py`, qui reste inchangé. Il exige le succès du job et la révision exacte, la provenance 1.90.9, les preuves de tests, les tailles et SHA256 de l’installateur et du binaire. Après installation, il applique uniquement en mémoire la transformation documentée du marqueur NSIS à la copie du binaire brut et compare chaque octet par SHA256 avec l’exécutable installé. Le binaire exécuté est celui de l’installateur. Aucun binaire n’est modifié.

Le profil et le stockage WebView sont nouveaux, sous `%TEMP%/zentra-volume-1909-…`. `HELVICHANTIER_DATA_DIR` et `WEBVIEW2_USER_DATA_FOLDER` les isolent. Le paquet crée d’abord lui-même la base vide au schéma attendu, puis son processus et ses descendants sont arrêtés avant le peuplement. Aucun profil existant ni fichier SQLite préfabriqué n’est copié. La base générée reste hors du répertoire des preuves et ne doit pas être publiée comme artefact CI.

Si l’initialisation échoue, `result.json.initialization` et `initialization.json` conservent le nombre d’essais, le temps écoulé, la version SQLite, le dernier schéma/intégrité/contrôle de clés étrangères observé et la dernière erreur SQLite avec son code. Les contrôles ne sont plus masqués par une erreur générique. L’attente reste de 60 secondes maximum, avec un timeout SQLite de 0,2 seconde et une cadence de 0,2 seconde ; aucun critère n’est assoupli.

Avant l’arrêt, une collecte complémentaire dispose d’au plus deux secondes dans le budget global existant. Elle relève uniquement l’état du PID lancé, ses descendants observés (PID, parent, nom du binaire et nombre de `msedgewebview2.exe`) et au plus 64 métadonnées de fichiers sur trois niveaux du profil fictif. Elle ne lit ni contenu, ni profil extérieur, ni titre de fenêtre, ni ligne de commande ; les liens et points de réanalyse ne sont pas suivis. Une collecte indisponible ou tronquée est indiquée, sans remplacer l’erreur initiale. Le cliché des processus n’est pas un historique : l’absence de WebView2 dans ce cliché ne prouve pas la raison de son absence ou de son arrêt.

Le job volume 185 a échoué avant peuplement après validation de Node 22.23.3 et de l’installation exacte. Son ancien résultat ne permet pas d’identifier la cause. Le smoke 184 a réussi avec le même SHA256 installé `cfb7565a480034507523b568cf3ae51a3659b019dff49f3450062137ca1e55ad` et le schéma 60. Les différences restent à distinguer : attente SQLite 0,2 seconde contre cinq secondes implicites dans le smoke, Job Object, stockage WebView distinct et paramètres CDP/proxy. Aucune de ces différences n’est une cause démontrée ; le confinement, les délais et l’environnement restent inchangés.

Le job volume 188 conserve davantage de preuves : après 60 001 ms, la base est absente, le profil fictif est vide, Zentra est vivant et le cliché complet montre un seul descendant `msedgewebview2.exe`. Aucun appel `get_workspace`, peuplement ou chronométrage IPC/UI n’a donc été obtenu. Ce démarrage incomplet ne démontre ni une régression de la projection `get_workspace` de 1.90.9 ni une cause liée au Job Object. Le smoke 184 et la mesure volumétrique restent deux preuves distinctes.

## Expérience de confinement après le job 188

Le mode par défaut reste `--job-layout strict`. L’option explicite `--job-layout nested-breakaway` ajoute un Job interne autorisant seulement une demande `CREATE_BREAKAWAY_FROM_JOB`. Le Job externe conserve exclusivement `KILL_ON_JOB_CLOSE` (`0x2000`), sans aucune autorisation de breakaway. Le Job interne utilise `BREAKAWAY_OK` (`0x0800`), jamais `SILENT_BREAKAWAY_OK`. Les deux rattachements et leur appartenance sont vérifiés avant de libérer la barrière. `containment.json` conserve le mode, les flags et l’appartenance du worker ; un échec de création/rattachement arrête le worker encore bloqué.

Selon les règles Microsoft, une demande de sortie de Jobs imbriqués s’arrête au premier parent qui la refuse : un enfant peut ainsi quitter l’interne tout en restant sous le contrôle de l’externe. Les tests locaux vérifient cette propriété avec de vrais processus Python, puis leur terminaison à la fermeture du Job externe. Cette expérience teste une permission du Job immédiat ; elle ne retire aucun confinement extérieur et ne désactive aucun sandbox. [Jobs imbriqués Microsoft](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), [flags des limites de Job](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information).

L’hypothèse n’est pas tenue pour acquise : Chromium utilise lui-même `KILL_ON_JOB_CLOSE` et sait rattacher ses processus sandbox à un Job. Ce code public courant ne prouve pas le comportement exact du Runtime Edge installé dans le runner. [Job Chromium](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/win/src/job.cc), [création des processus sandbox](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/win/src/broker_services.cc).

Avant tout téléchargement de paquet, les deux modes relèvent le jeton effectif : booléen d’élévation et niveau d’intégrité uniquement, sans SID, nom d’utilisateur ni jeton exporté. La recette exige un hôte vérifié non élevé, d’intégrité moyenne. Un hôte élevé, bas ou non vérifiable produit `not_measured`, code 2, sans installation. Microsoft documente que les overrides `WEBVIEW2_*` sont ignorés lorsque l’hôte est élevé ; continuer ne garantirait donc pas le port CDP et le stockage WebView privé demandés. [Niveau de privilège et overrides WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).

Le job 189 a été arrêté par ce garde avant tout paquet : son worker est élevé, d’intégrité haute (`elevated: true`, RID `12288`). Les deux Jobs ont été vérifiés (`outer: 8192`, `inner: 2048`, worker membre des deux). Ce résultat justifie l’expérience de jeton ci-dessous ; il ne prouve pas la cause du démarrage incomplet du job 188.

## Worker à droits restreints dans la VM CI

Le défaut reste `--worker-token inherit`. L’option explicite `--worker-token restricted-medium` est admise uniquement avec `CIRCLECI=true` et `--disposable-runner`. `windows-volume-token.py` crée une copie restreinte du jeton primaire du même utilisateur avec `LUA_TOKEN | DISABLE_MAX_PRIVILEGE` (`0x5`), rend le groupe Administrateurs utilisable seulement pour refuser des accès et abaisse l’intégrité de cette copie à medium (`8192`). Le jeton du superviseur reste inchangé. Aucun compte, mot de passe, profil utilisateur, privilège machine, ACL ou registre n’est créé ou modifié ; `SANDBOX_INERT` n’est jamais demandé. [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken).

`CreateProcessAsUserW` reçoit un exécutable absolu, une ligne de commande bornée et une liste explicite de trois handles héritables : barrière, entrée nulle et journal. Le worker est créé **suspendu**. Avant la première instruction du worker, le superviseur vérifie le jeton préparé puis son jeton effectif : même utilisateur et session, jeton primaire restreint, non élevé, intégrité exactement medium, Administrateurs absent ou deny-only. Il rattache ensuite le processus aux Jobs, vérifie leurs appartenances, reprend son thread et libère enfin la barrière anonyme. Le worker refait lui-même le contrôle d’élévation/intégrité et vérifie l’écriture dans ses seuls dossiers neufs avant téléchargement. Le profil privé, le proxy fermé, les délais et les critères de mesure restent identiques.

Le cas documenté d’une version restreinte du propre jeton évite l’exigence `SE_ASSIGNPRIMARYTOKEN_NAME`, mais les droits effectivement disponibles peuvent encore empêcher `CreateProcessAsUserW` (notamment erreur `1314`). Tout refus arrête la recette : aucune relance avec le jeton élevé, aucune autre méthode de connexion et aucun assouplissement du garde. [CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw).

`containment.json.workerToken` conserve les seuls attributs de contrôle des jetons source/préparé/effectif, ainsi que les booléens `sameUser`, `sameSession` et `restricted`. Aucun SID ni jeton brut n’est publié. Si le lancement ou le rattachement échoue, `result.json.launchFailure` conserve l’erreur native et la preuve disponible. Un worker sans résultat produit explicitement `not_measured`. Le SHA256 du nouveau helper est aussi inclus dans `verifierHashes` lorsque ce mode est choisi.

Pour le prochain essai CI, transmettre **les deux options** `--job-layout nested-breakaway --worker-token restricted-medium`. Le wrapper PowerShell et le workflow doivent transmettre explicitement cette dernière option ; `JobLayout` seul laisserait le jeton hérité. Il n’y a aucune seconde tentative automatique ni matrice de variantes. Même une initialisation réussie ne constitue pas une preuve de rendu tant que le collecteur n’a pas produit ses mesures réelles.

Les tests locaux utilisent de vrais processus Python, sans Zentra ni réseau. Le superviseur local mesuré est déjà non élevé/medium : ils prouvent la création restreinte, les vérifications réelles, la barrière, les Jobs et la terminaison des descendants, mais **pas encore la transition high → medium dans le runner CircleCI**. Le prochain job doit vérifier cette transition dans `workerToken`, puis seulement tenter la mesure réelle du paquet. La variante reste une recette, pas un changement de l’application publiée.

## Données déterministes

`windows-volume-fixture.py` refuse un chemin non canonique, un lien symbolique, un marqueur absent, une base non initialisée par le paquet, une entreprise déjà présente ou des fichiers de compte/licence. Il peuple la base arrêtée dans une transaction, avec identifiants et dates fixes :

- 500 clients, 100 projets, 5 000 devis et 5 000 factures ;
- 40 000 lignes de devis et 40 000 lignes de factures ;
- 3 333 paiements, 8 333 écritures et 16 666 lignes comptables équilibrées ;
- trois petites pièces texte explicitement fictives.

La société s’appelle `Atelier Volume 1909 - FICTIF`. Les écritures comptables sont un historique manuel fictif. Cette génération SQL **ne valide pas** les parcours d’émission, d’encaissement, la continuité comptable métier ou la conformité d’un dossier client. Les fonctions SQLite locales nécessaires aux gardes sont enregistrées sur la connexion de génération ; aucun trigger ni contrôle de contrainte n’est supprimé. Le générateur n’ajoute ni compte distant, ni licence, ni jeton, ni secret SMTP.

Après génération, les preuves consignent comptes et empreintes de toutes les tables, les trois pièces, l’intégrité, les clés étrangères et l’équilibre de chaque écriture. Après arrêt du paquet, toutes les tables métier et pièces doivent être identiques. Les tables locales de cache/horloge sont conservées séparément dans les deux preuves ; elles ne sont pas assimilées à des données métier. Toute modification métier fait échouer la recette.

## Mesures et limites

Le processus reçoit un port CDP lié à `127.0.0.1`, jamais une adresse réseau. Aucun service n’est créé. Les clients natifs reçoivent un proxy local fermé ; le WebView reçoit aussi un proxy fermé avec exceptions locales et le collecteur bloque les requêtes externes du renderer après attachement. Le profil n’a pas de session connectée. Ces réglages sont propres aux processus lancés, sans changement du pare-feu ou du système. Ce n’est pas une preuve d’isolement réseau de tous les composants Windows : utiliser un runner dont la politique réseau interdit les destinations de production si cette garantie supplémentaire est requise.

Le collecteur externe Node ≥22 `windows-volume-collector.mjs` cherche une seule cible `http://tauri.localhost/` pendant **15 secondes maximum**. Il vérifie `get_app_state.data_dir` et la version avant toute lecture métier, puis le nom de la société fictive et les comptes attendus avant capture. Il ne remplace aucun appel natif et ne simule aucun état de compte ou licence.

Avant tout téléchargement ou installation, le lanceur exécute le Node réellement sélectionné avec une sonde locale de **cinq secondes maximum**. Il exige un code de sortie nul, un objet JSON valide, une version ≥22 et la présence de `WebSocket`, `fetch` et `AbortSignal.timeout`. Un Node incompatible, une sonde échouée ou expirée arrêtent la recette avant l’accès aux artefacts ; `result.json` consigne la version et les capacités lorsque la sonde réussit.

Budget maximal de **dix minutes pour l’ensemble**, téléchargements et installation compris : 595 secondes d’exécution, puis cinq secondes réservées à l’arrêt. Le worker attend obligatoirement un événement Windows anonyme, initialement fermé. Le superviseur le libère seulement après création du Windows Job Object et rattachement réussi du worker. Avant cette libération, aucun descendant, aucune sonde Node et aucun téléchargement ne sont admis. Un handle absent, une attente échouée ou une attente expirée arrêtent le worker. Le handle de barrière est fermé avant de lancer ses descendants. La fermeture du Job termine les processus qu’il contient, même après un blocage ; le superviseur attend la fin du worker avant d’écrire son résultat définitif. Les étapes utilisent également des délais locaux. Le collecteur engage seulement :

1. Trois `get_workspace` réels et séquentiels. Le chronomètre couvre appel natif, verrou, requêtes, sérialisation/transfert IPC et réponse décodée dans le WebView. Comptage, sérialisation de contrôle et SHA256 se font ensuite, hors chronométrage. Les tableaux complets `journal_entries` et `journal_lines` doivent être absents, les autres données conservées.
2. Un rechargement instrumenté du renderer, sans nouveau build ni données simulées.
3. Quatre écrans : Accueil, Ventes, Clients et Comptabilité. L’attente porte sur du contenu spécifique, l’absence de chargement/erreur et deux frames, pas seulement sur un titre. Captures, débordement horizontal, erreurs et tâches longues sont relevés.

Le temps processus → contenu observé inclut l’attachement CDP, le contrôle d’appartenance et le délai d’observation ; il constitue une durée observée, pas un marqueur interne exact. Si le contenu n’était pas prêt au premier contrôle, il peut aussi inclure les trois lectures IPC ; `observedAfterMeasuredIpcReads` l’indique et interdit d’assimiler cette durée au seul démarrage. Le rechargement utilise un processus déjà ouvert et les caches existants. Aucune de ces mesures ne représente un démarrage à froid du système, du matériel modeste, du mobile ou 150 entreprises simultanées. Trois passages ne justifient pas un p95.

Une activation licence ou un autre dialogue peut empêcher l’accès au tableau de bord. **Aucun dialogue d’activation n’est contourné, aucune licence n’est ajoutée.** Si l’IPC reste accessible, ses trois mesures sont conservées et le rendu reste explicitement non mesuré avec sa cause. Si CDP n’est pas accessible, IPC et UI sont tous deux non mesurés. Le smoke ordinaire reste une preuve distincte de démarrage et d’intégrité SQLite, jamais une preuve UI.

## Exécution après revue

Le workflow dédié `windows-volume-1909` ne démarre que sur la branche explicite `codex/release-1.90.9-windows-volume`, hors compilation de release. Il utilise un runner Windows jetable et `run-windows-package-volume.ps1`. Ce wrapper refuse une exécution hors CI ou un dossier de résultats préexistant, prépare Node 22 dans un dossier temporaire neuf depuis le fournisseur avec SHA-256 vérifié, et conserve sa version/empreinte dans les artefacts. Il ne modifie pas le runtime global. La préparation de Node précède le budget de dix minutes de la mesure. Un résultat partiel conserve le code 2 et fait échouer ce workflow de mesure ; il ne devient pas une réussite du smoke de distribution, qui reste séparé.

Sur le runner jetable, depuis un checkout contenant ces scripts, avec Node ≥22 et Python 3.11+ :

```powershell
python desktop/scripts/windows-package-volume.py --job 181 --source 01ad1279b934113006398504163f309948d92e07 --schema 60 --output C:/volume-proof-1909 --disposable-runner
```

Le répertoire de sortie doit être absent. `--node C:/chemin/node.exe` permet de préciser le runtime. Dans le runner élevé observé au job 189, ajouter `--job-layout nested-breakaway --worker-token restricted-medium` après revue. Le script télécharge uniquement les artefacts CI nécessaires ; il ne déclenche aucun job.

Lire ensemble `result.json`, `containment.json`, `initialization.json`, puis, lorsqu’ils ont pu être produits, `measurements.json`, `fixture.json`, `before.json`, `after.json`, les journaux et les captures. Un refus du contexte d’exécution peut survenir avant `initialization.json` et avant tout paquet. Les fichiers de preuve ne contiennent pas les tableaux métier bruts. Le dossier SQLite temporaire est indiqué pour vérification locale, sans être inclus dans les artefacts à publier.

- Code 0 : mesures complètes **et** invariants conservés.
- Code 2 : résultat partiel/non mesuré, notamment CDP absent, accès UI bloqué ou délai global ; ne pas le convertir en succès de performance.
- Code 1 : échec de provenance, garde, intégrité ou recette ; aucune conclusion positive globale.

## Validation locale du dispositif

Sans démarrer Zentra ni contacter le réseau, les tests de génération peuvent copier **seulement le schéma** de la fixture connue fictive. Ils n’en copient aucune ligne, pièce, licence ou identité. Le marqueur `synthetic`, l’absence de compte ajouté et le nom `Atelier Recette 1905` sont exigés avant la lecture du schéma.

```powershell
$env:ZENTRA_VOLUME_TEST_SCHEMA = (Resolve-Path outputs/release1908/volume-release/profile).Path
python desktop/scripts/test-windows-volume-fixture.py -v
Remove-Item Env:ZENTRA_VOLUME_TEST_SCHEMA
node --check desktop/scripts/windows-volume-collector.mjs
node desktop/scripts/test-windows-volume-collector.mjs
```

Les régressions du superviseur et de Node peuvent aussi être exécutées seules, sans fixture SQLite :

```powershell
python desktop/scripts/test-windows-volume-fixture.py InitializationDiagnosticsTests WindowsBoundsTests WindowsNestedJobsTests HostTokenTests RestrictedWorkerTests NodePreflightTests -v
```

Validation réalisée lors de la préparation : deux générations complètes identiques, refus d’un profil non marqué ou peuplé, refus avant mutation après expiration du budget ; trois tests réussis. Les tests ciblés Windows vérifient, avec des processus Python jetables, l’absence de départ avant libération, la terminaison des descendants par le Job, les échecs d’attachement et de libération, les handles absents/invalides et l’expiration. Les tests Node vérifient le runtime local réel (24.19.0), ainsi que les refus de version/capacités, JSON invalide, sortie en erreur et expiration simulés, avant tout téléchargement. Les 23 contrôles du collecteur passent avec DOM/CDP simulés, y compris l’IPC conservé sous activation bloquante, le refus d’un mauvais profil/version avant lecture métier et l’absence de CDP. Ce résultat valide le dispositif local ; il ne constitue pas une mesure de l’installateur 1.90.9.

Les diagnostics d’initialisation sont testés sur SQLite jetable : base absente sans création, mauvais schéma, base corrompue, verrou exclusif, base valide et sortie précoce. Les tests couvrent aussi les plafonds de métadonnées, les erreurs de collecte/écriture sans masquage, et le filtrage d’un véritable descendant Python dans le cliché Windows. Le test de lien symbolique réel nécessite le privilège Windows correspondant et peut être explicitement sauté ; un test distinct de métadonnées de point de réanalyse vérifie le refus de traversée sans ce privilège.

Les sept tests `RestrictedWorkerTests` couvrent le jeton réel medium/non élevé avec même identité/session, le worker suspendu puis bloqué par la barrière, les layouts strict et imbriqué, l’appartenance et la terminaison réelles des descendants, l’exclusion d’un handle témoin de l’héritage, les refus d’identité ou d’autorité altérée, le refus d’attachement avant exécution et l’erreur `1314` sans fallback. Le test réel a aussi permis de prendre en charge la réponse native de un octet pour `TokenHasRestrictions`, sans relâcher les contrôles des autres attributs DWORD. Aucun paquet n’est exécuté par ces tests.

Dernière validation ciblée de ce lot : **31 tests exécutés, 30 réussis et un sauté** faute du privilège local de création de liens symboliques ; les sept tests du jeton restreint ont tous été exécutés. La génération de 5 000 documents et le collecteur inchangés n’ont pas été relancés pour ce lot.
