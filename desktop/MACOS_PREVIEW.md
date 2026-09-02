# Tester Zentra sur macOS sans certificat Apple

Le workflow GitHub **Zentra macOS preview** compile une application universelle
pour les Mac Intel et Apple Silicon. Le lot est signé **ad hoc** : il ne demande
aucun certificat Apple, mais il est réservé aux tests privés du propriétaire.

## Installation sur le Mac de test

1. Dans GitHub, ouvrir **Actions > Zentra macOS preview**, lancer le workflow,
   puis télécharger son artefact une fois le contrôle vert.
2. Vérifier si souhaité les empreintes indiquées dans `SHA256SUMS.txt`.
3. Ouvrir le DMG, puis glisser Zentra dans Applications.
4. Au premier lancement, tenter d’ouvrir Zentra une fois. Si Gatekeeper la
   bloque, ouvrir **Réglages système > Confidentialité et sécurité**, puis
   choisir **Ouvrir quand même** pour Zentra.

Ne désactivez pas Gatekeeper et n’utilisez pas de commande supprimant les
attributs de quarantaine de façon générale. Cette autorisation doit rester
limitée à l’application Zentra que vous venez de compiler dans votre dépôt.

## Limites du lot

- l’identité de l’éditeur n’est pas attestée par Apple;
- le lot n’est pas notarié et ne convient pas à une distribution publique;
- les artefacts GitHub expirent après 14 jours;
- le canal de mise à jour signé reste volontairement désactivé.

La release publique macOS devra ensuite être compilée avec
`pnpm --dir desktop build:macos`, un certificat **Developer ID Application** et
les identifiants de notarisation Apple.
