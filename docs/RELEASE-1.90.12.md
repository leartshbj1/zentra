# Zentra 1.90.12 — Refonte des interfaces

Préparation du 1er octobre 2026. Cette version reprend la refonte frontend du commit `46feb8e0` : présentation commune des menus, formulaires, réglages et écrans métier ; thèmes clair et sombre harmonisés ; navigation et gestes mobiles ; transitions respectant la réduction des animations. Le module Notes de 1.90.11 est conservé.

Les versions package, Cargo, lockfile et Tauri passent à 1.90.12. L’historique embarqué décrit le changement en français, allemand, italien et anglais. Aucun nouveau comportement serveur, changement de schéma, calcul métier ou fonction d’Automation n’est annoncé dans ce lot.

## Validation du frontend

- Suite locale sur la refonte : 1 917 tests réussis et un test préexistant ignoré ; TypeScript et build frontend réussis.
- Préparation 1.90.12 : les 7 tests d’historique et de contrat updater passent ; les quatre fichiers de version concordent et `git diff --check` réussit.
- Contrôles de présentation : 288 cas de menus Edge, 72 cas WebKit, 135 cas de réglages ; essais des formulaires, assistants devis/factures, Notes, agenda, rapports et configuration initiale.
- Navigation, focus, marges mobiles, gestes et réduction des animations contrôlés dans les recettes frontend. Ces essais ne valent pas une validation sur iPhone ou Mac physiques.
- Les preuves de refonte sont décrites dans `desktop/.impeccable/apple-design-review-20261001.md` et conservées localement dans `desktop/outputs/apple-redesign`.

## Publication

Les paquets Windows, macOS, iPhone et Android doivent être compilés depuis le commit gelé de cette préparation, puis contrôlés avant d’être publiés. Ce document de préparation n’atteste pas encore leur compilation, leur disponibilité ni une mise à jour du site.

La distribution suit les canaux existants : installateur Windows, paquet macOS, IPA iPhone et APK Android. La signature updater est distincte d’Authenticode, de la notarisation Apple et d’une publication App Store ou Google Play. Les résultats natifs et les liens publics seront consignés après vérification.
