# Zentra 1.45.0

Les devis affichent désormais les totaux immédiatement après les prestations, avant les conditions. Les notes complémentaires conservent les retours à la ligne et les paragraphes dans l'aperçu et le PDF. Les conditions longues se poursuivent sur les pages suivantes sans repousser le total à la fin.

Les fichiers ajoutés aux projets — plans, photos et documents — sont d'abord conservés sur l'appareil, puis partagés avec les appareils autorisés de la même entreprise. Les fichiers téléchargés restent consultables hors ligne. Les ajouts et suppressions attendent dans une file persistante et reprennent automatiquement au retour du réseau, au premier plan ou à la réouverture de l'app. Un bouton permet aussi de relancer la synchronisation. Les suppressions sont partagées et un ancien appareil hors ligne ne peut pas rétablir un fichier supprimé.

Connectez chaque appareil au même espace d'entreprise et installez cette version. Sur un nouvel appareil configuré, le dossier est créé au premier fichier reçu. Cette synchronisation couvre les fichiers joints aux projets ; les clients, documents commerciaux, écritures comptables et le planning restent locaux. Les fichiers sont limités à 25 Mo chacun. Sur mobile, le système peut suspendre une application fermée : les transferts reprennent alors à son ouverture.

Dans Zentra Windows ou Mac : **Mise à jour → Rechercher une mise à jour**. Les paquets gardent la signature Tauri/Ed25519 habituelle. L'APK Android est une préversion de test avec la signature durable précédente. L'IPA iPhone doit être signé avec Sideloadly ou AltStore ; voir INSTALL-IPHONE-1.45.md. Le ZIP iOS est réservé au simulateur Mac. Ces fichiers ne constituent pas une publication sur les boutiques Apple et Google.

Contrôles des paquets terminés : tests serveur, interface et moteur natif, TypeScript, Clippy, signatures des mises à jour Windows et Mac, démarrage et redémarrage Windows, démarrage du paquet Mac universel, mise à niveau Android 1.44 → 1.45 sur émulateur et démarrage iOS sur simulateur. Quatre PDF de contrôle, soit huit pages, ont été rendus et inspectés. Six parcours d'interface à 320, 390 et 1440 pixels couvrent les notes multilignes, l'ajout hors ligne et la reprise sans doublon. Les tests locaux couvrent la persistance après redémarrage, les suppressions, les fichiers altérés et l'isolation entre entreprises ; les tests serveur contrôlent l'authentification, les droits et les reprises.

La recette d'interface utilise des données simulées et ne prouve pas un transfert entre deux appareils physiques. La recette de mise à niveau Android utilise les APK x86_64 compagnons exacts, sans nouvelle signature. L'IPA est un paquet ARM64 iPhoneOS sans installation physique vérifiée. Le remplacement par l'installateur Windows n'a pas été exercé. Les exécutables Windows restent sans Authenticode et le paquet Mac sans notarisation Apple.

## Traçabilité

Source des paquets natifs : `443274a858ef2a2854e6f69c56b79244c6d0c65b`. Schéma SQLite : **58**.

- [macosWorkflow](https://github.com/leartshbj1/zentra/actions/runs/34072550803) : terminé avec succès sur cette source.
- [mobileWorkflow](https://github.com/leartshbj1/zentra/actions/runs/34072552077) : terminé avec succès sur cette source.
- [ipaWorkflow](https://github.com/leartshbj1/zentra/actions/runs/34072553525) : terminé avec succès sur cette source.
- [androidCompactWorkflow](https://github.com/leartshbj1/zentra/actions/runs/34073343074) : terminé avec succès sur cette source.
- [androidUpgradeWorkflow](https://github.com/leartshbj1/zentra/actions/runs/34073603718) : terminé avec succès sur cette source.

Tests : 204 tests serveur, 742 tests d’interface et 625 tests natifs sur macOS réussis (un test natif ignoré). Le profil Windows utilisé pour le démarrage est isolé et neuf ; sa base SQLite passe les contrôles d’intégrité et de clés étrangères.

La migration Android vérifie le passage du schéma 57 au schéma 58, avec conservation du client, du projet, du fichier lié et de l’identité d’installation.

| Fichier | SHA-256 |
| --- | --- |
| Zentra_1.45.0_x64-setup.exe | `2243EA954B43CA09B003A14D3025379F8E1100C8F16B520CF1502D2A5C1F73DF` |
| Zentra_1.45.0_macos-universal.app.tar.gz | `18FCE57D9F5C0551302402C266DB1B06C5F05E2AD5743FE5250025CAF256A691` |
| Zentra_1.45.0_macos-universal.dmg | `76F1F33B513008009474296D0F4D89E50B89CF37758F41EB5D0746F3441313F9` |
| Zentra-1.45.0-Android-arm64-test.apk | `6301E7C4A4045B1D74A8FC67DB161A20E06DD08A8B696FC496EB0D8A03C6EFAD` |
| Zentra-1.45.0-iPhone-unsigned.ipa | `a7ed8502f5ab80c00adbff207bc6e01df06de2580e4be82dfbac1cb2f7ab17c9` |
