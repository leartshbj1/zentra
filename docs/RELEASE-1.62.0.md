# Zentra 1.62.0 — publication en cours

## Contenu

Atelier de documents plus spacieux, outils de mise en page et aperçu. Choix de langue au premier démarrage et dans les paramètres : français, allemand, italien, anglais. Configuration, navigation HTML, tutoriel, collaborateurs, fiches de salaire et réglages de paie traduits avec conservation des brouillons et corrections guidées.

La traduction intégrale reste en préparation : certains écrans métier, messages natifs inconnus, contrôles Apple et PDF restent en français. Le sélecteur l’indique. Aucun taux légal n’est modifié par la traduction.

## Windows

Version 1.62.0, identifiant historique et schéma 59 conservés. Compilation locale terminée, signature Tauri produite. 1 483 tests d’interface passent dans les sources de publication. Le build TypeScript/Vite passe. Les parcours de réglages sont vérifiés en Edge et WebKit dans les quatre langues à 320, 390, 844 et 1 440 pixels, avec données synthétiques.

Six essais isolés du programme exact du paquet passent : premier lancement, redémarrage, création et lecture d’un profil 1.61, remplacement par 1.62 et redémarrage. Intégrité SQLite, pièces jointes, identité protégée, séquences et écritures équilibrées sont conservées. Une première tentative de recette a révélé que le vérificateur n’autorisait pas encore la création d’un jeu de données 1.61 ; sa liste a été complétée puis les essais repris dans de nouveaux profils. Le programme distribué n’a pas changé.

Ces essais ne lancent pas NSIS et ne prouvent pas une installation client. Pas de signature Authenticode. Les améliorations de langue et d’atelier ne modifient pas le moteur natif publié en 1.61.

## Apple

Compilation prévue sur les Mac M2 du compte individuel Codemagic, sans facturation activée, à partir du dépôt public. macOS : paquet universel Intel/Apple Silicon avec signature ad hoc, sans notarisation Apple. Signature de mise à jour Tauri effectuée localement après vérification des fichiers téléchargés. iPhone : IPA ARM64 sans signature Apple de distribution, destiné à Sideloadly/AltStore.

L’éventuel exemplaire iPhone personnel reste séparé du paquet public ; aucune licence propriétaire ne doit être publiée sur le canal client. Voir les preuves finales de livraison pour connaître les plateformes effectivement disponibles.
