# Benchmark fonctionnel Bexio → Elyko

État de la recherche : 1er septembre 2026. Sources Bexio officielles uniquement.

Ce document sert de référence produit. Il ne s'agit ni de copier l'interface de
Bexio, ni de promettre des services qui exigent une certification ou un
partenaire bancaire. Elyko conserve son différenciateur : une véritable
application Windows dont les données métier restent sur le PC du client.

## Ce qui fait réellement la valeur de Bexio

La valeur principale n'est pas une longue liste de menus. C'est la continuité
sans ressaisie entre un contact, un devis, une commande, une livraison, une
facture, son paiement, puis l'écriture comptable. Les écrans Elyko doivent donc
présenter une prochaine action claire et garder chaque transformation traçable.

## Matrice de couverture

| Domaine | Référence Bexio vérifiée | Elyko 1.7 | Écart utile à combler | Priorité |
| --- | --- | --- | --- | --- |
| CRM | contacts, catégories, interlocuteurs, historique documentaire, import/export | clients et vue 360 | import prévisualisé, catégories, rappels et pièces liées | P1 |
| Vente | devis → commande → livraison → facture, QR, avoirs, modèles, récurrence, relances | devis avec produits → commande, BL partiel/complet et situation/finale par quantités ; prestation simple → facture directe ; QR, avoirs et relances locales | acomptes par montant/pourcentage, récurrence et modèles FR/DE/IT | P0 |
| Achats | boîte de réception, facture/avoir fournisseur, commande et réception | factures structurées, justificatifs, paiements et écritures | avoirs, OCR fournisseur, commandes/réceptions | P0 |
| Banque | connexion directe, ISO 20022, paiements, rapprochement débiteurs/créditeurs | CAMT.053/.054 local et confirmation humaine | pain.001 contrôlé, règles explicables puis connexions optionnelles | P1 |
| Comptabilité | débiteurs/créditeurs automatiques, journal, grand livre, bilan, résultat, TVA | partie double, rapports, clôture et continuité | assistant TVA complet, pièces sur écritures et export fiduciaire | P0 |
| Projets | étapes, tâches, responsables, temps, budget, dépenses et facturation | projets/chantiers, jalons, tâches, responsables, échéances, temps, coûts, rentabilité et temps → facture | tarifs multiples et dépenses remboursables facturables | P1 |
| Catalogue/stock | produits/services, seuils, commandes, réservations, réceptions | catalogue, registre immuable, réservation de commande, en main/réservé/disponible et sortie sur BL sans double sortie à la facture | réception fournisseur et emplacements | P0 |
| Paie | paie complète, barèmes source, assurances, Swissdec/ELM, certificats | moteur local versionné, PDF, écritures et OCR local | assiettes réglementaires distinctes, barèmes officiels puis certification externe | P0 conformité — en cours |
| Documents | archive Olico, intégrité, recherche et droits | pièces hashées, documents émis figés, sauvegardes | dossier d'archive contrôlable et politique de conservation | P0 conformité |
| Mobile | contacts, ventes, reçus et temps | site commercial mobile; application Windows | compagnon terrain ciblé avec synchronisation volontaire | P1 |
| Intégrations | API OAuth, Marketplace et Zapier | aucune API métier publique | contrat local versionné après stabilisation du modèle | P2 |
| Sécurité | ISO 27001, 2FA, sauvegardes cloud | SQLite locale, DPAPI licence, backups et updater signé | chiffrement de base optionnel, rôles locaux et Authenticode | P0/P1 |

## Ordre d'implémentation retenu

1. **Planifier et exécuter — livré en 1.6** : jalons, tâches, responsables,
   échéances et temps rattaché à une tâche.
2. **Vendre sans ressaisie — livré en 1.7** : devis avec produits → commande →
   livraison partielle ou complète → situation/facture finale par quantités,
   sans double mouvement de stock; facture directe conservée pour les services.
3. **Acheter sans ressaisie — prochain lot** : commande fournisseur → réception → facture ou
   avoir, avec pièce originale et écriture comptable.
4. **Automatiser sous contrôle** : récurrence, relances, import bancaire et OCR
   proposent; l'utilisateur confirme les opérations financières ambiguës.
5. **Clôturer proprement** : assistant TVA, contrôles de continuité, dossier de
   bouclement et exports pour la fiduciaire.
6. **Collaborer sans abandonner le local** : rôles Windows locaux, paquet
   fiduciaire chiffré, puis compagnon terrain synchronisé volontairement.

## Limites à ne pas masquer

- Swissdec/ELM est une certification externe; une belle fiche PDF ne la remplace
  pas.
- Une connexion bancaire directe dépend de la banque, de ses autorisations et
  d'un contrat technique. L'import ISO 20022 local reste le socle fiable.
- Un accès fiduciaire simultané et un compagnon mobile demandent une
  synchronisation chiffrée; ils ne peuvent pas être simulés avec des données de
  démonstration.
- Les cartes, crédits et services financiers de type bexio Pay ne font pas
  partie du cœur Elyko.
- La version 1.7 facture progressivement le livré des lignes concernées et
  facture directement les prestations sans BL. Elle ne crée pas encore un
  acompte défini librement par montant ou pourcentage.

## Sources officielles

- [Fonctions Bexio](https://www.bexio.com/fr-CH/fonctions)
- [Comparatif détaillé des forfaits, état au 28 mai 2026](https://cdn.www.bexio.com/assets/content_craft/documents/bexio/compare-packages-fr.pdf)
- [Processus de vente et dépenses](https://www.bexio.com/fr-CH/gestion-des-processus-de-vente-et-des-depenses)
- [Facturation](https://www.bexio.com/fr-CH/logiciel-de-facturation)
- [Traitement des commandes](https://www.bexio.com/fr-CH/traitement-commande)
- [Bulletins de livraison](https://www.bexio.com/fr-CH/bulletin-de-livraison)
- [Achats et dépenses](https://www.bexio.com/fr-CH/gestion-des-depenses)
- [Comptabilité](https://www.bexio.com/fr-CH/logiciel-de-comptabilite-pme)
- [Banking](https://www.bexio.com/fr-CH/banking)
- [Gestion de projet](https://www.bexio.com/fr-CH/logiciel-de-gestion-projet)
- [Gestion des stocks](https://www.bexio.com/fr-CH/gestion-des-stocks-pme)
- [Comptabilité salariale](https://www.bexio.com/fr-CH/comptabilite-salaire)
- [Bexio Go](https://www.bexio.com/fr-CH/bexiogo?wizard=true)
- [Documentation API](https://docs.bexio.com/)
