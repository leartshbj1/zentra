# Feuille de route fonctionnelle Elyko

État de la comparaison : 1er septembre 2026.

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
| Socle local | installation Windows, configuration guidée, SQLite locale, sauvegardes, audit, mises à jour signées | Disponible |
| Vente essentiel | clients, devis, acceptation, conversion en facture, facture QR, avoir, paiements, relances | Disponible ; automatisation d'envoi à compléter |
| Catalogue et saisie rapide | produits/services, prix, TVA, coûts, remises, stock minimal, ajout aux devis/factures | En cours |
| Achats | fournisseurs, factures et crédits fournisseurs, justificatifs, échéances, paiements, OCR | Planifié après le catalogue |
| Banque locale | import CAMT.053/054, dédoublonnage, propositions de rapprochement, validation humaine | Planifié après les achats |
| Cycle commercial avancé | commande, bulletin de livraison, acomptes/partielles, récurrence | Planifié |
| Comptabilité et TVA | journal, grand livre, balance, résultat, bilan, journal TVA et clôture explicable | Partiel ; validation fiduciaire requise |
| Projets et temps | projets/chantiers, tâches, temps, coûts, rentabilité, temps vers facture | Disponible ; jalons et planification à enrichir |
| Paie suisse | employés, cotisations versionnées, fiches, import OCR local, écritures | Disponible en partie ; Swissdec/ELM non certifié |
| Collaboration | rôles locaux, accès fiduciaire, verrouillage, journal d'audit | Planifié |
| Écosystème | API locale, connecteurs isolés, compagnon mobile | Ultérieur |

## Références officielles consultées

- Fonctions : https://www.bexio.com/fr-CH/fonctions
- Facturation : https://www.bexio.com/fr-CH/logiciel-de-facturation
- Processus de vente et dépenses : https://www.bexio.com/fr-CH/gestion-des-processus-de-vente-et-des-depenses
- Comptabilité : https://www.bexio.com/fr-CH/comptabilite-financiere
- Stock : https://www.bexio.com/fr-CH/gestion-des-stocks-pme
- Projets : https://www.bexio.com/fr-CH/logiciel-de-gestion-projet
- ISO 20022 : https://www.bexio.com/fr-CH/iso20022
- API : https://docs.bexio.com/
- Comparatif des forfaits du 28 mai 2026 : https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf

