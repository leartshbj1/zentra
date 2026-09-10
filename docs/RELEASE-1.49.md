# Zentra 1.49.0 — création des fiches de salaire simplifiée

Publication Windows manuelle préparée sur la version 1.48.0, avec le schéma natif 59 et les mêmes calculs de paie. Le canal automatique et les versions des autres plateformes ne sont pas modifiés par ce lot.

## Changements

- Trois étapes : collaborateur et mois, salaire, vérification du net.
- Explication du brut, des retenues, du net et des points à compléter.
- Erreurs en français avec accès direct aux corrections ; saisie conservée pendant la correction du contrat, des assurances ou des cotisations.
- Répertoire suisse embarqué de 357 entrées, avec recherche par nom, numéro ou canton et saisie libre. Les listes IJM et LPP sont partielles. Sélectionner une caisse ne souscrit aucun contrat et ne détermine pas ses primes.
- Assistant de configuration des taux depuis les contrats réels ; reprise des taux fédéraux manquants sans écraser les réglages existants.
- Présentation adaptée de 320 à 1440 pixels, réduction des animations et récapitulatif du montant à verser.

## Compatibilité

Les commandes natives, les tables et les calculs de la version 1.48.0 sont conservés. Aucune migration 60–67 de la branche de développement n'entre dans cet installateur. La nouvelle classification persistante des allocations familiales et les nouveaux échanges de synchronisation ne sont pas inclus.

L'assistant propose la base AVS pour une seule ligne de salaire. Pour les compléments, les bases des cotisations doivent être indiquées explicitement ; aucune catégorie fiscale n'est déduite du libellé. Les définitions portant sur le brut conservent leur comportement natif existant. Les taux contractuels supérieurs à deux décimales ne sont pas arrondis pour les faire accepter.

Les tests navigateur utilisent des dossiers fictifs. Ils valident les interactions de l'interface, pas une certification Swissdec, un virement bancaire ou une installation réelle sur le poste d'un client. Les nouveaux calculs fiscaux en préparation ne sont pas annoncés dans cette publication.

## Validation avant construction

795 tests d'interface passent dans cette copie de publication, ainsi que TypeScript. Le parcours complet avec contrat incomplet, reprise après erreur, recherche des caisses, ajout et modification d'une cotisation, puis enregistrement passe en 320, 390 et 1440 pixels. Le cas des taux fédéraux initialement absents est également vérifié. Le récapitulatif mobile a été inspecté visuellement.

Les empreintes de l'installateur, de l'exécutable et la signature Tauri sont conservées dans le lot de publication après construction. Une signature Tauri ne remplace pas un certificat d'éditeur Authenticode. L'installation manuelle est proposée avant toute promotion du canal automatique.

Sources des répertoires et portée : [paie simplifiée et caisses suisses](recette-fiduciaire/paie-simple-caisses-2026-09-10.md).
