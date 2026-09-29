# Zentra 1.90.9 — préparation, non publiée

29 septembre 2026. La version publique reste **1.90.8**. La source 1.90.9 est figée dans **`01ad1279b934113006398504163f309948d92e07`**, poussée sans forçage puis vérifiée sur `codex/first-client-release-1909`.

## Changement

Le chargement et l'actualisation de l'espace ne transmettent plus les deux collections intégrales du journal comptable que l'interface générale n'utilise pas. Comptabilité garde ses lectures dédiées, les montants et contrôles financiers restent présents, les exports et sauvegardes gardent toutes les écritures. Modification `7072af9c06b06bec8e925eb98f2d6eed52d51bbc` ; [protocole et mesures](VOLUMES-OPTIMISES-20260929.md).

Sur la fixture de 5 001 factures et 5 001 devis, trois paires de lectures alternées sur un même binaire optimisé montrent 49 718 748 → 40 778 676 octets, tous les autres champs égaux. Ce gain de 17,98 % concerne le payload local. Il ne mesure ni le trafic réseau, ni le démarrage complet, ni 150 entreprises simultanées.

## Préparation vérifiée

- Trois régressions Rust optimisées réussies : identité hors deux collections, consultation du journal, configuration dans ses deux modes, exports JSON/CSV et journaux intégraux extraits des sauvegardes et archives de collaboration. Après profilage, les 110 tables métier et trois fichiers ont les mêmes empreintes.
- Quatre numéros de version cohérents ; seule la version du package applicatif change dans Cargo.lock, aucune dépendance modifiée.
- Notes FR/DE/IT/EN datées du 29 septembre ; 14 tests des notes/langues et updater réussis, TypeScript réussi.
- Syntaxe PowerShell/Bash vérifiée. Configuration CircleCI parsée et 32 combinaisons de déclenchement évaluées : pas de double lancement pour la nouvelle branche ni une branche ordinaire. Le workflow dédié construit Windows, Apple et Android optimisé ; les trois régressions de projection sont exigées avant packaging Windows et Mac.

## Compilation à suivre

Pipeline **268** `d33f3274-102c-463e-95d6-db225c6f08ff`, créé à 01:28:25 UTC. Workflow **`5aae3f0d-23c2-4bd0-a6df-eaeefa1d421a`** `first-client-1909`, observé actif. Les trois jobs portent la source commune figée :

