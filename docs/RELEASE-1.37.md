# Zentra 1.37 — interface et documents repensés

Version publiée et vérifiée le 6 septembre 2026 : [téléchargements](https://elyko.alb-leart1.chatgpt.site/download), canal signé Windows/macOS et [douze fichiers GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.37.0). Les lots 1.34 et 1.36 restent non publiés.

La refonte conserve les verts et accents ambrés de Zentra. Elle modernise la navigation, les cartes, les formulaires et les dossiers de facturation sur ordinateur et mobile. Les transitions sont courtes, sans bibliothèque d'animation supplémentaire, et respectent le réglage système de réduction des animations.

Les aperçus de devis et factures disposent d'un mode Lecture pour les petits écrans, d'un mode Mise en page, du zoom et d'un accès direct aux totaux. Les documents longs restent consultables jusqu'aux coordonnées et au QR de paiement. Les brouillons peuvent être prévisualisés sans être émis. Le retour du focus à la fermeture a été corrigé sous WebKit. Le moteur natif du PDF et les montants des documents sont conservés.

Les avoirs fournisseurs peuvent être remboursés totalement ou partiellement, dans la limite du solde partagé avec les compensations. Depuis Banque, un crédit camt.053 peut être associé à un remboursement existant ou créer le remboursement avec son justificatif. Une reprise ne crée pas une seconde écriture ; une dissociation du relevé conserve le paiement, les pièces et l'historique. Le schéma 52 conserve ces événements et leurs preuves dans les sauvegardes, les CSV et le dossier comptable. Les migrations n'inventent ni paiement ni rapprochement.

## Vérifications

- 702 tests d'interface ; suite native Windows complète de 556 succès et un test ignoré, puis dix tests bancaires ciblés incluant un test d'export supplémentaire. TypeScript, construction de production et Clippy sans avertissement réussis.
- Huit parcours de refonte et de documents longs sous Edge et huit sous WebKit, aux largeurs 320, 390, 768 et 1440 px : navigation, lecture, mise en page, QR, zoom, focus, réduction des animations et reprise de l'export simulé. Huit parcours de dossiers acompte/solde et huit de remboursements bancaires réussis. Les réponses natives du navigateur sont simulées ; SQLite, les fichiers réels et les exports sont contrôlés séparément.
- Windows : binaire empaqueté, ouvertures et rechargements, fermeture/réouverture, puis interrogation réelle du canal public 1.37. Le passage d'une base de test 1.35 au schéma 52 conserve identité, client, projet et PDF lié, avec intégrité et clés étrangères vérifiées après la fermeture finale. Le remplacement complet par l'installateur NSIS n'est pas couvert par ce contrôle.
- [macOS](https://github.com/leartshbj1/zentra/actions/runs/34005933063) : 558 tests natifs réussis, un ignoré ; 702 tests d'interface et Clippy réussis. Les octets de l'archive universelle Intel/Apple Silicon, la signature de mise à jour, la version, la clé et le canal embarqués ainsi que le démarrage réel au schéma 52 sont vérifiés.
- Android : [seize démarrages](https://github.com/leartshbj1/zentra/actions/runs/34005636027) et [mise à jour 1.35 vers 1.37](https://github.com/leartshbj1/zentra/actions/runs/34005634547) avec les APK x86_64 compagnons exacts, déjà signés avec le certificat persistant. Client, projet, fichier et identité conservés. L'APK distribué est ARM64 ; la mise à jour physique ARM64 n'a pas été exercée.
- [iOS](https://github.com/leartshbj1/zentra/actions/runs/34005366989) : archive ARM64 exacte, accueil, relance de l'application et redémarrage du simulateur, identité conservée et base intègre. Les captures des trois phases ont été inspectées.
- Douze fichiers du canal public comparés octet par octet aux fichiers locaux ; douze fichiers GitHub vérifiés par taille et empreinte. Le cache du canal a d'abord servi 1.35 : la vérification finale a attendu 1.37 sur les URL ordinaires, sans paramètre de contournement du cache.
- Site version 56, source `7f45b9ad77c2ac8c493511cdbf13e1d5d0cf323c`, déploiement `appgdep_6a9cd585f4d48191b0ad79cd40b4cb1d`. Accès public inchangé à la révision 2. Liens, menus tactiles, retour du focus et absence de débordement ou d'erreur JavaScript contrôlés aux quatre largeurs ; captures relues.

Windows et les préversions mobiles utilisent `b5c59274d1f82aefe2369a7d660063a94921586d`. macOS utilise `c9bf2cb44fed515bc6f292b578c9501fc2f7147d`, dont la seule différence est la canonicalisation d'un chemin temporaire dans un test. Le code de production est identique. Preuve consolidée locale : `.qa/release-1.37-verified.json`.

## Limites et suite de l'audit

Android reste un APK de test, iOS une archive pour simulateur non installable directement sur iPhone. Aucune publication App Store/Google Play, recette sur téléphone physique, mise à jour mobile automatique ou synchronisation entre appareils n'est annoncée. Les signatures de mise à jour ne remplacent pas Authenticode ou la notarisation Apple ; le démarrage macOS ne constitue pas une recette interactive complète de son interface.

L'audit général reste actif. Le prochain parcours identifié est le règlement daté des avoirs clients : leur imputation, remboursement, historique et ventilation en TVA reçue restent à compléter. Les blocages explicites du décompte reçu sont conservés tant que ce parcours n'est pas implémenté et vérifié.
