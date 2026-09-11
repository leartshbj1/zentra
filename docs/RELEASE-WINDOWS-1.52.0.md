# Windows 1.52.0 — assistant local

Publié le 11 septembre 2026 depuis `c5d8386b4616002b1bc0cc23c027e33985a9a40c`. Le fonctionnement et les limites de l’assistant sont détaillés dans [ASSISTANT-LOCAL.md](ASSISTANT-LOCAL.md).

- Installateur `Zentra_1.52.0_x64-setup.exe` : 22 724 651 octets.
- SHA-256 : `7B75AF6FAEBB8CC3D3AF85A9735EE33B33179BFAD55BF6BB2C885A24AD1B35C8`.
- Exécutable embarqué : `44CBFA489DBA6EC813452E63B341A5A7700D88DBC5FF618A3D9EFC88FACC7EF3`.
- Signature directe Tauri/Ed25519 vérifiée sur le fichier téléchargé depuis Supabase, avec la clé de confiance existante.
- Canal `latest-windows.json` publiquement vérifié en version 1.52.0. Ancien manifeste conservé sous `latest-windows-before-1.52.json` et comparé au précédent fichier public. Canal partagé `latest.json` inchangé.
- [GitHub v1.52.0](https://github.com/leartshbj1/zentra/releases/tag/v1.52.0), accès anticipé publié avec l’installateur, la signature et le contrôle SHA-256.
- [Site Zentra](https://elyko.alb-leart1.chatgpt.site), version 118, source `da0784ca9a348459ca0fec30a46bdf59ab1de5b2`, déploiement `appgdep_6aa3de16d6188191974c42144195bc06` réussi.

TypeScript, 25 tests ciblés, huit parcours de l’assistant et quatre parcours complémentaires de paramètres réussis. Modèle Qwen réel testé avec réutilisation du cache sans connexion externe et lecture d’une fiche synthétique après conversation. Ces tests ne constituent pas une installation native neuve ni une mise à jour attestée d’un profil réel. Authenticode indisponible ; aucun nouveau livrable macOS/iOS annoncé. Schéma SQLite de livraison inchangé à 59, modifications métier non publiées du dossier principal exclues.
