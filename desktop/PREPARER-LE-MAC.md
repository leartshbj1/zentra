# Préparer votre Mac pour les versions de Zentra

Votre inscription Apple Developer est encore bloquée. Vous pouvez déjà compiler et tester l'application sur ce Mac. La publication avec une identité d'éditeur vérifiée et la notarisation attend l'activation de l'adhésion.

## Première préparation

1. Installez **Xcode** depuis le Mac App Store. Ouvrez-le une fois et terminez l'installation des composants proposés. Pour les effets Apple récents, utilisez Xcode 26 ou une version ultérieure compatible avec votre Mac.
2. Installez **Node.js 22 LTS ou ultérieur** depuis https://nodejs.org/ et **Rust** depuis https://rustup.rs/ (installation par défaut).
3. Ouvrez Terminal et vérifiez les outils :

```sh
xcodebuild -version
node --version
cargo --version
npm install --global pnpm@10
```

4. Récupérez la version préparée (dans un nouveau dossier) :

```sh
git clone --branch codex/release-1.50.0 --single-branch https://github.com/leartshbj1/zentra.git Zentra-publication
cd Zentra-publication/desktop
pnpm install --frozen-lockfile
pnpm build:macos:preview
open artifacts/macos-preview
```

Le premier calcul peut être long. Le dossier final contient le DMG et l'application universelle Intel/Apple Silicon. Cette compilation de test utilise une signature ad hoc : elle n'est pas notariée et n'active pas les mises à jour intégrées. Testez le démarrage, les devis, les factures et les fiches de salaire avec des données de démonstration.

Si macOS bloque cette application que vous venez de compiler, consultez **Réglages système → Confidentialité et sécurité** pour l'autorisation propre à Zentra. Ne désactivez pas la protection générale de macOS.

## Dès que l'adhésion Apple Developer est active

Dans Xcode → Settings → Accounts, ajoutez votre compte puis le certificat **Developer ID Application**. La compilation de distribution utilise `pnpm build:macos` et demande également les identifiants de notarisation et la clé de signature des mises à jour Zentra déjà utilisée. Ne créez pas une nouvelle clé Tauri pour remplacer celle des installations existantes.

Conservez les clés privées dans le trousseau/coffre local ; ne les envoyez pas dans la conversation et ne les ajoutez pas au dépôt. Le script `scripts/build-macos-updater.sh` vérifie la signature, la notarisation, le DMG et l'archive de mise à jour avant de déclarer la compilation réussie.

La publication consiste ensuite à déposer les fichiers versionnés `.dmg`, `.app.tar.gz` et `.sig`, vérifier les fichiers téléchargés, tester une installation puis une mise à niveau, et enfin remplacer le manifeste du canal macOS. Le fichier historique `latest.json` reste actuellement en version 1.46.1 ; Windows 1.50 utilise désormais `latest-windows.json`. Une compilation locale seule ne publie pas une mise à jour.

Références : https://developer.apple.com/developer-id/ et https://v2.tauri.app/distribute/sign/macos/
