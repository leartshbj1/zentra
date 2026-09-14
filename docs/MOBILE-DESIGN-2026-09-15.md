# Refonte mobile — 15 septembre 2026

Travail sur `codex/mobile-air-20260915`, depuis la version publiée 1.67.2. Les changements sont intégrés au code et compilés pour le web. Aucun nouvel installateur, APK ou IPA n’a été publié dans cette intervention.

## Principes et références

- [Apple — Layout](https://developer.apple.com/design/human-interface-guidelines/layout) : donner de la place aux informations essentielles, regrouper les éléments associés et révéler les détails progressivement.
- [Things — Features](https://culturedcode.com/things/features/) : listes simples, séparation claire des groupes et détails accessibles à la demande.

Application limitée aux écrans de 860 px ou moins. Les styles d’impression et les interfaces plus larges restent hors du périmètre.

## Changements

- Accueil propre au mobile : un montant à recevoir, un sélecteur de devise sans addition entre monnaies et des liens simples vers les factures, devis et projets. Les autres montants et l’explication du solde bancaire se déplient.
- Titres courts, aide sous forme d’icône, action principale visible et marges adaptées aux zones de sécurité du téléphone.
- Documents : aperçu direct, actions secondaires regroupées et nom du créateur accessible dans le détail. Aucun changement des permissions, des conversions ou des calculs.
- Projets : chiffres et planning repliables. Comptabilité : sélecteurs plus compacts, résultat prioritaire, définitions à la demande ; les avertissements restent visibles.
- Paie et collaborateurs : en-têtes des assistants allégés, import regroupé, document justificatif consultable à la demande. Les explications d’erreurs et les boutons de correction sont conservés.
- Paramètres sous forme de liste simple ; assistant plus discret ; transitions brèves respectant la réduction des animations.
- Nouveaux libellés fournis en français, allemand, italien et anglais. Ce travail ne constitue pas un audit exhaustif des traductions historiques de l’application.

## Vérifications

- TypeScript et build Vite réussis. Le build garde les avertissements existants concernant la taille de certains bundles.
- `tests/mobile-air-journey.mjs` : 58 combinaisons écran / langue / format vérifiées et deux parcours d’actions sur Chromium et WebKit (60 résultats). Les 14 rubriques sont parcourues dans les deux moteurs ; essais complémentaires à 320 px, 390 px et en paysage à 844 px, selon la langue.
- Aucun débordement de page ou de contrôle détecté dans ces scénarios ; couleurs identiques après clair → sombre → clair.
- Quatre vérifications ciblées supplémentaires : aperçu, modification, boutons d’action traduits, grands montants, définitions et séparation des devises.
- `tests/payroll-clear-path-journey.mjs` : six cas réussis, dont corrections d’assurance, reprise après erreur de lecture et conservation de la saisie.
- `tests/employee-wizard-journey.mjs` : huit cas réussis, dont erreur d’enregistrement, nouvelle tentative et intégrité du formulaire. Le test suit désormais le message simplifié puis son détail ; il utilise l’instance simulée du harnais pour résister au rechargement Vite.
- `tests/touch-team-journey.mjs` : balayage, annulation de geste, zoom document / image / PDF et zones de sécurité réussis dans les deux moteurs à 320, 390 et 844 px.
- Comparaison pixel à pixel des six captures ordinateur à 1440 px : accueil, devis, projets, comptabilité, équipe et paramètres identiques au point de départ.
- Aperçu interactif vérifié : `tests/mobile-air-preview.html`. Ce fichier et le harnais utilisent uniquement des données fictives et ne sont pas les points d’entrée du build de production.

Les captures et rapports détaillés sont sous `.qa/mobile-air` et `desktop/.qa/mobile-air`. Ces essais ne remplacent pas un essai de la future compilation native sur un iPhone physique.
