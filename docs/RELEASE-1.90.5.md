# Zentra 1.90.5 — préparation

La version rassemble les améliorations postérieures à 1.90.4 : messagerie sortante partagée par entreprise, catalogue simplifié et traduit, commandes tactiles, premiers pas Comptabilité/Banque/Relances, vérification complète des documents de sauvegarde, listes mobiles allégées et canal de mise à jour indépendant des comptes sur Windows et Mac.

Le 27 septembre 2026, les 1 759 tests de l'interface (219 fichiers) passent avant l'ajout des notes 1.90.5. Les notes existent en français, allemand, italien et anglais. Les tests natifs ciblés des sauvegardes et du nouveau canal de mise à jour ont déjà réussi sur Windows 143 et 145 ; le build de cette version les reprend, avec les autres contrôles du produit.

La branche `codex/first-client-release-1905` sert au gel d'une source commune Windows, Apple et Android. Chaque job doit être observé jusqu'à son état terminal ; aucun redémarrage sur la seule base d'un délai d'observation. Les fichiers seront vérifiés avant signature du paquet de mise à jour et publication.

**Non publiée à ce stade.** Le blocage du service de comptes Supabase et l'absence de planificateur autonome ne sont pas corrigés par cet installateur. Aucune signature Authenticode, notarisation Mac, signature iPhone ou publication dans les stores n'est ajoutée. La recette d'installation, de mise à jour et de restauration depuis l'application reste à exécuter. L'état courant demeure dans `ETAT-LIVRAISON.md`.
