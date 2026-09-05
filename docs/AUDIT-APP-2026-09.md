# Audit fonctionnel et mobile — septembre 2026

Objectif actif : vérifier les parcours de Zentra sur ordinateur et mobile, corriger les erreurs observées et préparer une mise à jour commune. Ce document suit le travail ; il ne constitue pas une déclaration de conformité ni une recette complète de toutes les fonctions.

## Lot en cours après la publication 1.27.0

Les améliorations ci-dessous sont dans le code en cours de validation. Les installateurs et le site publiés restent en version 1.27.0 jusqu'à la prochaine publication vérifiée.

- Ventes : filtres par état, solde à encaisser et retard calculé après paiements et avoirs ; recherche par référence bancaire avec espaces ; recherche textuelle tolérant les accents et espaces multiples.
- Listes : ordre récent conservé, pagination de 25 documents et remise à la première page après changement de recherche ou d'état. Cartes mobiles en deux colonnes et boutons tactiles de 44 px.
- Devises : le brouillon conserve sa devise à l'enregistrement ; montants des listes, dossiers, formulaires, paiements et aperçus affichés dans la devise du document. Tableau de bord et dossier client séparent les totaux par devise. Les projets présentent les recettes par devise et suspendent la marge CHF lorsqu'une conversion justifiée manque.
- Éditeur : les projets proposés appartiennent au client sélectionné ; changer de client retire l'ancien projet. Un avoir reprend les coordonnées de rattachement et la devise de sa facture originale. Les prix CHF du catalogue ne sont pas recopiés automatiquement dans un document en devise étrangère.
- Achats : sélecteur mobile donnant accès aux cinq sections ; résumé en deux colonnes ; intitulé du parcours simplifié. Navigation au clavier conservée sur ordinateur.

## Preuves locales

Environnement : Windows, Edge headless, largeurs 320, 390, 768, 1024 et 1440 px. Données de recette fictives et fonctions natives simulées dans le navigateur, complétées par les tests du moteur Rust sur de vraies bases SQLite temporaires.

| Contrôle | Preuve |
| --- | --- |
| Moteur natif existant : ventes, stock, achats, banque, paie, TVA, clôture, sauvegardes et documents | `cargo test --lib` : 451 tests réussis, 0 échec, 1 ignoré ; `.qa/audit-128-native.log` |
| Interface et logique TypeScript | `pnpm --dir desktop test:ui` : 568 tests réussis / 83 fichiers ; `.qa/audit-128-ui-final.log` |
| Navigation dans les 16 modules et 7 catégories de paramètres ; projet, fichier, devis et facture | `desktop/tests/workspace-journey.mjs` : 120 captures ; `.qa/design/report.json` |
| TVA, références, ordre des documents, action d'export PDF et classification d'un achat | `desktop/tests/finance-journey.mjs` : 28 captures ; `.qa/finance/report.json` |
| Recherche de référence, filtres, devis/facture EUR enregistrés, projet lié au client, avoir lié, pagination de 80 factures | `desktop/tests/sales-browsing-journey.mjs` ; `.qa/sales/report.json` |
| Sept formulaires de création, cinq sections achats et maintien du focus dans les dialogues | `desktop/tests/forms-journey.mjs` : 60 captures ; `.qa/forms/report.json` |

Les tests navigateur vérifient le parcours UI et les paramètres transmis aux fonctions simulées. Ils ne prouvent pas l'accès à une banque réelle, l'envoi d'un e-mail, une publication sur les stores ou une synchronisation entre appareils. Les modifications de ce lot n'ont pas encore été exécutées dans de nouveaux binaires natifs Windows/macOS/iOS/Android.

## Points encore ouverts dans l'audit

1. **Cohérence de la TVA non déductible avec le bilan.** `supplier_invoices.rs` comptabilise la TVA de la facture au compte de TVA préalable lors de la validation ; `accounting.rs::post_expense_if_enabled` fait de même pour les dépenses. `vat_reporting.rs` exclut correctement une source classée `non_deductible` du décompte, mais `set_vat_source_classification` ne passe pas d'écriture corrective. La reclassification comptable manuelle décrite dans le guide 1.27 reste donc nécessaire. Préparer une correction native atomique et auditée, y compris lorsque la classification change après la comptabilisation, avant d'annoncer cette opération automatique.
2. **Contre-prestations reçues.** Le moteur bloque les allocations partielles ou sur plusieurs périodes qu'il ne sait pas justifier (`received_mode_blocks_cross_period_payment_allocation`). Examiner les allocations par taux et les corrections avant d'élargir le calcul. Ne pas retirer le blocage sans modèle et tests comptables.
3. **Avoirs fournisseurs avec TVA.** Le décompte signale encore `unsupported_supplier_credit_tax`. Vérifier la date fiscale, l'imputation et l'extourne pour automatiser ces cas sans double déduction.
4. **Parcours de gestion avancés.** Les tests natifs couvrent les commandes, livraisons, récurrences, rapprochements, paie et clôture. Compléter les essais UI avec des documents actifs, des erreurs et des reprises de ces parcours ; les seules vues vides et ouvertures de formulaires ne suffisent pas à conclure.
5. **Diffusion.** Préparer les binaires signés pour l'updater, vérifier les artefacts Windows/macOS et les démarrages mobiles, puis publier le lot stabilisé. L'adhésion Apple Developer et le compte Google Play restent distincts de cet audit du logiciel.

## Références produit

La distinction entre factures ouvertes, paiements identifiés et opérations à vérifier s'appuie sur les parcours décrits par [Bexio Banking](https://www.bexio.com/fr-CH/banking) et la [documentation officielle du rapprochement bancaire Odoo 19](https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/reconciliation.html), consultées le 5 septembre 2026. Ces références orientent l'organisation des écrans ; elles ne prouvent aucune équivalence fonctionnelle ou certification de Zentra.
