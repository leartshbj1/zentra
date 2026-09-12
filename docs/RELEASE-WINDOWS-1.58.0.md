# Windows 1.58.0

## Contenu

- Choix de police et de taille pour les mots sélectionnés dans les introductions, conditions et pieds de page des modèles de factures, devis, bilans et fiches de salaire. La mise en forme est conservée dans les PDF et les documents longs se répartissent en pages selon la taille réelle des caractères.
- Saisie des heures avec deux champs, heures et minutes, coût proposé depuis le collaborateur, distinction claire entre coût et prix client, résumé et erreurs placées à l’écran. Les saisies et le chronomètre empêchent les doubles enregistrements et gardent les informations en cas d’erreur.
- Facturation des heures : les choix restent mémorisés pour chaque projet et après actualisation. Les heures nouvellement disponibles ne sont pas cochées automatiquement. Une facture créée dont la relecture a échoué se récupère sans recommencer l’écriture.

## Périmètre

Windows x64, identifiant `ch.helvichantier.desktop` et schéma SQLite 59 conservés. Les présentations déjà figées restent inchangées. Les nouvelles options de texte complètent l’atelier existant ; le certificat annuel officiel garde son formulaire réglementaire. Aucun nouvel installateur macOS, iOS ou Android n’est compris dans cette livraison Windows.

La signature Tauri/Ed25519 authentifie le lot de mise à jour. Aucun certificat Authenticode n’est disponible : Windows peut afficher « Éditeur inconnu ».

## Validation

Les 1 085 tests d’interface passent. Les tests natifs ciblés des documents (21) et du temps (10) passent ; ils vérifient notamment les totaux, la présentation des documents déjà émis, l’atomicité et l’idempotence de la facturation des heures. Les huit parcours de saisie et facturation passent également dans le projet principal sur Edge et WebKit, en petit mobile, mobile, paysage et ordinateur. Les parcours de typographie et d’édition de texte passent aux largeurs 320, 390 et 1 440 pixels ; les PDF natifs ont été rendus et contrôlés.

## Livraison

Préversion Windows publiée le 12 septembre 2026 sur [GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.58.0). Le canal public `latest-windows.json` annonce la version 1.58.0 ; sa lecture ordinaire, sans contournement du cache, a été vérifiée à 17:02 UTC. Le canal partagé des autres plateformes est resté inchangé. Depuis Windows 1.50, le bouton **Mise à jour** utilise ce canal ; les versions plus anciennes disposent de l’installateur manuel.

La [page de téléchargement](https://elyko.alb-leart1.chatgpt.site/download) est publiée avec la version 1.58.0. Le déploiement du site a terminé avec succès à 17:02 UTC.

- Source native : `4a9204889c2d007625a2e48693924577a7f2cc8a`.
- Installateur : `Zentra_1.58.0_x64-setup.exe`, 22 842 019 octets.
- SHA-256 : `B4769FDB03D6C0DAF72D1A412C667E0D5A0B45E29000A85F8872F9402B2026CE`.
- Les fichiers publics téléchargés ont été comparés aux empreintes locales ; la signature Ed25519 du fichier public a été vérifiée.
- Le programme exact inclus dans le lot a démarré et redémarré avec un profil neuf isolé : schéma 59, intégrité SQLite, clés étrangères et identité d’installation persistante vérifiés.

La [recette GitHub de l’installateur](https://github.com/leartshbj1/zentra/actions/runs/34706783209) n’a pas démarré : le compte est bloqué pour un problème de facturation. L’installation NSIS et la mise à niveau d’une installation existante restent donc non vérifiées pour ce lot. Le contrôle du démarrage du programme ne remplace pas ces deux essais.

Preuves locales : `.qa/windows-158-build.log`, `.qa/windows-158-ui.log`, `.qa/windows-158-time-native.log`, `.qa/document-typography-native.log`, `.qa/zentra-installer-packaged-158-verified/report.json`, `.qa/public158/public-Artifacts-proof.json`, `.qa/public158/public-Promote-proof.json` et `.qa/public158/windows-channel-no-cachebuster.json`.
