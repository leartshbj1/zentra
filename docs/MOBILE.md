# Zentra sur iOS et Android

La version 1.25 prépare une application Tauri native qui réutilise le moteur SQLite et les écrans de gestion. La compilation et la distribution mobiles sont distinctes des installateurs Windows et macOS.

## Utilisation

La navigation inférieure donne accès à Accueil, Projets, Ventes et Menu. Les formulaires occupent l’écran sur téléphone. Un projet demande un nom et un client ; ses documents et photos sont accessibles immédiatement, tandis que l’adresse, les dates et le budget restent facultatifs. Les devis et factures liés apparaissent automatiquement dans son dossier.

Les fichiers restent dans le stockage privé de l’application. Les exports PDF, JSON, CSV, TVA et les sauvegardes utilisent la feuille de partage du système. Les identités techniques sont protégées par le Trousseau iOS ou Android Keystore. Les sauvegardes Android automatiques sont désactivées : un secret chiffré par une clé d’un appareil ne doit pas être restauré isolément sur un autre.

## Compilation

Depuis un environnement Android SDK, Java 17 et Rust configuré :

Sur Linux et macOS, utiliser `RUSTUP_TOOLCHAIN=stable` ; le fichier de toolchain local Windows reste réservé à ce système.

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop exec tauri android init --ci --skip-targets-install
node desktop/scripts/configure-mobile-project.mjs android
pnpm --dir desktop exec tauri android build --debug --apk --target aarch64 --ci
```

Depuis macOS avec Xcode, dans un checkout de compilation dédié :

```sh
printf '[toolchain]\nchannel = "stable"\n' > desktop/src-tauri/rust-toolchain.toml
pnpm --dir desktop exec tauri ios init --ci --skip-targets-install
pnpm --dir desktop exec tauri ios build --debug --target aarch64-sim --ci
```

Le choix du toolchain est écrit dans ce checkout car Xcode filtre la variable `RUSTUP_TOOLCHAIN` de ses phases de compilation. Conserver le toolchain GNU du dépôt dans le checkout utilisé pour produire Windows.

Le workflow GitHub Actions `Zentra mobile preview` produit un APK Android ARM64 de test et une application pour simulateur iOS. Ces artefacts ne constituent pas une publication dans les stores. Une recette sur appareils réels doit aussi couvrir caméra, sélection des fichiers, clavier, export PDF, connexion, sauvegarde et restauration.

Pour un vrai iPhone, choisir `platform: ipa` dans ce workflow. Il compile la
cible `aarch64-apple-ios` en release, sans signature Apple, puis vérifie et livre
un IPA destiné à Sideloadly ou AltStore. Aucun certificat Apple n'est nécessaire
pour cette compilation ; la signature se fait lors de l'installation. Depuis
le checkout macOS préparé ci-dessus :

```sh
rustup target add aarch64-apple-ios
pnpm --dir desktop mobile:ios:ipa
python3 desktop/scripts/verify-ios-ipa.py desktop/src-tauri/gen/apple/build/arm64/Zentra.ipa --output-dir desktop/artifacts/iphone
```

Le fichier ZIP du simulateur ne fonctionne pas sur un iPhone. Voir
[le guide d'installation sur iPhone](INSTALL-IPHONE.md) pour l'IPA.

## Publication et mises à jour

Windows et macOS utilisent le manifeste HTTPS et les signatures Tauri existants. L’application vérifie la disponibilité d’une nouvelle version après son démarrage ; l’installation reste déclenchée par l’utilisateur.

iOS et Android utilisent les mises à jour du store. La publication nécessite les comptes développeur, signatures de distribution, identifiants de boutique, fiches et validations Apple/Google. Les clés privées restent dans les coffres et secrets de compilation, jamais dans le dépôt. Il faut augmenter la version et le numéro de build avant chaque dépôt.

Une mise à jour remplace le logiciel et conserve son profil local. Elle ne synchronise pas automatiquement les projets entre appareils : la base métier reste locale, avec transfert par sauvegarde/restauration et coffre de factures déjà disponible.
