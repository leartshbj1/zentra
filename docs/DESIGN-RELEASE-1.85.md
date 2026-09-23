# Zentra 1.85 — contrôle du nouvel espace de travail

## Périmètre

Refonte partagée de l’interface de Gestion : rail de navigation, accueil, tableaux, paramètres, Automation et formulaires. Les couleurs d’impression, calculs financiers, droits et mécanismes de synchronisation sont conservés. Le journal complet reste le premier écran d’Automation ; l’accueil présente les finances puis un résumé compact.

Références étudiées : [Apple macOS](https://www.apple.com/os/macos/), [Things](https://culturedcode.com/things/) et [la refonte de Linear](https://linear.app/now/behind-the-latest-design-refresh). Les principes retenus sont une hiérarchie claire, des listes continues, peu de couleurs concurrentes et des détails accessibles à la demande.

## Contrôles effectués

- 1 630 tests d’interface réussis, aucun échec. Après les derniers changements du formulaire et du résumé Automation : 18 tests ciblés réussis. TypeScript sans erreur.
- Quinze destinations principales contrôlées dans quatre configurations : ordinateur clair/sombre à 1 440 pixels, mobile sombre à 390 pixels et mobile clair allemand à 320 pixels. Douze rubriques de paramètres parcourues. Aucun débordement horizontal de page détecté ; les en-têtes masqués pour l’accessibilité et les conteneurs volontairement défilants sont exclus.
- Contrôle ciblé de contraste sur les textes rendus, sans anomalie relevée. Ce contrôle ne constitue pas une certification d’accessibilité.
- Devis fictif : validation des champs, focus sur l’unité manquante, deux lignes de notes, enregistrement, tri du nouveau document en tête. 2 × 125.50 CHF, TVA 8.1 % : total 271.33 CHF.
- Revue visuelle indépendante : formulaire trop dense à 320 pixels corrigé. Conseils et catalogue en panneaux dépliables, premier champ visible sans défiler, pied fixe, un seul défilement interne. Le fond de page est bloqué pendant l’ouverture et retrouve son comportement à la fermeture.
- Automation sombre recapturée après stabilisation : textes principaux rgb(243,243,245), opacité des ancêtres égale à 1, aucun filtre. Les deux corrections matérielles ont été jugées résolues par le relecteur.

Le moteur métier avait été vérifié dans l’audit précédent, au commit parent : 754 tests natifs, un test TLS supplémentaire et 1 475 cas serveur distincts réussis. Les limites et les cas non exécutés sont détaillés dans `QUALITY-AUDIT-2026-09-23.md`. Cette refonte n’en modifie pas le code.

## Limites et livraison

Les captures utilisent le frontend réel avec des données fictives. Elles ne prouvent pas le comportement d’un appareil physique, ni une charge de production ou un paiement réel. Les preuves de compilation, de démarrage des paquets, de signature et de publication sont conservées séparément dans `outputs/release185/`. Aucun résultat ne garantit l’absence absolue de bugs.
