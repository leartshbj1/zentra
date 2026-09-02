# Tester Zentra sur macOS sans certificat Apple

Le workflow GitHub **Zentra macOS preview** compile une application universelle
pour les Mac Intel et Apple Silicon. Le lot est signé **ad hoc** : il ne demande
aucun certificat Apple et le DMG validé peut être publié en accès anticipé.

## Installation sur le Mac de test

1. Télécharger le DMG depuis la page publique Zentra, ou ouvrir dans GitHub
   **Actions > Zentra macOS preview** pour récupérer l’artefact d’un run validé.
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
- le lot n’est pas notarié et Gatekeeper peut demander une validation manuelle;
- les artefacts GitHub expirent après 14 jours;
- le canal de mise à jour signé reste volontairement désactivé.

La distribution macOS sans étape Gatekeeper devra ensuite être compilée avec
`pnpm --dir desktop build:macos`, un certificat **Developer ID Application** et
les identifiants de notarisation Apple.
