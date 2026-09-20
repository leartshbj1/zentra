# Zentra 1.74.1 — Diagnostic de la connexion Automation

Automation ne présente plus chaque échec comme une absence de connexion Internet. La lecture des réglages conserve la cause native ; seules les suggestions facultatives conservent leur repli silencieux vers le travail manuel.

L’interface distingue une entreprise rattachée à un autre compte, un partage à activer, une session à renouveler, une indisponibilité du service et un réseau signalé hors ligne. Un bouton ouvre les paramètres du compte. Les messages sont disponibles en français, allemand, italien et anglais ; aucune réponse brute ni donnée sensible n’est affichée.

La vérification native de l’entreprise demeure obligatoire avant tout accès Automation. Les réponses d’une ancienne session ne remplacent pas celles de l’entreprise courante. Les données locales ne sont ni déplacées ni réinitialisées par ce correctif.

## Validation

- 1 579 tests d’interface réussis dans 191 fichiers.
- Cinq tests Rust Automation réussis : distinction des liens absents/incohérents, isolation des ressources, rôles, actions interdites et réponses périmées.
- Contrôle TypeScript réussi.

## Distribution

Correctif Windows. Les fichiers macOS, iPhone et Android 1.74.0 restent disponibles. Les preuves de compilation et de distribution Windows seront ajoutées après vérification.
