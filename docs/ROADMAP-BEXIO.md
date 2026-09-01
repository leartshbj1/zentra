# Feuille de route fonctionnelle Elyko

État de la comparaison : 1er septembre 2026. Version source documentée : Elyko 1.5.0, à publier uniquement après validation du nouvel installateur.

Cette feuille de route compare Elyko aux fonctions officiellement documentées par Bexio. Elle ne vise pas à copier son interface ni son architecture cloud : Elyko reste une application Windows locale, avec les données conservées chez le client.

## Principes produit

- Une seule action principale par écran et des termes compréhensibles sans formation comptable.
- Les devis, factures et pièces émises sont des instantanés : modifier un client ou un produit ne change jamais un ancien document.
- Les automatisations financières restent explicables, annulables et journalisées.
- Une fonction réglementée n'est annoncée conforme qu'après validation indépendante. Une fiche de salaire PDF ne vaut pas une certification Swissdec/ELM.
- Les connexions externes sont optionnelles. Le fonctionnement local et les sauvegardes restent prioritaires.

## Couverture et ordre de réalisation

| Lot | Fonctions attendues | État |
| --- | --- | --- |
| Socle local | installation Windows, configuration guidée, SQLite locale, sauvegardes, audit, mises à jour signées | Disponible ; Authenticode reste à acquérir |
| Vente essentiel | clients, devis, acceptation, conversion en facture, facture QR, avoir, paiements, relances | Disponible ; automatisation d'envoi à compléter |
| Catalogue et stock | produits/services, prix, TVA, coûts, remises, stock minimal, mouvements, ajout aux devis/factures | Disponible : registre local immuable, entrées/sorties/corrections et sortie à l'émission d'une facture standard ; réservations et emplacements à venir |
| Achats | fournisseurs, factures et crédits fournisseurs, justificatifs, échéances, paiements, OCR | Factures structurées, justificatifs, validation, paiements partiels et comptabilisation disponibles ; crédits et OCR fournisseur à venir |
| Banque locale | import CAMT.053/054, dédoublonnage, propositions de rapprochement, validation humaine | Disponible pour les crédits clients et débits fournisseurs ; périmètre détaillé ci-dessous |
| Cycle commercial avancé | commande, bulletin de livraison, acomptes/partielles, récurrence | Planifié |
| Comptabilité et TVA | journal, grand livre, balance, résultat, bilan, journal TVA et clôture explicable | Partiel ; validation fiduciaire requise |
| Projets et temps | projets/chantiers, tâches, temps, coûts, rentabilité, temps vers facture | Projets, temps, coûts, rentabilité et temps approuvés vers facture disponibles ; tâches et jalons à venir |
| Paie suisse | employés, cotisations versionnées, fiches, import OCR local, écritures | Disponible en partie ; Swissdec/ELM non certifié |
| Collaboration | rôles locaux, accès fiduciaire, verrouillage, journal d'audit | Planifié |
| Écosystème | API locale, connecteurs isolés, compagnon mobile | Ultérieur |

## Périmètre bancaire local d'Elyko 1.5.0

- Import sur le PC de relevés suisses `camt.053` et `camt.054` dans les versions `v04` et `v08`. Le fichier XML brut n'est pas envoyé à Elyko ni à un service tiers.
- Détection des doublons d'import et conservation locale de l'historique utile au contrôle.
- Association explicite d'un compte bancaire importé à un IBAN ou QR-IBAN de l'entreprise. Cette association reste visible et peut être révoquée.
- Proposition de factures clientes à partir de références structurées QRR ou SCOR et de factures fournisseurs pour les débits compatibles. Elyko n'enregistre aucun paiement sans confirmation humaine.
- Rapprochement limité aux mouvements créditeurs comptabilisés, non annulés, dans la devise attendue et sans dépassement du solde de la facture.
- Les écritures en attente, annulations, lots ambigus et montants excédentaires restent visibles pour contrôle, mais ne sont pas rapprochés automatiquement.
- Les connexions bancaires directes, règles personnalisées, ordres pain.001 et écritures de frais bancaires restent à venir.

Cette portée volontairement bornée évite de présenter une lecture bancaire comme une comptabilisation certaine. Les mouvements importés, les liens de comptes, la décision de l'utilisateur et l'écriture résultante restent dans la base SQLite locale et ses sauvegardes.

## Références officielles consultées

- Fonctions : https://www.bexio.com/fr-CH/fonctions
- CRM : https://www.bexio.com/fr-CH/crm
- Facturation : https://www.bexio.com/fr-CH/logiciel-de-facturation
- Processus de vente et dépenses : https://www.bexio.com/fr-CH/gestion-des-processus-de-vente-et-des-depenses
- Achats et dépenses : https://www.bexio.com/fr-CH/gestion-des-depenses
- Comptabilité : https://www.bexio.com/fr-CH/logiciel-de-comptabilite-pme
- Paie : https://www.bexio.com/fr-CH/comptabilite-salaire
- Stock : https://www.bexio.com/fr-CH/gestion-des-stocks-pme
- Projets : https://www.bexio.com/fr-CH/logiciel-de-gestion-projet
- ISO 20022 : https://www.bexio.com/fr-CH/iso20022
- API : https://docs.bexio.com/
- Comparatif des forfaits du 28 mai 2026 : https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf
- SIX, Swiss Payment Standards 2026 — Implementation Guidelines for Cash Management : https://www.six-group.com/dam/download/banking-services/standardization/sps/ig-cash-management-sps-2026-en.pdf
- SIX, Swiss Payment Standards 2026 — Business Rules : https://www.six-group.com/dam/download/banking-services/standardization/sps/business-rules-sps-2026-en.pdf
- SIX, standardisation des paiements suisses : https://www.six-group.com/en/products-services/banking-services/payment-standardization/swiss-payments.html
- SIX, norme ISO 20022 : https://www.six-group.com/en/products-services/banking-services/payment-standardization/standards/iso-20022.html

## Prochains lots, dans l'ordre

1. Converger source, installateur, manifeste et site dans une même version vérifiée.
2. Ajouter commandes, bons de livraison et une vraie chaîne d'acomptes/situations/finale sans double mouvement de stock.
3. Ajouter récurrence, modèles multilingues et envoi de documents ou relances explicitement configuré par le client.
4. Ajouter assistants de TVA et de bouclement, pièces sur écritures et exports fiduciaires; aucune transmission AFC ne sera annoncée sans validation dédiée.
5. Ajouter import/export de contacts, catégories, tâches, étapes, rôles locaux et accès fiduciaire contrôlé.

Swissdec/ELM reste un programme de certification distinct : Elyko doit continuer à se présenter comme une aide locale à la préparation et au contrôle de la paie tant que cette certification n'est pas obtenue.
