# Windows 1.57.0

## Contenu

- Couleur et surlignage du texte sélectionné dans les modèles de devis, factures, bilans et fiches de salaire. Ces réglages complètent les polices, tailles, marges, alignements, listes, logo et styles de tableaux de l’éditeur visuel.
- Corrections des collaborateurs guidées vers le champ concerné, avec des explications compréhensibles pour les dates et la prévoyance professionnelle. Les brouillons de salaire sont conservés pendant l’enregistrement.
- Depuis le dossier d’un devis, émission et règlement des factures d’acompte et de solde, avec les montants reçus, les crédits appliqués et le reste à payer.
- Les fichiers sélectionnés dans un projet et les envois en cours restent accessibles lorsque l’on change de page. Un accès « Retrouver les documents » permet de reprendre. Les erreurs conservent les fichiers concernés et la reprise ne renvoie pas les fichiers déjà enregistrés.

## Périmètre

Windows x64, identifiant `ch.helvichantier.desktop` conservé et schéma SQLite 59 inchangé. Les fichiers sélectionnés doivent être enregistrés avant de fermer l’application. L’éditeur propose les polices standard intégrées ; l’import Word, les polices externes et le déplacement libre des champs financiers ne sont pas inclus. Le formulaire officiel du certificat annuel de salaire reste inchangé.

La signature Tauri/Ed25519 authentifie les mises à jour. Aucun certificat Authenticode n’est disponible : Windows peut afficher « Éditeur inconnu ».

## Livraison

Publiée le 12 septembre 2026 sur GitHub, dans le stockage Supabase existant et sur la page de téléchargement. Aucune nouvelle version Apple ou Android n’est comprise dans cette livraison.

- Source compilée : `61194d7013f417b6d5edf96e63ab3714e3e23268`, sur une copie de travail propre.
- Installateur : `Zentra_1.57.0_x64-setup.exe`, 22 864 088 octets.
- SHA-256 installateur : `3D94FC7AA80DD71E79537B304B9DB38B4D1C53A836FF7E84BBCB86F11856C329`.
- SHA-256 programme : `CA8689A68CD4ABF88A1F9079587F2FA82CFE8B2C36138CF8480C300A6CF6C942`.
- Signature Tauri/Ed25519 vérifiée sur le lot et sur les octets publics Supabase. La même clé valide aussi l’installateur public 1.56.0. Le téléchargement public GitHub a été comparé au même SHA-256.
- Canal `latest-windows.json` : version 1.57.0, SHA-256 `99C9DCD72EA00330A0D3F56070F8E2B9D0AE1B31C019633ECB993E9AC3D9E211`, `Cache-Control: public, max-age=60`. Une lecture sans paramètre anti-cache a confirmé le nouveau fichier à 15:48:53 UTC après expiration des anciennes données en cache.
- Ancien canal conservé sous `latest-windows-before-1.57.json`, nouveau manifeste versionné sous `latest-windows-1.57.0.json`. Le canal partagé `latest.json` est inchangé octet pour octet.
- GitHub : https://github.com/leartshbj1/zentra/releases/tag/v1.57.0 ; préversion publiée à 15:46:51 UTC.
- Site : version 123, source `770c730a1b56470ec2dc28d040e13d1c02c1b1c7`, déploiement `appgdep_6aa57400803481918a91a00218e91cee` réussi. URL retournée : https://elyko.alb-leart1.chatgpt.site ; accès public conservé, environnement en révision 23 inchangé.

## Validation et limites

Les 1 070 tests d’interface et 655 tests natifs passent sans échec ; 2 recettes réseau optionnelles sont ignorées. TypeScript et compilation de production réussis. Le site passe ses 4 contrôles de téléchargement et sa compilation de production.

Le programme Windows exact a démarré puis redémarré dans un profil neuf isolé : schéma 59, intégrité SQLite, clés étrangères et identité protégée stables. Les deux processus de test ont été fermés après contrôle de leur PID, chemin et heure de démarrage.

Cette vérification ne lance pas l’installateur NSIS et ne prouve pas la mise à niveau d’un profil client existant. La nouvelle tentative d’installation isolée sur GitHub, exécution `34703158764`, n’a pas démarré : le compte est bloqué par un problème de facturation. Les deux modes, installation neuve et mise à niveau depuis 1.45.0, sont donc non vérifiés par cette recette.

Le build a réutilisé les dépendances déjà testées avec `pnpm_config_verify_deps_before_run=warn` pour préserver leur dossier partagé. Le lanceur de build Sites a échoué avant compilation ; la commande `pnpm run build` existante a réussi. Le script Sites `package-site.sh` a validé l’archive avec Git Bash et des chemins MSYS avant son enregistrement et son déploiement.

Preuves locales : `.qa/windows-157-ui.log`, `.qa/windows-157-native-tests.log`, `.qa/windows-157-build.log`, `.qa/windows-157-stage.log`, `.qa/zentra-installer-packaged-157/report.json` et `.qa/public157/`. Lot final : `.qa/windows-release/Zentra-1.57.0-windows-x64/`.
