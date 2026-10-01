# Zentra 1.90.12 — Refonte des interfaces

Publication du 1er octobre 2026. Cette version reprend la refonte frontend du commit `46feb8e0` : présentation commune des menus, formulaires, réglages et écrans métier ; thèmes clair et sombre harmonisés ; navigation et gestes mobiles ; transitions respectant la réduction des animations. Le module Notes de 1.90.11 est conservé.

Les versions package, Cargo, lockfile et Tauri passent à 1.90.12. L’historique embarqué décrit le changement en français, allemand, italien et anglais. Aucun nouveau comportement serveur, changement de schéma, calcul métier ou fonction d’Automation n’est annoncé dans ce lot.

## Validation du frontend

- Suite locale sur la refonte : 1 917 tests réussis et un test préexistant ignoré ; TypeScript et build frontend réussis.
- Préparation 1.90.12 : 25 tests ciblés d’historique, contrat updater, mouvements et navigation passent ; les quatre fichiers de version concordent et `git diff --check` réussit.
- Contrôles de présentation : 288 cas de menus Edge, 72 cas WebKit, 135 cas de réglages ; essais des formulaires, assistants devis/factures, Notes, agenda, rapports et configuration initiale.
- Navigation, focus, marges mobiles, gestes et réduction des animations contrôlés dans les recettes frontend. Ces essais ne valent pas une validation sur iPhone ou Mac physiques.
- Les preuves de refonte sont décrites dans `desktop/.impeccable/apple-design-review-20261001.md` et conservées localement dans `desktop/outputs/apple-redesign`.

## Publication

Les quatre paquets sont publiés dans [Zentra 1.90.12](https://github.com/leartshbj1/zentra/releases/tag/v1.90.12), avec 12 fichiers et leurs empreintes contrôlées. Le tag pointe sur la source produit gelée `9c1631ec9516d7807a7ba96ce41ef713c27b9c12`.

| Plateforme | Compilation et recette du paquet | Résultat |
| --- | --- | --- |
| Windows x64 | CircleCI 206 ; lancement/relancement 208 | Installateur exact, provenance, icônes et signature updater contrôlés ; profil isolé, SQLite schéma 61, intégrité OK. |
| macOS universel | CircleCI 211 ; recette intégrée | arm64/x86_64, lancement/relancement et codesign ad hoc réussis ; archive exacte et signature updater contrôlées. |
| iPhone arm64 | CircleCI 211 | IPA iPhoneOS, version/source/icônes contrôlées ; cinq tests natifs UIKit/LiquidGlass réussis sur simulateur. |
| Android arm64 | CircleCI 207 ; recette émulateur 210 | Thèmes, clavier et relancement contrôlés ; identité locale conservée ; APK final signé avec le certificat persistant, aligné 16 Ko et 964 entrées du payload inchangées. |

Le pipeline Apple `5a34a14db0e5d84e3b97dbee56d671d94f09ebe7` remplace uniquement la recette d’apparence devenue obsolète. Les sources runtime et tous les paquets restent ceux de `9c1631…` ; `VERIFIER-SOURCE.txt`, patch et provenance le consignent. Les vérificateurs des recettes Windows/Android sont respectivement `53107897ce17272634472e3c5009009561b8d092` et `edd7f4aadf565ee9f18c3a773473f7622396fcd2`. La recette Android emploie un certificat jetable d’émulateur ; les octets du payload non signé correspondent au candidat qui a ensuite reçu le certificat persistant de distribution.

Les correctifs des recettes d’apparence et de lecture du schéma Android sont conservés séparément sur la branche de preuves pour les compilations futures. Ils ne changent pas la source produit du tag publié.

## Site et mises à jour

- [Téléchargements Zentra](https://zentraapp.ch/download) : quatre liens actifs 1.90.12 vérifiés anonymement, fichiers HTTP 200 et tailles exactes.
- Site **308**, source poussée `c43077abd7b40f3d14cc1fb82e0b70b2fafa1977`, déploiement `appgdep_6abe421e66248191a8c2bd5ed152b63b` **succeeded**. La refonte web du site 307 est conservée ; seuls les liens, le manifeste et une phrase Notes ont changé.
- Les canaux `/updates/latest.json`, `/updates/latest-windows.json` et `/updates/latest-macos.json` servent 1.90.12, avec les signatures et URL exactes et `Cache-Control: no-store`. Un canal inconnu répond 404 sans cache.
- 14 tests de téléchargements/canaux, TypeScript, contrôle des logos et build du site réussis avant déploiement.
- Preuves locales dans `outputs/release1912` : téléchargements CI et provenances, vérifications natives/signatures, `github-published-proof.json`, `public-head-proof.json`, `site-publication-proof.json`, `site-live-proof.json` et `update-channel-live-proof.json`. Les gardes de publication ont également passé 20 fixtures de refus/acceptation ; ces fixtures ne sont pas des preuves de livraison.

## Limites de distribution

Windows reste sans Authenticode ; la signature updater vérifie le paquet de mise à jour, sans certification Microsoft. Mac est signé ad hoc et non notarié. L’IPA est non signée et doit être re-signée pour installation avec Sideloadly ou AltStore. L’APK conserve le certificat de préversion existant. Aucun App Store ou Google Play n’est publié dans ce lot.

Les recettes cloud et simulateurs ne constituent pas un essai sur téléphone physique, ni une certification de chaque intégration, donnée métier, paiement ou synchronisation entre comptes de production. La refonte et cette release n’ajoutent aucun changement serveur ou de règles métier.
