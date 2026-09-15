# Zentra 1.71.1 — mode sombre harmonisé et réception discrète

## Correction

Sur mobile et ordinateur, les panneaux, en-têtes et sous-cartes du mode sombre sont séparés par des espacements et fonds distincts. Les icônes des paramètres suivent une palette neutre uniforme. Les menus sélectionnés utilisent un fond gris neutre et un accent vert limité à l’icône, sans cumul de rectangles verts. Le survol des rubriques est réservé aux appareils qui le prennent en charge. Les champs restent distincts des cartes qui les contiennent.

Le panneau plein écran, l’assombrissement et l’animation de chargement de la réception des données ont été supprimés. La page actuelle reste affichée et ses montants sont actualisés à réception. Le téléchargement et la préparation restent en arrière-plan.

La protection contre les écritures sur l’ancienne copie est conservée pendant le remplacement local final et le rafraîchissement React. Elle est activée avant l’appel natif et libérée après succès ou erreur, sans afficher de panneau. Le focus de recherche est rétabli sans faire défiler la page. Les formulaires actifs continuent de différer la réception.

Les notes de version sont disponibles en français, allemand, italien et anglais. Les anciennes règles CSS du panneau ont été retirées des deux thèmes.

## Vérification

- Construction web et TypeScript réussis.
- 19 tests ciblés réussis : cadence de synchronisation, notifications et notes de version.
- Quatre parcours sur Chromium et WebKit, bureau 1280 px et mobile 390 px : réception automatique d’une facture puis d’un paiement, protection du formulaire, absence de panneau durant une réception volontairement retardée, conservation de la page et du contenu de recherche, récupération du focus après succès et après interruption.
- Réception automatique de la facture en 2,78 à 2,95 secondes dans ces parcours avec transport natif synthétique. Aucun essai physique iPhone ou Android revendiqué.
- Preuves locales : `.qa/company1711/proof.json` et captures dans le même dossier.

## Publication

Publication explicitement confirmée par l’utilisateur avec les améliorations du mode sombre. La commande du tour précédent n’avait pas été exécutée après le refus automatique. Ne pas annoncer 1.71.1 disponible avant compilation, signature, vérification et publication des artefacts correspondants.
