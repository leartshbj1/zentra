# Installer Zentra sur son iPhone

Le fichier `Zentra-1.29.0-iPhone-unsigned.ipa` contient l'application native
ARM64 pour un vrai iPhone (iOS 15 minimum). Il doit être signé avec ton compte
Apple par Sideloadly ou AltStore avant de pouvoir être lancé. Ouvrir le fichier
directement dans Safari ou Fichiers ne l'installe pas.

## Depuis Windows avec Sideloadly

1. Installer Sideloadly depuis https://sideloadly.io/ et les composants Apple
   indiqués par son guide officiel (versions web d'iTunes et d'iCloud).
2. Brancher l'iPhone par USB, le déverrouiller et accepter « Faire confiance ».
3. Ouvrir Sideloadly, sélectionner l'iPhone et glisser le fichier `.ipa` dedans.
4. Saisir ton compte Apple dans Sideloadly, puis cliquer sur **Start** et suivre
   les demandes de connexion. Ne partager aucun mot de passe dans le dépôt.
5. Sur l'iPhone, autoriser le profil dans **Réglages > Général > VPN et gestion
   de l'appareil** si demandé. Sur iOS 16 et versions suivantes, activer aussi
   **Réglages > Confidentialité et sécurité > Mode développeur** si demandé.
6. Ouvrir Zentra et vérifier le premier démarrage avant d'y saisir des données.

Avec un compte Apple gratuit, la signature expire généralement après 7 jours :
utiliser le renouvellement de Sideloadly. Conserver le même compte Apple et le
même identifiant d'application pour les mises à jour. Faire une sauvegarde
Zentra avant de réinstaller ; supprimer l'application efface ses données locales.

## Avec AltStore Classic déjà installé

Mettre le fichier IPA dans Fichiers sur l'iPhone, ouvrir **AltStore > My Apps > +**,
sélectionner l'IPA et suivre l'installation avec AltServer accessible. Renouveler
la signature avant son expiration. Guide : https://faq.altstore.io/altstore-classic/your-altstore

## Contenu et vérifications

`build-info.json` indique la révision source, la version, l'architecture et le
SHA-256. `SHA256SUMS.txt` permet de vérifier le téléchargement. La compilation
contrôle le contenu ZIP, le manifeste et le binaire ARM64 pour iPhoneOS.
L'installation et l'exécution sur ton iPhone restent à vérifier, notamment la
connexion, les fichiers, les exports et la sauvegarde/restauration.

Les données de ton PC ne sont pas automatiquement synchronisées vers l'iPhone.
Utiliser les fonctions de sauvegarde/restauration de Zentra si nécessaire.
