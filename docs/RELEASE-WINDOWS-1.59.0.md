# Windows 1.59.0

## Contenu

- Atelier de documents : collage avec mise en forme, recherche et remplacement, réutilisation des styles et nouveaux réglages de mise en page. Les erreurs de texte, de pied de page et de logo conduisent au réglage à corriger. Les présentations figées des documents déjà émis sont conservées.
- Paie : récapitulatif avant comptabilisation, corrections guidées et passage explicite au paiement. Les saisies restent accessibles après un refus.
- Devis, factures, achats et banque : validation guidée, explication des points à compléter et récupération après un enregistrement confirmé dont la relecture échoue, sans refaire l'écriture.
- Comptabilité, exercices, contacts et planning : parcours simplifiés, formulaires vérifiés et accès aux dossiers liés.
- Agenda : durées rapides, dates compréhensibles, correction des erreurs dans le formulaire et comparaison des modifications concurrentes. Une suppression ou une finalisation se relit avant confirmation.

## Périmètre

Windows x64, identifiant `ch.helvichantier.desktop` et schéma SQLite 59 conservés. Aucun nouvel installateur macOS, iOS ou Android n'est compris dans ce lot. Le certificat annuel officiel conserve son formulaire réglementaire.

La signature Tauri/Ed25519 authentifie le lot de mise à jour. Aucun certificat Authenticode n'est disponible : Windows peut afficher « Éditeur inconnu ».

## Validation

Les 1 308 tests d'interface passent. La suite complète du moteur natif termine avec 666 tests réussis, aucun échec et deux tests ignorés. Le contrôle HTTPS du renouvellement de licence, ignoré par défaut, a ensuite été exécuté séparément et réussit avec un jeton fictif refusé par le serveur. La recette de sauvegarde HTTPS entre deux installations, qui requiert des autorisations navigateur dédiées, n'a pas été exécutée dans ce lot. TypeScript et la compilation de production passent. Les parcours détaillés des fonctionnalités sont consignés dans leurs guides et dans `QUALITE-APP-2026-09-12.md`.

Le programme exact inclus dans le lot a démarré et redémarré avec un profil neuf : schéma 59, intégrité SQLite, clés étrangères et identité protégée persistante vérifiés. Un profil 1.58 contenant un client, un projet, un devis, une facture avec paiement, un collaborateur, une pièce jointe, des séquences et des écritures fictives a ensuite été ouvert avec le programme 1.58 puis avec le programme 1.59, et redémarré. Toutes les tables précédentes, l'identité et la pièce jointe ont conservé leurs empreintes ; les écritures sont équilibrées.

Ces essais remplacent les programmes dans un environnement de test. Ils n'exécutent pas NSIS et ne représentent pas une installation client. Le contrôle initial du processus lisait parfois un module du chargeur Windows comme chemin de l'application ; il a été corrigé pour interroger le chemin réel du processus. La copie isolée de l'ancien programme a aussi reçu sa dépendance WebView2Loader avant la recette réussie. Les cinq essais définitifs passent.

La [recette GitHub de l'installateur](https://github.com/leartshbj1/zentra/actions/runs/34729286288) n'a pas démarré : le compte est bloqué pour un problème de facturation. L'installation NSIS neuve et la mise à niveau par l'installateur restent donc non vérifiées.

## Livraison

Préversion Windows publiée le 13 septembre 2026 sur [GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.59.0) à 00:59 UTC. Le canal public `latest-windows.json` annonce la version 1.59.0 ; sa lecture ordinaire, sans contournement du cache, a été vérifiée à 01:02 UTC. Le canal partagé des autres plateformes est resté inchangé. Depuis Windows 1.50, le bouton **Mise à jour** utilise ce canal ; les versions plus anciennes disposent de l'installateur manuel.

La [page de téléchargement](https://elyko.alb-leart1.chatgpt.site/download) a été publiée avec succès à 01:01 UTC. Son build de production et ses quatre tests de liens de téléchargement passent. Le lanceur de build Sites ne démarrant pas le gestionnaire de paquets sur ce Windows, le même script `build` du projet a été exécuté directement avec le pnpm du runtime ; le paquet final a été produit et validé par le helper Sites.

- Source native : `ecdb9398b15ef11765895341e7d8fc297fc6f5cc`.
- Source du site : `6e01d5555d10d3f45ba5e6503763903da8bf709a`.
- Installateur : `Zentra_1.59.0_x64-setup.exe`, 22 923 726 octets.
- SHA-256 : `89A1AC5ABCB097DFF8E185CD2399E10C211BE02FCFD78F4902C2BCA3997FB984`.
- SHA-256 du programme après marquage NSIS : `925692D96C4EA85A50BDC9A8D4E35643BA31354E05B8819EDF9276F29210B166`.
- Les fichiers téléchargés depuis le stockage public correspondent aux empreintes locales ; leur signature Tauri/Ed25519 a été vérifiée. Les empreintes des fichiers GitHub correspondent également.

Preuves locales : `.qa/windows-159-build.log`, `.qa/windows-159-ui.log`, `.qa/windows-159-native.log`, `.qa/windows-159-license-https.log`, `.qa/windows-159-stage.log`, `.qa/windows-159-packaged-final2.log`, `.qa/zentra-installer-packaged159-final2/report.json` et les preuves de publication, de cache et de recette GitHub dans `.qa/public159/`.
