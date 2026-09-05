# Audit fonctionnel et mobile — septembre 2026

Objectif actif : vérifier les parcours de Zentra sur ordinateur et mobile, corriger les erreurs observées et préparer une mise à jour commune. Ce document suit le travail ; il ne constitue pas une déclaration de conformité ni une recette complète de toutes les fonctions.

## Lot en cours après la publication 1.27.0

Les améliorations ci-dessous sont dans le code en cours de validation. Les installateurs et le site publiés restent en version 1.27.0 jusqu'à la prochaine publication vérifiée.

- Ventes : filtres par état, solde à encaisser et retard calculé après paiements et avoirs ; recherche par référence bancaire avec espaces ; recherche textuelle tolérant les accents et espaces multiples.
- Listes : ordre récent conservé, pagination de 25 documents et remise à la première page après changement de recherche ou d'état. Cartes mobiles en deux colonnes et boutons tactiles de 44 px.
- Devises : le brouillon conserve sa devise à l'enregistrement ; montants des listes, dossiers, formulaires, paiements et aperçus affichés dans la devise du document. Tableau de bord et dossier client séparent les totaux par devise. Les projets présentent les recettes par devise et suspendent la marge CHF lorsqu'une conversion justifiée manque.
- Éditeur : les projets proposés appartiennent au client sélectionné ; changer de client retire l'ancien projet. Un avoir reprend les coordonnées de rattachement et la devise de sa facture originale. Les prix CHF du catalogue ne sont pas recopiés automatiquement dans un document en devise étrangère.
- Achats : sélecteur mobile donnant accès aux cinq sections ; résumé en deux colonnes ; intitulé du parcours simplifié. Navigation au clavier conservée sur ordinateur.
- TVA des achats : une classification non déductible passe une correction équilibrée au journal, liée à sa source. Une nouvelle classification compense cette correction sans modifier l'écriture ni la facture d'origine. Les corrections suivent les changements datés du compte de charge ; les périodes clôturées restent protégées. La méthode TDFN porte la TVA des achats en charge.
- Centre TVA : les achats déjà classés peuvent être recherchés et corrigés. Le décompte et les états comptables sont actualisés après la décision. Les corrections manuelles antérieures ne sont pas identifiées automatiquement : vérifier leur existence avant « Appliquer au journal » sur un ancien achat.
- Avoirs fournisseurs : classification de chaque ligne, réduction signée de l'impôt préalable à la date du document en mode « convenues », correction comptable des avoirs non déductibles et coûts bruts en TDFN. La migration 42 conserve les anciennes classifications et étend la protection des périodes clôturées aux avoirs. Les anciens comptes de charge ambigus ne sont pas devinés.
- Reprise des formulaires : l'avoir conserve ses identifiants après un échec de rafraîchissement. Les erreurs globales restent visibles au-dessus des formulaires, y compris mobiles. Le panneau d'activation comptable et les cartes achats tiennent sur 320 px. Le détail des calculs TVA s'ouvre à la demande et les chiffres répétés sont retirés sur téléphone.

## Preuves locales

Environnement : Windows, Edge headless, largeurs 320, 390, 768, 1024 et 1440 px. Données de recette fictives et fonctions natives simulées dans le navigateur, complétées par les tests du moteur Rust sur de vraies bases SQLite temporaires.

