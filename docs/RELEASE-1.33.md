# Zentra 1.33.0

Cette version permet de créer le remboursement d’un achat directement depuis le crédit reçu dans un relevé bancaire.

- Sélectionnez la dépense d’origine, renseignez l’avoir et sa TVA, puis joignez un PDF ou une photo. Le montant reçu et sa date viennent du relevé.
- La création du remboursement, son encaissement, son rapprochement et son justificatif sont enregistrés ensemble. Un refus ou une interruption ne laisse pas une partie de ces opérations enregistrée ; un nouvel essai identique évite les doublons.
- Retrouvez ensuite la dépense et ses pièces depuis la banque et le dossier du projet. Les achats sans paiement daté ou dont le montant disponible est insuffisant sont signalés avant validation.
- Le parcours s’adapte aux petits écrans avec deux étapes, une recherche et des boutons tactiles. Les commandes de paiement client inutiles sont masquées quand aucun client n’est proposé.
- La sélection d’un justificatif invalide retire maintenant le fichier précédemment choisi : aucune ancienne pièce ne sera jointe par erreur à une nouvelle dépense bancaire.

Validation du code : **535 tests natifs réussis (1 ignoré), 684 tests d’interface, Clippy et compilation web**. Les parcours bancaires, remboursements et dépenses sont vérifiés à 320, 390, 768, 1024 et 1440 px, ainsi qu’en lecture seule. Les essais contrôlent les interruptions, les nouveaux essais, les pièces jointes et les refus de périodes clôturées sur des données isolées. Le schéma SQLite reste à 49.

Version publiée le 5 septembre 2026 sur le [site de téléchargement](https://elyko.alb-leart1.chatgpt.site/download) et dans la [release GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.33.0). Le manifeste stable Windows/macOS annonce 1.33.0 après vérification de sa propagation. Les douze objets du stockage public et les douze pièces GitHub correspondent aux tailles et empreintes des paquets locaux.

Les paquets Windows et macOS démarrent avec une base isolée au schéma 49, intègre. L’application Windows contrôle le vrai canal HTTPS après publication ; ce contrôle ne démontre pas le remplacement complet d’une installation. Les signatures de mise à jour Ed25519 des deux paquets sont vérifiées. macOS contient les architectures Intel et Apple Silicon et sa construction finale réussit **536 tests natifs (un ignoré), 684 tests UI et Clippy**.

L’APK Android ARM64 de test pèse 56 447 503 octets. Le premier démarrage et le redémarrage sont vérifiés sur émulateur. Un autre essai remplace une ancienne construction 1.32 re-signée avec la même identité de test par 1.33 : client, projet, fichier et identité de l’installation conservés, schéma 49 et intégrité valides. Le ZIP iOS ARM64 de 45 691 877 octets est contrôlé sur simulateur : démarrage, SQLite et initialisation du trousseau ; la récupération iOS après redémarrage n’est pas démontrée.

**Anomalie encore ouverte :** deux essais précédents de l’ancienne fixture Android 1.32 sont restés à l’écran de chargement, avant le remplacement. Attendre le premier accueil avant de tester le redémarrage n’a pas suffi à éliminer le défaut dans le second essai. Les essais ultérieurs ont réussi, mais la cause de ces blocages intermittents n’est pas établie. Les journaux et les diagnostics sont conservés ; ce point n’est pas déclaré corrigé.

Le site, version 54, présente maintenant les liens directs des deux préversions, un accès depuis le haut de page et les limites d’installation à côté des boutons. La page publique est vérifiée à 320, 390, 768 et 1440 px : version, quatre liens, boutons tactiles, menu mobile, fermeture par Échap, retour du focus et absence de débordement ou d’erreur JavaScript. Les trois tests des métadonnées, le contrôle du code et la compilation du site réussissent.

La préversion Android conserve la signature persistante introduite en 1.32.0. Voir [la procédure et les limites des anciennes signatures](ANDROID-PREVIEW-SIGNING.md). Le ZIP iOS est destiné au simulateur ; il ne s’installe pas directement sur iPhone. Les aperçus ne constituent pas une publication App Store ou Google Play. Authenticode Windows, notarisation Apple, essais sur appareils physiques, mises à jour automatiques mobiles et synchronisation entre appareils restent à réaliser.

Traçabilité : application native `96353345be24dd13880f10f74eba5ec8f099c7ae`, contrôle et conditionnement Android `cda3f8e540d78da0d40885b4a57c4563d8cc36ee`, site `9eb1378a2db137a8f03b7c6228ac6428db0c6de4`. Workflows réussis : macOS 33988692959, mobile 33988693965, démarrage Android compact 33989985689, remplacement Android 33990005351. Les essais Android 33989253615 et 33989592330 ont échoué avant remplacement et restent dans l’audit. Preuve agrégée : `.qa/release-1.33-verified.json`.
