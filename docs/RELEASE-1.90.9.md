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

Récupérer et vérifier les nouveaux paquets exacts et leurs sources ; tester l'installation/relancement Windows, l'archive Mac exacte et le contenu Android sur émulateur ; vérifier IPA/architectures/marque ; signer avec les identités existantes et contrôler les signatures. Les nouvelles recettes et leurs empreintes doivent être renseignées dans le plan 1909, jamais remplacées par celles de 1908. Publier un tag distinct, puis seulement mettre à jour les téléchargements et canaux du site à partir de sa source courante.

Les outils sont sous `outputs/release1909/`. Un plan ou script n'est pas une preuve d'exécution. Aucun téléchargement public ni manifeste du site n'est passé à 1.90.9 à ce stade.

## Limites

L'authentification renvoie encore 503 lors du dernier contrôle du 29 septembre à 01:09:30 UTC. Les recettes connectées à deux appareils, le planificateur réel et la capacité de production restent ouverts. Cette version ne lève pas une restriction d'hébergement.

Le PC utilisateur n'est pas réinstallé. Windows reste sans Authenticode reconnu, Mac ad hoc et non notarié, iPhone nécessite une signature pour l'installation, Android garde l'identité de préversion. Aucune certification de store, appareil physique ou conformité globale n'est déduite d'une compilation.
