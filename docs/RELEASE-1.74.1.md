# Zentra 1.74.1 — Diagnostic de la connexion Automation

Automation ne présente plus chaque échec comme une absence de connexion Internet. La lecture des réglages conserve la cause native ; seules les suggestions facultatives conservent leur repli silencieux vers le travail manuel.

L’interface distingue une entreprise rattachée à un autre compte, un partage à activer, une session à renouveler, une indisponibilité du service et un réseau signalé hors ligne. Un bouton ouvre les paramètres du compte. Les messages sont disponibles en français, allemand, italien et anglais ; aucune réponse brute ni donnée sensible n’est affichée.

La vérification native de l’entreprise demeure obligatoire avant tout accès Automation. Les réponses d’une ancienne session ne remplacent pas celles de l’entreprise courante. Les données locales ne sont ni déplacées ni réinitialisées par ce correctif.

## Validation

- 1 579 tests d’interface réussis dans 191 fichiers.
- Cinq tests Rust Automation réussis : distinction des liens absents/incohérents, isolation des ressources, rôles, actions interdites et réponses périmées.
- Contrôle TypeScript réussi.

## Distribution

Correctif Windows publié le 20 septembre 2026. Les fichiers macOS, iPhone et Android 1.74.0 restent disponibles.

- Source compilée : `e10befbcc1470ed6a631adbf5422fadd3f27776a`.
- Installateur : `Zentra_1.74.1_x64-setup.exe`, 23 637 296 octets, SHA-256 `FA7CF10F5B25A5D29DAFF3FBD6F50E12CF17686B1B0BB536448CFCB869DB4645`.
- Signature de mise à jour Tauri vérifiée avec la clé publique existante. La signature Authenticode reste absente.
- Six scénarios isolés réussis avec le binaire Windows : premier démarrage, redémarrage, initialisation de l’ancienne version 1.74.0 installée, données fictives dans cette version, remplacement par 1.74.1, puis redémarrage. Intégrité SQLite, clés étrangères, identité d’installation et données conservées. Cela ne constitue pas un essai d’installation NSIS ni une validation de l’entreprise réelle.
- Preuve des scénarios : `outputs/release1741/zentra-installer-packaged1741/report.json`.
- Artefacts publics Supabase relus et comparés octet pour octet avant promotion de `latest-windows.json` ; manifeste relu en version 1.74.1 avec un cache de 60 secondes. Manifeste partagé historique inchangé. Preuves : `outputs/release1741/public1741/public-Artifacts-proof.json` et `public-Promote-proof.json`.
- Publication GitHub `v1.74.1` confirmée avec quatre fichiers Windows.
- Page de téléchargement publiée depuis `a89648a2366b795aaf83c20f345f46c4f554d2c9` (Sites 191). Construction, TypeScript et quatre tests du contrat de téléchargement réussis.

Ce correctif rend le diagnostic et l’accès aux réglages explicites ; il ne rattache pas automatiquement une entreprise à un autre compte. Cette opération demande un choix explicite de l’entreprise et une conservation préalable des données.