| Plateforme | Job | Dernière observation initiale |
|---|---|---|
| Windows | [181](https://circleci.com/gh/leartshbj1/zentra/181) | En file d'attente, aucun échec signalé |
| macOS et iPhone | [179](https://circleci.com/gh/leartshbj1/zentra/179) | En cours, préparation des outils |
| Android | [180](https://circleci.com/gh/leartshbj1/zentra/180) | En cours, construction du paquet physique |

Ces observations ne prouvent pas la réussite. Reprendre ces handles précis, sans redémarrer un job seulement parce que l'observation expire ou qu'il attend une ressource.

### Progression du 29 septembre à 01:48 UTC

Android **180 a réussi à 01:45:44 UTC**. Ses six fichiers ont été téléchargés dans un dossier neuf, avec contrôle de source et d'empreintes. L'APK non signé mesure 39 768 539 octets ; SHA-256 `286eda7a9890bf24593ec737232b6a164240a059a04f4d51b00d1ab7e5aa89e3`. Cette construction ne prouve pas encore son exécution ou sa signature.

La recette **182** teste ce contenu exact. Pipeline **269** `14d69621-96f1-41ef-b2a2-b1ec69c46b46`, workflow **`5c003a82-76c6-4a60-b026-c96351b39ce3`**, vérificateur **`ba04fbb12a9bf6c174e1f8830090ac0674798c15`**, observés en cours à 01:48 UTC. Le commit du vérificateur ajoute seulement les définitions CI Windows/Android ; le nouveau YAML et 32 combinaisons de déclenchement ont été contrôlés. La recette Windows est préparée pour le paquet **181**, mais n'est pas encore lancée.

À la dernière observation commune de 01:44:39 UTC, Apple **179** construit le Mac universel et Windows **181** compile toujours. Aucune de ces deux constructions n'est déclarée réussie à ce stade. Sources, état et téléchargements sont consignés dans `outputs/release1909/` ; le site public demeure en 1.90.8.

### Vérifications à 01:58 UTC

Apple **179 a réussi à 01:52:42 UTC**. Les 107 fichiers téléchargés portent la source attendue. Les trois régressions de projection, la recette de lancement de l'archive Mac exacte, ses architectures ARM64/x86_64, l'IPA ARM64 et ses icônes sont vérifiés. L'archive updater Mac a été signée et sa signature contrôlée ; cela ne remplace pas une notarisation Apple. L'IPA reste non signée.

- Archive Mac : 53 603 044 octets, SHA-256 `1a37fe0596d5a4424b32540d6968dab1ab339041c45ee84cd6ea511229fee7bb`.
- DMG : 54 778 706 octets, SHA-256 `f6a3b506ede9894c324af1b3eed4d37cc27f85f8d3233f983d05d159c7108b04`.

La recette Android **182 a échoué à 01:54:50 UTC** : après l'action tactile sur « Commencer », l'écran attendu du compte n'est pas apparu dans le délai. La capture montre la barre Android de sélection de texte au-dessus du bouton, avec l'accueil encore visible. Les journaux enregistrent aussi une ANR de Google Play Services ; cette présence ne prouve pas à elle seule la cause du geste. L'échec reste conservé sous `outputs/release1909/android-smoke-failed-182/`. Aucune réussite Android, signature Android ni publication globale n'est déduite de la seule compilation. La cause doit être déterminée avant une nouvelle recette.

Windows **181 est confirmé encore en cours à 01:58:29 UTC**. Aucun relancement de cette compilation n'est demandé.

## Avant publication

### Windows et nouvelle recette Android, 29 septembre à 02:21 UTC

Windows **181 a réussi à 02:14:34 UTC**. Les quatre fichiers téléchargés et leurs empreintes sont vérifiés : installateur 24 530 748 octets, SHA-256 `aa6624528acfdc0b5ec69460972a88d39e92d122ca9c370b9bead04f75a69447`. La recette **184** a réussi l'installation, le démarrage, le relancement et l'intégrité SQLite dans un espace jetable. La source du vérificateur est `027f4272a7177487adcc8539d8e7dc92ec9b31c5`, distincte de la source du paquet `01ad1279…`. La signature updater est créée et vérifiée, sans Authenticode ni installation sur le PC utilisateur. Preuves locales `windows/`, `smoke-windows/` et `windows-brand-proof.json`.

La recette Android **183**, issue du même vérificateur, a atteint le compte, les thèmes et la saisie, puis échoué à 02:17:05 UTC sur la comparaison des dimensions après fermeture du clavier. Le diagnostic exact identifie un défaut du vérificateur : il sélectionnait le dernier WebView de l'arbre d'accessibilité, qui représente le document enfant. Le viewport natif extérieur est `[0,24][320,616]` avant et après fermeture ; seul le document enfant passe de y=24 à y=25. Les captures `06-identity-keyboard-closed` et `after-recipe` montrent le clavier fermé et la saisie conservée. Les 36 artefacts utiles restent sous `android-smoke-failed-183/` ; l'échec n'est pas requalifié en recette réussie.

Le sélecteur corrigé exige l'unique WebView sans ancêtre WebView. Deux contre-épreuves échouent avant correction puis les neuf tests passent : aucun pixel de tolérance ou délai supplémentaire, ambiguïté désormais refusée et vraie réduction native toujours détectée. Le rejeu hors ligne des trois XML exacts est conservé dans `android-viewport-replay-183.json`. Une revue indépendante confirme le mauvais objet mesuré. Une nouvelle recette complète reste nécessaire.

Le test de volume Windows est séparé du smoke : pipeline **272** `b91d2374-d9de-4e9d-b03e-0693557f66ad`, workflow `930a0e53-bdeb-40cc-9759-b094d4d955a4`, job **185**, vérificateur `cdfbcb7ed91f5482fc480d368279bfc04a5db1a9`. Sa dernière observation est en file d'attente, pas une mesure réalisée. Le [protocole](RECETTE-WINDOWS-VOLUME-1.90.9.md) exige les données fictives, l'absence de licence ajoutée et les invariants métier. Les deux défauts de confinement/prérequis ont été corrigés, huit tests ciblés et une revue indépendante les valident ; les 23 contrôles du collecteur et trois tests du générateur restent ceux de la préparation. Le YAML et 64 combinaisons de déclenchement sont vérifiés. Aucun résultat partiel ne devient un succès de performance.

### Diagnostics suivants — distribution toujours retenue

La recette Android **186** (vérificateur `6006100dee8bf4b9d5cfd4f45a89e8aa04d3796a`) échoue à **02:24:26 UTC**, avant téléchargement ou installation du paquet : la commande `adb root` perd son transport. Les journaux restent sous `android-smoke-failed-186/`. Le prérequis vérifie maintenant l'état résultant même si cette commande retourne un code non nul : un seul `root`, l'attente de connexion existante, puis `qemu=1` et `uid=0` obligatoires. Timeouts et autres erreurs restent bloquants. Le code de sortie réel est conservé dans la preuve. Aucun délai d'écran, assertion applicative ou geste n'est modifié. Quatorze tests ciblés passent et une revue indépendante valide les gardes. Une exécution complète demeure nécessaire.

Complément factuel sur 183 : l'enfant WebView était déjà décalé à y=25 dans `identity-scroll-1.xml`, avant ouverture du clavier ; le journal `onHidden` précède le dump 06. Ce cas ne justifiait donc pas d'allonger l'attente de fermeture.

Windows volume **185 a échoué à 02:21:49 UTC**, remplaçant l'observation de file d'attente ci-dessus. Node 22.23.3 et l'installateur exact sont validés, mais l'initialisation du profil attendu n'est pas observée dans les 60 secondes. `outputs/release1909/windows-volume-185/result.json` indique `measured=false`, `ipcMeasured=false`, `uiMeasured=false`. La cause n'est pas encore établie ; Job Object, profil WebView et proxy diffèrent du smoke réussi 184. Aucun paquet utilisateur ni seuil de validation n'est changé sur la seule base de ces hypothèses. L'observabilité doit être complétée avant un nouvel essai de volume.

Le dispositif conserve maintenant la dernière erreur SQLite, le schéma/intégrité/contrôle des clés réellement observés, au plus 64 métadonnées de fichiers du seul profil fictif et les noms/PID des descendants du processus de test. Pas de titres de fenêtre, arguments, environnement ou profils externes. La collecte après échec est bornée à deux secondes dans le budget global ; le délai d'initialisation, le Job Object, le proxy et le profil WebView sont inchangés. Sur 17 tests ciblés, 16 passent et un test de lien symbolique réel est explicitement sauté faute de privilège Windows ; un contre-test de métadonnées vérifie séparément le refus de traversée. Les générations de volume et contrôles CDP inchangés ne sont pas répétés. Ceci corrige un manque de diagnostic, sans établir la cause ni mesurer la performance.

### Diagnostic complémentaire Android 182

L'inspection du journal trouve une pression CPU de 91,59 %, une CPU totale à 100 % et une ANR Google Play Services. Le bouton accessible et les coordonnées du geste sont corrects. L'hypothèse d'un geste perturbé par la fixture saturée reste une hypothèse : aucun événement DOWN/UP n'a été enregistré et l'absence de régression applicative n'est pas prouvée. L'échec 182 demeure conservé.

La recette suivante conserve l'APK 180, sa source et son empreinte, le tap ADB unique, le parcours et tous les délais/assertions. Seul le job Android 1909 passe de `medium` à `large`. Le tap enregistre uniquement sa cible et sa durée en mémoire : aucun autre appel ADB ni écriture n'est ajouté avant le constat d'écran. Les captures déjà produites par l'attente restent les références. L'état de la fixture et les buffers runtime/crash sont collectés après la fin de la recette, même en cas d'échec, et leurs erreurs ne masquent pas l'erreur initiale. Ces observations tardives ne mesurent pas la pression exacte au moment du geste.

Six contre-épreuves hors ligne passent, dont le geste unique sans attente diagnostique, le défaut de commande sans nouvelle tentative, le contrôle inaccessible et l'écriture de diagnostic refusée sans masquage de l'échec initial. YAML valide ; isolation de la ressource 1909 vérifiée. Une revue indépendante a demandé de supprimer les collectes synchrones autour du geste ; le diff final résout les deux points relevés. Ceci valide le dispositif, pas l'application Android : une nouvelle exécution complète reste requise.

Récupérer et vérifier les nouveaux paquets exacts et leurs sources ; tester l'installation/relancement Windows, l'archive Mac exacte et le contenu Android sur émulateur ; vérifier IPA/architectures/marque ; signer avec les identités existantes et contrôler les signatures. Les nouvelles recettes et leurs empreintes doivent être renseignées dans le plan 1909, jamais remplacées par celles de 1908. Publier un tag distinct, puis seulement mettre à jour les téléchargements et canaux du site à partir de sa source courante.

Les outils sont sous `outputs/release1909/`. Un plan ou script n'est pas une preuve d'exécution. Aucun téléchargement public ni manifeste du site n'est passé à 1.90.9 à ce stade.

## Limites

L'authentification renvoie encore 503 lors du dernier contrôle du 29 septembre à 01:09:30 UTC. Les recettes connectées à deux appareils, le planificateur réel et la capacité de production restent ouverts. Cette version ne lève pas une restriction d'hébergement.

Le PC utilisateur n'est pas réinstallé. Windows reste sans Authenticode reconnu, Mac ad hoc et non notarié, iPhone nécessite une signature pour l'installation, Android garde l'identité de préversion. Aucune certification de store, appareil physique ou conformité globale n'est déduite d'une compilation.
