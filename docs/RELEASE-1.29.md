# Zentra 1.29.0

Cette version améliore les parcours quotidiens sur mobile et ordinateur, avec des reprises explicites lorsqu’un enregistrement réussit mais que la lecture suivante échoue.

- Ventes et achats : devis, commandes, livraisons et réceptions partielles conservent leurs saisies en cas de refus. Une écriture confirmée se reprend par actualisation, même après fermeture du formulaire ou changement de rubrique. Les factures regroupant plusieurs commandes identifient clairement chaque commande et répartissent les quantités entre réceptions partielles.
- Factures récurrentes : création, mise en pause, reprise et rattrapage suivent le même contrôle des actions en cours. Les dates et conditions de paiement sont vérifiées, et l’historique se développe à la demande.
- Achats d’une entreprise non assujettie : la TVA facturée par le fournisseur reste dans le coût de l’achat, avec la pièce originale conservée. La correction tient compte des profils datés disponibles et ne reclasse pas automatiquement les anciennes dépenses sans preuve suffisante.
- Clôture annuelle : préparation et exports restent rattachés à l’exercice choisi. Après une clôture confirmée, une reprise recharge les états sans fermer une seconde fois l’exercice. Les détails sont repliables et le partage du dossier peut être réessayé à partir du ZIP existant.
- Salaires : correction du blocage de calcul des assurances accidents, affichage du net après cotisations, conservation des choix disponibles lors d’un changement de date et rejet des anciens résultats de calcul. Recherche, filtres et pages de 25 fiches facilitent leur consultation. Les erreurs de collaborateur, fiche et paiement restent visibles dans leur formulaire.
- PDF de salaire : aperçu lisible sur mobile, boutons accessibles et impression A4 conservée. Un partage interrompu peut reprendre le PDF déjà créé.
- Interface : boutons et formulaires adaptés aux petits écrans, navigation préservée et détails de version de test repliés.

## Reprise des historiques et TVA

Un changement entre montants convenus et reçus est bloqué si les postes ouverts nécessitent une reprise non documentée. La reprise fiscale automatique des débiteurs et créanciers n’est pas ajoutée par cette version. Les contrôles empêchent aussi un ancien profil incohérent de produire un décompte ou une clôture présentés comme valides.

Les corrections manuelles historiques de TVA, les avoirs en mode reçu sans date d’imputation et les pièces anciennes non classées dans une période clôturée conservent les limites détaillées dans [l’audit fonctionnel](AUDIT-APP-2026-09.md). Les références bancaires, rapprochements camt.053 et exports comptables restent décrits dans [Finances suisses](FINANCES-SUISSES-1.27.md). Aucune certification fiscale de l’application n’est annoncée.

## Distribution

Le lot Windows/macOS est préparé pour le canal de mise à jour existant, avec conservation des identifiants de production et de la clé de signature de mise à jour. Les fichiers publics ne sont remplacés qu’après contrôle du lot. Authenticode Windows et la notarisation Apple restent indisponibles. Android et iOS restent des paquets de test, sans publication sur les stores ni synchronisation des données entre appareils.
