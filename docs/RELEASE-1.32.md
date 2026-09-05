# Zentra 1.32.0

Cette version réunit les justificatifs des remboursements avec les dépenses et les dossiers des projets.

- Joignez un PDF ou une photo JPG, PNG ou WebP lors de l’enregistrement d’un remboursement ou de sa correction. Vous pouvez aussi compléter son historique ensuite, jusqu’à vingt pièces de 25 Mo par événement.
- Les justificatifs sont conservés après une correction et dans les sauvegardes. Un nouvel essai ne crée pas une seconde copie du même fichier.
- Retrouvez la dépense d’origine depuis le remboursement proposé par la banque, son rapprochement actif ou son historique. Le dossier du projet donne le même accès depuis la pièce jointe.
- Sur mobile, les noms des fichiers disposent de toute la largeur et les quatre onglets du dossier restent visibles. Les pièces sont consultables en lecture seule.
- Les refus de copie et interruptions de lecture conservent la saisie et évitent de répéter une écriture déjà confirmée.

Validation du code avant emballage : 530 tests natifs réussis (1 ignoré), 680 tests d’interface, Clippy, compilation web et trois parcours navigateur à 320, 390, 768, 1024 et 1440 px. La migration de base 48 vers 49 préserve les anciens remboursements. Les transactions SQLite vérifient l’atomicité et les sauvegardes avec les octets réels des justificatifs.

Version publiée le 5 septembre 2026 sur le [site de téléchargement](https://elyko.alb-leart1.chatgpt.site/download) et dans la [release GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.32.0). Le canal signé Windows/macOS annonce 1.32.0. Les douze fichiers du stockage public et les douze pièces de la release correspondent aux tailles et empreintes des paquets contrôlés.

La construction finale macOS réussit les **531 tests natifs (un ignoré), 680 tests UI et Clippy**. Le DMG et l’archive de mise à jour sont universels Intel/Apple Silicon. Les démarrages Windows et macOS créent une base isolée au schéma 49, intègre ; Windows interroge aussi le canal HTTPS publié. Les signatures de mise à jour Ed25519 sont vérifiées pour les deux systèmes. Authenticode Windows et notarisation Apple restent à réaliser.

La page publique, version Sites 53, est vérifiée sans authentification à 320, 390, 768 et 1440 px : version, téléchargements, menu mobile, fermeture par Échap, retour du focus et absence de débordement ou d’erreur JavaScript. Aucun profil réel n’a été utilisé pour les essais.

L’APK Android ARM64 de test pèse 56 431 119 octets au lieu de 91 503 090 avant retrait des symboles de débogage. Sa signature de préversion devient persistante et son certificat est épinglé. Un émulateur vérifie le remplacement de 1.31.0 par 1.32.0 avec cette même signature : client, projet, fichier et identité de l’installation conservés, migration SQLite 48 → 49 et intégrité valide. L’ancienne construction est **re-signée pour ce test isolé** : cela ne permet pas de remplacer directement les anciens APK publics à signature éphémère. Avant de quitter une ancienne préversion, exporter et vérifier une sauvegarde complète ; une désinstallation efface les données locales. Voir [la procédure et ses limites](ANDROID-PREVIEW-SIGNING.md).

Le ZIP iOS ARM64 est destiné au simulateur, avec démarrage, SQLite et initialisation du stockage sécurisé contrôlés. Il ne s’installe pas directement sur iPhone. Les aperçus ne constituent pas une publication App Store ou Google Play. Les essais sur appareils physiques, les mises à jour automatiques mobiles et la synchronisation des données entre appareils restent à réaliser.

Traçabilité : application native `0cbc4521eb30f1dd2989075d49f3255b201d87ba`, conditionnement Android `d6119d85d3e3ecedc144f7c45d2e2e919a0b3cf2`, site `fad6538c4d4444a787f234c5473614a2c2004c24`. Workflows : macOS 33984133726, mobile 33984135108, signature et migration Android 33986301458. Preuve locale agrégée : `.qa/release-1.32-verified.json`.
