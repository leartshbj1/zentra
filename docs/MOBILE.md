# Zentra sur iOS et Android

La version 1.25 prépare une application Tauri native qui réutilise le moteur SQLite et les écrans de gestion. La compilation et la distribution mobiles sont distinctes des installateurs Windows et macOS.

## Utilisation

La navigation inférieure donne accès à Accueil, Projets, Ventes et Menu. Les formulaires occupent l’écran sur téléphone. Un projet demande un nom et un client ; ses documents et photos sont accessibles immédiatement, tandis que l’adresse, les dates et le budget restent facultatifs. Les devis et factures liés apparaissent automatiquement dans son dossier.

Les fichiers restent dans le stockage privé de l’application. Les exports PDF, JSON, CSV, TVA et les sauvegardes utilisent la feuille de partage du système. Les identités techniques sont protégées par le Trousseau iOS ou Android Keystore. Les sauvegardes Android automatiques sont désactivées : un secret chiffré par une clé d’un appareil ne doit pas être restauré isolément sur un autre.

## Compilation

Depuis un environnement Android SDK, Java 17 et Rust configuré :

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop exec tauri android init --ci --skip-targets-install
node desktop/scripts/configure-mobile-project.mjs android
pnpm --dir desktop exec tauri android build --debug --apk --target aarch64 --ci
```

Depuis macOS avec Xcode :

```sh
pnpm --dir desktop exec tauri ios init --ci --skip-targets-install
pnpm --dir desktop exec tauri ios build --debug --target aarch64-sim --ci
```

Le workflow GitHub Actions `Zentra mobile preview` produit un APK Android ARM64 de test et une application pour simulateur iOS. Ces artefacts ne constituent pas une publication dans les stores. Une recette sur appareils réels doit aussi couvrir caméra, sélection des fichiers, clavier, export PDF, connexion, sauvegarde et restauration.

## Publication et mises à jour

Windows et macOS utilisent le manifeste HTTPS et les signatures Tauri existants. L’application vérifie la disponibilité d’une nouvelle version après son démarrage ; l’installation reste déclenchée par l’utilisateur.

iOS et Android utilisent les mises à jour du store. La publication nécessite les comptes développeur, signatures de distribution, identifiants de boutique, fiches et validations Apple/Google. Les clés privées restent dans les coffres et secrets de compilation, jamais dans le dépôt. Il faut augmenter la version et le numéro de build avant chaque dépôt.

Une mise à jour remplace le logiciel et conserve son profil local. Elle ne synchronise pas automatiquement les projets entre appareils : la base métier reste locale, avec transfert par sauvegarde/restauration et coffre de factures déjà disponible.
