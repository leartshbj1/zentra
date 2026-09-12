# Windows 1.56.0

## Contenu

- Éditeur visuel commun aux devis, factures, bilans et fiches de salaire : modèles, polices standard, tailles, couleurs, marges, espacements, emplacement du logo, tableaux et totaux.
- Textes d’introduction, de conclusion et de pied de page avec gras, italique, soulignement, alignement, listes et annulation. Les documents déjà émis conservent leur présentation enregistrée.
- Montants plus faciles à saisir avec une virgule ou un point ; lignes offertes à zéro conservées ; correction guidée vers le champ concerné.
- Corrections de paie plus explicites, reprise des brouillons, récupération d’un PDF déjà créé lorsque son partage échoue.
- Meilleure reprise des achats, imports de catalogue, contacts et pièces des projets ; chargement différé des écrans secondaires.

## Périmètre

Version Windows x64 uniquement, base SQLite inchangée en version 59 et identifiant `ch.helvichantier.desktop` conservé. Les polices personnalisées importées et l’import Word ne sont pas inclus ; le formulaire officiel du certificat annuel de salaire reste inchangé.

La signature Tauri/Ed25519 authentifie la mise à jour ; aucun certificat Authenticode n’est disponible. Windows peut afficher « Éditeur inconnu ».

## Livraison

Publié le 12 septembre 2026 sur GitHub, dans le stockage Supabase existant et sur la page de téléchargement.

- Source compilée : `f7e79ce2871f2b201d5ea99b9c9443816fc0af99` ; modifications natives identiques à la révision de préparation `06150c506880871051abecbf8d143743af3b23fe`.
- Installateur : `Zentra_1.56.0_x64-setup.exe`, 22 856 490 octets.
- SHA-256 installateur : `5977F52CF5D9EA78AD019E079663C7ED61590C8BD0F91ED0163D97E0E809A49F`.
- SHA-256 programme : `9C1B0939FAC83EB01E0FB7B8E428A57CD097BD518180B1E4643F3CB417130B09`.
- Signature Ed25519 contrôlée sur les octets publics Supabase ; la même clé valide également le lot 1.55.0. Le téléchargement GitHub et ses quatre empreintes d’artefacts correspondent au lot préparé.
- `latest-windows.json` annonce 1.56.0, avec `Cache-Control: public, max-age=60`. Son SHA-256 est `2B68034F0C83744235DAC7DC383FEA3ABD85728CFEBDED6BE6EF62996AFB412F`. Une lecture sans paramètre anti-cache a confirmé les nouveaux octets après l’expiration du cache précédent.
- Ancien manifeste conservé publiquement sous `latest-windows-before-1.56.json` ; nouveau manifeste versionné sous `latest-windows-1.56.0.json`. Le canal partagé `latest.json` reste identique octet pour octet.
- GitHub : https://github.com/leartshbj1/zentra/releases/tag/v1.56.0 (préversion Windows, publiée à 13:28:34 UTC).
- Site : version 122, source `517217ae830dd47c3fccdd9716994b93ed44c7f7`, déploiement `appgdep_6aa55475af788191a0ab83bb7e7fda8c` réussi. URL retournée : https://elyko.alb-leart1.chatgpt.site ; accès public conservé et révision d’environnement 23 inchangée.

## Validation et limites

654 tests natifs réussis, 0 échec, 2 recettes réseau optionnelles ignorées. Les 1 043 tests d’interface de la base ont été validés avant préparation de version ; 8 contrôles du mécanisme de mise à jour ont été rejoués. TypeScript et compilation Vite réussis. Le site a passé ses 4 contrôles de téléchargement et sa compilation de production.

Le programme Windows exact a démarré puis redémarré avec un profil neuf isolé : schéma 59, intégrité SQLite, clés étrangères et identité protégée stables. Les deux processus de test ont été fermés après contrôle de leur PID, heure de démarrage et chemin normalisé. Le contrôle initial fondé sur le handle retourné par PowerShell était trompeur ; le processus était toujours vivant. La recette corrigée interroge le processus réel.

Cette recette ne lance pas l’installateur NSIS et ne prouve pas une mise à niveau d’un profil client existant. L’exécution Windows isolée sur GitHub reste indisponible : le compte est bloqué pour un problème de facturation. Aucun nouvel artefact Apple ou Android n’a été publié.

Preuves locales : `.qa/windows-156-native-tests.log`, `.qa/windows-156-build.log`, `.qa/windows-156-stage.log`, `.qa/zentra-installer-packaged-156-final/report.json`, `.qa/public156/`. Le lot final se trouve dans `.qa/windows-release/Zentra-1.56.0-windows-x64/`.

La compilation a réutilisé les dépendances déjà testées avec `pnpm_config_verify_deps_before_run=warn`, pour éviter une réinstallation destructive du répertoire partagé. Le lanceur Windows du build Sites a échoué avant compilation ; la commande `pnpm run build` existante a réussi. L’archive a été validée par le script Sites `package-site.sh` avec Bash et des chemins MSYS, puis enregistrée et déployée par les outils Sites.