| Contrôle | Preuve |
| --- | --- |
| Moteur natif : ventes, stock, achats, banque, paie, TVA, clôture, sauvegardes et documents | Suite complète : 456 réussis, un échec de donnée de test (échéance manquante), un ignoré ; `.qa/credit-vat-full.log`. Après correction de cette donnée, les six tests TVA passent, y compris le test échoué ; `.qa/credit-vat-final-focused.log`. Couverture cumulée : 457 tests réussis. |
| Interface et logique TypeScript | `pnpm --dir desktop test:ui` : 571 tests réussis / 84 fichiers ; `.qa/credit-vat-ui.log` |
| TVA non déductible, achats mixtes, changement de classification, TDFN, reclassement daté, transaction refusée, clôture, sauvegarde, ancien payload, avoir au trimestre suivant, migration 41 vers 42 et export figé | 6 tests d'intégration natifs ; `.qa/credit-vat-final-focused.log` |
| Contrôle et correction des achats classés, total TVA et rafraîchissement du bilan, recherche, refus puis reprise | `desktop/tests/vat-purchase-journey.mjs` : cinq largeurs ; `.qa/vat-purchases/report.json` |
| Avoir non classé, réduction signée de TVA et traitement non déductible | `desktop/tests/vat-credit-journey.mjs` : cinq largeurs ; `.qa/vat-credits/report.json` |
| Erreur visible dans le formulaire, saisie préservée et nouvel essai avec les mêmes identifiants | `desktop/tests/supplier-credit-retry-journey.mjs` : 320 et 1440 px ; `.qa/credit-retry/report.json` |
| XML natif avec impôt préalable négatif | Validation lxml avec le XSD officiel eCH-0217 2.0.0 et ses neuf dépendances ; `.qa/ech-0217/validation.json`. Aucune transmission AFC. |
| Navigation dans les 16 modules et 7 catégories de paramètres ; projet, fichier, devis et facture | `desktop/tests/workspace-journey.mjs` : 120 captures ; `.qa/design/report.json` |
| TVA, références, ordre des documents, action d'export PDF et classification d'un achat | `desktop/tests/finance-journey.mjs` : 28 captures ; `.qa/finance/report.json` |
| Recherche de référence, filtres, devis/facture EUR enregistrés, projet lié au client, avoir lié, pagination de 80 factures | `desktop/tests/sales-browsing-journey.mjs` ; `.qa/sales/report.json` |
| Sept formulaires de création, cinq sections achats et maintien du focus dans les dialogues | `desktop/tests/forms-journey.mjs` : 60 captures ; `.qa/forms/report.json` |

Les tests navigateur vérifient le parcours UI et les paramètres transmis aux fonctions simulées. Ils ne prouvent pas l'accès à une banque réelle, l'envoi d'un e-mail, une publication sur les stores ou une synchronisation entre appareils. Les modifications de ce lot n'ont pas encore été exécutées dans de nouveaux binaires natifs Windows/macOS/iOS/Android.

## Points encore ouverts dans l'audit

1. **Reprise des corrections manuelles de TVA.** Le nouveau moteur couvre les factures fournisseurs et dépenses, mais ne rattache pas automatiquement les anciens reclassements saisis à la main. Ne pas appliquer une seconde correction à un achat déjà corrigé manuellement ; prévoir une reprise documentée de ces cas avant d'annoncer une migration automatique de tout l'historique.
2. **Contre-prestations reçues.** Le moteur bloque les allocations partielles ou sur plusieurs périodes qu'il ne sait pas justifier (`received_mode_blocks_cross_period_payment_allocation`). Examiner les allocations par taux et les corrections avant d'élargir le calcul. Ne pas retirer le blocage sans modèle et tests comptables.
3. **Avoirs fournisseurs en mode reçu.** Le mode « convenues » est couvert dans le nouveau lot. Le mode « reçues » signale encore `unsupported_supplier_credit_tax`, car les allocations ne portent pas de date fiscale d'imputation ou de remboursement. Ajouter ces preuves avant d'automatiser le traitement de ce mode.
4. **Parcours de gestion avancés.** Les tests natifs couvrent les commandes, livraisons, récurrences, rapprochements, paie et clôture. Compléter les essais UI avec des documents actifs, des erreurs et des reprises de ces parcours ; les seules vues vides et ouvertures de formulaires ne suffisent pas à conclure.
5. **Diffusion.** Préparer les binaires signés pour l'updater, vérifier les artefacts Windows/macOS et les démarrages mobiles, puis publier le lot stabilisé. L'adhésion Apple Developer et le compte Google Play restent distincts de cet audit du logiciel.

## Références produit

La distinction entre factures ouvertes, paiements identifiés et opérations à vérifier s'appuie sur les parcours décrits par [Bexio Banking](https://www.bexio.com/fr-CH/banking) et la [documentation officielle du rapprochement bancaire Odoo 19](https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/reconciliation.html), consultées le 5 septembre 2026. Ces références orientent l'organisation des écrans ; elles ne prouvent aucune équivalence fonctionnelle ou certification de Zentra.

La validation du fichier TVA utilise le [schéma officiel eCH-0217 2.0.0](https://www.ech.ch/de/ech/ech-0217/2.0.0), consulté le 5 septembre 2026. La méthode TDFN est contrôlée avec la [présentation actuelle de l'AFC](https://www.estv.admin.ch/fr/tva-taux-de-la-dette-fiscale-nette-et-taux-forfaitaires). La validation du format ne constitue ni une acceptation du décompte par l'AFC ni une validation de la situation fiscale réelle de l'entreprise.
