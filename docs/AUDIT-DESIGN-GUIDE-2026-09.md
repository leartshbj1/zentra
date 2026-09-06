# Parcours guidé et interface — 6 septembre 2026

## Résultat

La création et la modification des brouillons de devis et factures suivent quatre étapes : client et projet, prestations, conditions, vérification. Revenir en arrière conserve les champs, les lignes, les notes et le texte de bas de page. Aucun document n’est enregistré avant la validation finale ; l’ajout explicite d’un nouveau contact et l’enregistrement explicite d’un modèle de texte gardent leur comportement propre.

Chaque changement d’étape vérifie les champs nécessaires. Un saut vers une étape ultérieure s’arrête sur le premier champ manquant. La validation finale contrôle à nouveau les étapes précédentes. Les documents émis et les brouillons verrouillés depuis une commande restent en consultation. Une révocation du droit d’écriture conserve le brouillon affiché et bloque sa sauvegarde.

Le thème conserve le vert et l’ambre, avec des surfaces plus neutres, moins de cadres, une typographie plus légère et des actions mobiles resserrées. Les entrées de page durent 440 ms et celles des étapes 380 ms, sans délai d’interaction. La préférence système de réduction des animations désactive ces mouvements. Aucun moteur d’animation supplémentaire n’est ajouté.

L’écran de vérification présente les données du brouillon, ses prestations et ses totaux. L’aperçu PDF existant reste accessible après enregistrement. Les styles d’écran ne modifient pas les documents exportés.

## Vérifications locales

- 726 tests UI réussis et compilation TypeScript/Vite réussie.
- Parcours du nouvel assistant dans Edge et WebKit, aux tailles 320 × 568, 390 × 844, 844 × 390 et 1440 × 900 : validations, conservation de la saisie, nouveau contact, lecture seule, animations et réduction des animations.
- Devis de 270,25 CHF ; acompte de 30 % avec une base conservée et un total de 81,08 CHF ; avoir lié conservant l’EUR et refusant une date antérieure à la facture originale. Vérification des arguments transmis au pont applicatif, sans prétendre à une écriture native dans cette recette navigateur.
- Parcours existant projet → pièce jointe → devis → facture, filtres, navigation entre les modules et clavier : 120 captures, aucun débordement signalé.
- Édition des devis et factures en EUR, recherche par référence bancaire, filtres de statut et listes réactives : réussi.
- Actions en lecture seule : réussi dans Edge et WebKit aux quatre tailles.

Recettes reproductibles : `desktop/tests/document-wizard-journey.mjs`, `workspace-journey.mjs`, `sales-browsing-journey.mjs` et `read-only-actions-journey.mjs`. Rapports et captures locaux sous `.qa/` ; données de démonstration exclusivement.

## Compatibilité du lecteur PDF

L’absence de `Promise.withResolvers` reproduisait un écran vide lors de l’ouverture d’une pièce jointe PDF. Le lecteur, les aperçus PDF locaux et l’extraction des fiches de salaire partagent désormais l’API et le worker PDF.js legacy. La construction du lecteur est protégée contre les exceptions synchrones : une API toujours absente laisse les commandes du lecteur et le dossier du projet accessibles.

Les recettes Edge et WebKit sans `Promise.try` rendent les pages, y compris les gros documents, sans erreur JavaScript. Dans les deux moteurs, l’absence de `Promise.withResolvers` vérifie le repli local « Aperçu indisponible » et le retour au dossier. Les huit parcours du lecteur compilé avec la politique CSP de production réussissent également. Cela ne constitue pas une certification de toutes les anciennes versions iOS : [le support PDF.js reste lié aux versions de navigateur annoncées par le projet](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#faq-support).

## Portée de publication

Le lot 1.39.0 préparé avant cette demande est retenu et ne doit pas être publié. La version 1.40.0 a été reconstruite depuis `f4df64017730518295546811b934fd7ca73216e3`. Les six workflows de construction et de recette sont réussis, avec les tests Rust et Clippy sur Mac, le démarrage du paquet universel, les contrôles Android et les trois relances iOS complémentaires. Les résultats navigateur et simulateur ne prouvent ni une installation sur téléphone physique, ni une publication App Store ou Google Play.
