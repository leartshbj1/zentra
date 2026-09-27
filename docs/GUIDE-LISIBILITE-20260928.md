# Guide de prise en main — lisibilité et navigation

Contrôle du 28 septembre 2026. Source postérieure à 1.90.6, non publiée.

## Corrections

À 320 px et avec le texte agrandi à 200 %, l’en-tête et les commandes pouvaient réduire l’explication à une zone presque invisible. Le guide entier défile désormais dans cette situation, ainsi qu’en paysage peu haut. Les titres et mots longs restent dans la carte ; les commandes restent accessibles. Le titre allemand des contacts est raccourci sans changer son sens.

Le changement d’étape revient au début de la carte. La fermeture replace le focus sur le bouton d’ouverture ; sur mobile, elle revient au bouton Menu lorsque le panneau latéral a été refermé. La cible explicite couvre WebKit, où cliquer sur le bouton ne lui donne pas nécessairement le focus.

Le contenu métier et les étapes sont conservés. Aucun compte, document ou mécanisme de synchronisation n’est modifié.

## Vérifications et limites

- 16 tests ciblés réussis dans trois fichiers : guide, rapport et couverture des traductions. TypeScript réussi.
- Build final réussi après la correction du dernier mot allemand trop long. L’avertissement préexistant sur certains blocs JavaScript supérieurs à 500 ko demeure.
- 14 configurations distinctes : Chromium et WebKit ; FR/DE/IT/EN ; clair/sombre ; 320, 390, 844 et 1 440 px ; tailles de texte 100 % et 200 %. Chaque parcours couvre trois étapes automatiques et seize étapes complètes, soit 266 étapes contrôlées avec succès.
- Précision : la matrice complète a donné 12 réussites sur 14. Les deux configurations allemandes à 320 px / 200 % ont ensuite réussi lors d’un contrôle ciblé après la dernière correction CSS. La matrice entière n’a pas été répétée après celle-ci.
- Paragraphes et commandes atteignables par défilement, absence de débordement horizontal, arrière-plan inactif pendant le dialogue, reprise à l’étape mémorisée, fermeture par Échap et retour du focus vérifiés. Cinq captures finales ont été relues.

Ces essais utilisent les composants de l’application avec des données et commandes natives simulées ; les accès réseau externes sont bloqués. Le défilement contrôlé par le navigateur ne prouve pas un geste tactile sur appareil physique. Aucun lecteur d’écran ni binaire installé n’est validé par ce lot.

## Preuves reproductibles

- `desktop/tests/guide-readable-journey.mjs`
- `desktop/.qa/guide-readable/report.json` : matrice de 14 configurations, dont les deux échecs diagnostiqués.
- `desktop/.qa/guide-readable-german-final/report.json` : les deux confirmations finales.
- `desktop/.qa/guide-readable-final-unit.log`, `guide-readable-final-build.log`.
- Captures dans `desktop/.qa/guide-readable/` et `guide-readable-german-final/`.

Ne pas remplacer les paquets publics 1.90.6 par une reconstruction du même numéro : une livraison ultérieure devra regrouper ces changements sous une nouvelle version.
