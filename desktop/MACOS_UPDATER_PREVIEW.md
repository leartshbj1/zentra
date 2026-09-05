# Installer Zentra sur macOS sans certificat Apple

Le workflow GitHub **Zentra macOS updater package** compile une application
universelle pour les Mac Intel et Apple Silicon. Le lot est signé **ad hoc**
pour l’installation macOS et séparément avec la clé Tauri/Ed25519 de Zentra
pour les mises à jour intégrées.

## Première installation

1. Télécharger le DMG de la version actuelle depuis la page officielle
   Zentra. Son nom suit le format `Zentra_<version>_macos-universal.dmg`.
2. Comparer, si souhaité, son empreinte avec `SHA256SUMS.txt`.
3. Ouvrir le DMG, puis glisser Zentra dans Applications.
4. Au premier lancement, essayer d’ouvrir Zentra une fois. Si Gatekeeper la
   bloque, ouvrir **Réglages système > Confidentialité et sécurité**, puis
   choisir **Ouvrir quand même** pour Zentra.

Ne désactivez pas Gatekeeper et n’utilisez pas de commande supprimant les
attributs de quarantaine de façon générale. Cette autorisation doit rester
limitée à l’application Zentra téléchargée depuis le site officiel.

## Mises à jour suivantes

Depuis Zentra 1.24.0, le canal de mise à jour intégré est disponible. Lorsqu’une version plus
récente est publiée, l’application télécharge son archive depuis le stockage
Zentra, vérifie sa signature Tauri/Ed25519, puis demande votre confirmation
avant l’installation.

## Limites de cette version

- l’identité de l’éditeur n’est pas encore attestée par Apple;
- le lot n’est pas notarié et Gatekeeper peut demander la validation manuelle
  décrite ci-dessus lors de la première installation;
- la signature de mise à jour vérifie l’origine du paquet Zentra, mais ne
  remplace pas un certificat Apple Developer ID ni la notarisation.

Une distribution sans étape Gatekeeper devra être compilée avec
`pnpm --dir desktop build:macos`, un certificat **Developer ID Application** et
les identifiants de notarisation Apple.
