# Zentra 1.40.0

Les devis et factures se préparent désormais en quatre étapes, avec un récapitulatif avant enregistrement. Le retour entre étapes conserve la saisie et les erreurs ramènent au champ concerné. Le thème et les menus ont été allégés sur ordinateur et mobile ; les transitions respectent la réduction des animations de l’appareil.

Cette version reprend le lecteur de pièces jointes PDF et photo ainsi que les protections d’interface en lecture seule de la candidate 1.39.0, qui n’a pas été publiée. Le lecteur PDF utilise un moteur de compatibilité partagé et garde son interface accessible si une API requise manque.

Validation de l’interface : 726 tests UI, compilation TypeScript/Vite, parcours guidés Edge/WebKit à quatre tailles, parcours complet de projet, éditions en EUR et filtres de ventes. Voir `AUDIT-DESIGN-GUIDE-2026-09.md`.

Le schéma de données reste à 57. Les paquets natifs, leurs signatures et leurs contrôles de démarrage doivent être vérifiés avant publication. Android reste une préversion APK et iOS une archive pour simulateur ; cette version ne revendique aucune publication dans les boutiques mobiles.
