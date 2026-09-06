# Zentra 1.40.0

Les devis et factures se préparent désormais en quatre étapes, avec un récapitulatif avant enregistrement. Le retour entre étapes conserve la saisie et les erreurs ramènent au champ concerné. Le thème et les menus ont été allégés sur ordinateur et mobile ; les transitions respectent la réduction des animations de l’appareil.

Cette version reprend le lecteur de pièces jointes PDF et photo ainsi que les protections d’interface en lecture seule de la candidate 1.39.0, qui n’a pas été publiée. Le lecteur PDF utilise un moteur de compatibilité partagé et garde son interface accessible si une API requise manque.

Validation de l’interface : 726 tests UI, compilation TypeScript/Vite, parcours guidés Edge/WebKit à quatre tailles, parcours complet de projet, éditions en EUR et filtres de ventes. Voir `AUDIT-DESIGN-GUIDE-2026-09.md`.

Le schéma de données reste à 57. Les six workflows de construction et de recette ont réussi depuis le commit `f4df64017730518295546811b934fd7ca73216e3`, dont les tests Rust complets et Clippy. Windows conserve le profil de démonstration et ses pièces jointes après redémarrage ; le paquet Mac universel démarre avec une base SQLite intègre.

La mise à niveau Android de 1.38 à 1.40 est vérifiée sur émulateur avec les APK x86_64 signés existants, sans nouvelle signature du paquet précédent. L’identité, les données et la pièce jointe sont conservées. Les trois démarrages iOS complémentaires affichent l’accueil ; la capture initiale vide reste conservée et n’a pas été reproduite pendant cette recette.

Android reste une préversion APK et iOS une archive pour simulateur. Les essais ne prouvent pas une installation sur téléphone physique, le remplacement par l’installateur Windows, une notarisation Apple ou une publication dans les boutiques mobiles.

Les douze fichiers du canal stable ont été téléchargés publiquement et comparés octet par octet au lot validé. Les signatures Tauri/Ed25519 Windows et Mac sont valides. Le [lot GitHub 1.40.0](https://github.com/leartshbj1/zentra/releases/tag/v1.40.0) est publié avec douze pièces jointes vérifiées ; les deux téléchargements mobiles anonymes correspondent également aux fichiers testés. Le manifeste stable annonce 1.40.0 pour Windows et Mac.
