# Zentra 1.51.0 — interface et paie guidée

Version Windows préparée depuis la release 1.50.0, en conservant le schéma natif 59. Les autres travaux métier du dossier principal sont exclus.

- Nouvelle présentation claire de l’application, navigation légère, cartes lisibles et transitions de pages respectant la réduction des animations. Les styles sont limités à l’écran pour préserver les documents imprimés.
- Collaborateur en trois étapes : identité, travail et salaire, récapitulatif. Coordonnées facultatives, import de document et réglages particuliers sont regroupés dans des sections ouvrables. La validation retrouve le champ à corriger, y compris dans une étape masquée. Les retours et erreurs conservent la saisie.
- Fiche de salaire : la seule personne active est présélectionnée avec son salaire récurrent. Les personnes inactives restent disponibles uniquement pour modifier leurs fiches existantes.
- Corrections de paie : un premier point est présenté avec son action directe ; les autres restent accessibles dans une liste ouvrable. Aucun contrôle de cotisation n’est supprimé et aucun montant d’assurance n’est inventé.
- Canal de mise à jour Windows inchangé : `latest-windows.json`, contrôle et badge de disponibilité existants conservés. Le canal `latest.json` de macOS et des anciennes installations reste distinct.

Vérification : création collaborateur sous Edge et WebKit, 320/390/844/1440 pixels, validation, retours, nouvelle tentative après erreur et données transmises. Parcours de pension et préparation de paie contrôlés à 320/390/1440 pixels. Compilation TypeScript. Les essais de navigateur utilisent des données fictives ; ils ne prouvent pas une installation physique native.

## Publication vérifiée le 11 septembre 2026

- Windows publié en accès anticipé : https://github.com/leartshbj1/zentra/releases/tag/v1.51.0
- Source compilée et cible du tag : `1757ce49f52e937f39e8516a12e43f986dabe629`. Le commit suivant ajoute uniquement la reconnaissance des versions dans le test d’installation.
- Installateur : `Zentra_1.51.0_x64-setup.exe`, 22 727 313 octets. SHA-256 `D94C5B7A75200494BDBB137CE5B081513E63378EEF3BEAE76C4C5AC6C4E2285A`.
- Exécutable après assemblage NSIS : SHA-256 `B3F84A580B82FA17F1C0B18D994888F0E06791F0DD5B60D24E593EA124CD0779`.
- Installateur, signature et empreinte publiés dans le bucket Supabase `zentra-releases` et sur GitHub. Les octets téléchargés depuis Supabase correspondent à l’artefact local ; leur signature Tauri/Ed25519 est valide. La clé de confiance existante est conservée.
- `latest-windows.json` annonce 1.51.0 avec la signature et l’URL exactes. L’ancien manifeste Windows est conservé sous `latest-windows-before-1.51.json`. L’interface de stockage ayant ajouté un suffixe au premier envoi, la bascule a été effectuée par renommage des deux objets. Le cache public retourné est `max-age=3600` ; ne pas réutiliser la valeur de 60 secondes documentée pour 1.50.
- `latest.json` reste strictement identique au fichier récupéré avant publication, afin de conserver le canal des anciennes installations et de macOS.
- Site public : https://elyko.alb-leart1.chatgpt.site — version Sites 116, source `7d5c0f9f367cf59ea0438fdf0549b2c82bcd8b6c`, déploiement `appgdep_6aa3b0840c648191895b424175cfe128` terminé avec succès, environnement révision 23.
- Le lanceur Sites Windows n’a pas trouvé le gestionnaire de paquets ; `pnpm run build` a réussi. L’archive a été préparée et validée par le script Sites officiel via Git Bash.

Vérifications complémentaires : 50 tests unitaires de paie réussis ; devis/factures sur quatre formats ; 8 catégories de paramètres sur cinq formats ; badge de mise à jour sur trois largeurs ; 32 états d’écrans sans erreur JavaScript ni débordement détecté. Rapports dans `.qa/` du worktree de release, preuve publique dans `.qa/updater-publication-151/public-proof.json` du dossier principal.

Le contrôle d’installation Windows sur GitHub a été relancé : https://github.com/leartshbj1/zentra/actions/runs/34575464924. Aucun test n’a démarré : le compte GitHub est verrouillé pour un problème de facturation. Aucun test d’installation physique de 1.51 n’est donc revendiqué. L’installateur n’est pas signé Authenticode ; Windows peut afficher « Éditeur inconnu ».

Aucun nouveau paquet macOS, iOS ou Android n’est inclus.
