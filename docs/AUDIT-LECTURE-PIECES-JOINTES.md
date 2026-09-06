# Lecture des pièces jointes des projets — 6 septembre 2026

État : corrections de source après la publication 1.38, pas encore distribuées. Aucun paquet 1.38 ni fichier du canal stable n'a été remplacé.

## Problèmes observés et corrections

L'ouverture externe d'un fichier pouvait échouer avec un message affiché derrière la fenêtre d'aperçu. La reproduction initiale observe zéro alerte dans la fenêtre et une alerte dans le dossier sous-jacent. Le message et le nouvel essai sont maintenant accessibles dans la fenêtre. Une tentative en cours désactive le bouton, puis l'utilisateur peut réessayer.

Les PDF joints aux projets utilisaient un `iframe` qui déléguait toute la lecture au navigateur. Ils disposent maintenant d'un lecteur local commun : page précédente/suivante, zoom, ajustement à la largeur et texte de la page lorsqu'il est extractible. Les commandes restent visibles en portrait et paysage. Le nom complet reste le nom accessible de la fenêtre ; son affichage visuel est tronqué lorsqu'il est trop long. Les photos utilisent un aperçu adaptatif, avec une explication et l'ouverture externe si leur décodage est impossible.

La fermeture rend le focus au fichier sélectionné, y compris avec le comportement de clic de WebKit. Le nouvel essai d'un PDF invalide conserve le focus dans la fenêtre ; Échap reste utilisable. Quitter le dossier pendant la lecture d'un fichier ne crée plus une URL d'aperçu après le démontage du composant.

Une seule page PDF est dessinée à la fois. Le rendu est limité à quatre millions de pixels et 4096 pixels par côté ; les rendus abandonnés sont annulés, leurs surfaces libérées et le lecteur détruit à la fermeture. Le moteur existant PDF.js est réutilisé ; le composant de lecture est chargé à la demande. Les transitions respectent le mouvement réduit. Le fonctionnement suit les [exemples PDF.js](https://mozilla.github.io/pdf.js/examples/) et l'[annulation des rendus](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-RenderTask.html).

Le fichier original reste disponible pour téléchargement ou partage : les octets transmis au moteur sont une copie, car son worker peut transférer le tampon. Aucun document comptable ou justificatif n'est réécrit par l'aperçu.

## Vérifications

- 726 tests existants réussis, TypeScript et construction Vite de l'application réussis.
- Parcours Edge et WebKit à 320×568, 390×844, 844×390 et 1440×900 : rendu des vraies pages d'un PDF synthétique, couleurs distinctes, texte extrait, navigation, zoom, absence de débordement extérieur, commandes visibles, erreur externe puis nouvel essai, retour du focus, Échap, fermeture/réouverture et changements de page rapprochés.
- PDF endommagé et protégé par mot de passe : explication dans la fenêtre, ouverture externe disponible. PDF de 80 pages : première page accessible sans créer 80 surfaces de rendu. PNG réel : décodage vérifié. Image HEIC volontairement invalide : repli explicite.
- Le téléchargement du PDF est comparé octet par octet à l'original après lecture et nouvel essai. Les boutons mobiles sont testés avec la constante de compilation Android et une ouverture externe simulée.
- Le même lecteur est également compilé dans une fixture isolée et servi avec la CSP exacte de `tauri.conf.json`. Les parcours Edge/WebKit y vérifient l'absence d'erreur JavaScript et de violation CSP, y compris le chargement du worker PDF.

Les données de recette sont synthétiques. Ces contrôles de navigateur ne prouvent ni le partage natif sur téléphone physique, ni l'intégration de ce lecteur dans un paquet signé ; ces étapes restent à faire pour la prochaine publication. Aucune modification Rust, migration SQLite ou écriture dans les données utilisateur n'est incluse dans ce lot.

## Reproduction

`desktop/tests/project-files-harness.html` charge le composant de production avec une passerelle de fichiers isolée. Depuis le serveur Vite habituel, exécuter `node desktop/tests/project-files-journey.mjs` avec `ZENTRA_QA_ORIGIN` et, si nécessaire, `ZENTRA_PLAYWRIGHT_MODULE`. Utiliser `ZENTRA_QA_BROWSER=webkit` pour WebKit.

Pour la version compilée, démarrer `node desktop/tests/project-files-production.mjs`, puis lancer le même parcours avec `ZENTRA_QA_ORIGIN=http://127.0.0.1:5194` et `ZENTRA_QA_SUFFIX=-compiled-mobile`. Le mot de passe du PDF synthétique de test est `recette-locale` ; l'application n'essaie pas de le déchiffrer.

Rapports et captures locaux : `.qa/project-files-edge/`, `.qa/project-files-webkit/`, `.qa/project-files-edge-compiled-mobile/` et `.qa/project-files-webkit-compiled-mobile/`. La reproduction ciblée du message masqué est conservée dans `desktop/tests/project-files-error-repro.mjs`.
