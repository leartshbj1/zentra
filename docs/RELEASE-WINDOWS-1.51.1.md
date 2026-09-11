# Windows 1.51.1 — aide à l’ajout d’un collaborateur

Publication du 11 septembre 2026. Source compilée : `d5aa711c830d0bf9fc255cee62b19ea9d4b06c38`.

Le contrôle annuel des petits salaires affiche désormais le champ à corriger, l’année choisie et la date saisie. Le formulaire ouvre les options concernées et place le focus sur le champ, avec une erreur accessible. Les libellés indiquent quel document utiliser. Pour un nouveau collaborateur uniquement, un choix explicite permet de compléter ce réglage plus tard ; reprendre la saisie conserve les réponses. Les règles de calcul et la validation des dates et des montants restent inchangées.

## Vérifications

- TypeScript et huit tests du formulaire annuel réussis, dans la source de livraison et le dossier de travail principal.
- Parcours Edge et WebKit réussis aux dimensions 320 × 568, 390 × 844, 844 × 390 et 1440 × 900 : ouverture des options, focus, date non remplacée, absence de débordement horizontal, report du réglage, conservation de la saisie et nouvel enregistrement après échec simulé.
- Compilation Windows GNU et signature directe Tauri/Ed25519 réussies. L’installateur téléchargé depuis Supabase correspond au fichier local ; sa signature est acceptée avec la clé de confiance existante.
- Schéma SQLite de livraison inchangé : 59. Les modifications métier non publiées du dossier de travail principal sont exclues.

## Distribution

- Installateur : `Zentra_1.51.1_x64-setup.exe`, 22 702 934 octets.
- SHA-256 : `9C9099FA6C3B0EC1006A14CE93A7179C12876A34229562F81D3210D06E28AEC9`.
- Exécutable embarqué : `4B6CA7AFEB1969907306F74FC71AED01A15119D5CA9738D4857FEE2916E03C33`.
- GitHub : <https://github.com/leartshbj1/zentra/releases/tag/v1.51.1>, accès anticipé publié.
- Canal Windows : <https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/latest-windows.json>, version 1.51.1 et signature publique vérifiées.
- Ancien manifeste Windows conservé sous `latest-windows-before-1.51.1.json`. Le manifeste partagé `latest.json` est inchangé.

La signature Windows Authenticode n’est pas disponible. Une installation native neuve et la mise à jour d’un profil réel ne sont pas attestées par ces vérifications : l’audit GitHub précédent, run `34575464924`, reste bloqué avant exécution par la facturation du compte. Aucune nouvelle distribution macOS ou iOS n’est annoncée par ce correctif.

Page de téléchargement : Site 117 publié, source `0bcfebc5e1b1cf8b89b8d1159acc7e0549eed19f`, déploiement `appgdep_6aa3c8dd28e48191baaccc5c1d8c4e9a` réussi sur <https://elyko.alb-leart1.chatgpt.site>.
