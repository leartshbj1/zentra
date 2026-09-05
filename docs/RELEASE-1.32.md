# Zentra 1.32.0

Cette version réunit les justificatifs des remboursements avec les dépenses et les dossiers des projets.

- Joignez un PDF ou une photo JPG, PNG ou WebP lors de l’enregistrement d’un remboursement ou de sa correction. Vous pouvez aussi compléter son historique ensuite, jusqu’à vingt pièces de 25 Mo par événement.
- Les justificatifs sont conservés après une correction et dans les sauvegardes. Un nouvel essai ne crée pas une seconde copie du même fichier.
- Retrouvez la dépense d’origine depuis le remboursement proposé par la banque, son rapprochement actif ou son historique. Le dossier du projet donne le même accès depuis la pièce jointe.
- Sur mobile, les noms des fichiers disposent de toute la largeur et les quatre onglets du dossier restent visibles. Les pièces sont consultables en lecture seule.
- Les refus de copie et interruptions de lecture conservent la saisie et évitent de répéter une écriture déjà confirmée.

Validation du code avant emballage : 530 tests natifs réussis (1 ignoré), 680 tests d’interface, Clippy, compilation web et trois parcours navigateur à 320, 390, 768, 1024 et 1440 px. La migration de base 48 vers 49 préserve les anciens remboursements. Les transactions SQLite vérifient l’atomicité et les sauvegardes avec les octets réels des justificatifs.

Publication en préparation. Les installateurs et les aperçus mobiles de cette version doivent encore être reconstruits et contrôlés avant d’activer la mise à jour publique. Les aperçus mobiles ne constituent pas une publication dans l’App Store ou Google Play.
