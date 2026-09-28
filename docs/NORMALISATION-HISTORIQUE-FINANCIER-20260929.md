# Lecture de l’historique financier : suppression des recherches répétées

29 septembre 2026. Correctif local, non distribué par ce lot.

## Changement

Lors de chaque chargement du workspace, les relations entre documents étaient encore recherchées en parcourant des collections entières pour chaque facture, avoir, dépense ou produit. Le bridge construit désormais des index temporaires pour les paires acompte/solde, soldes d’avoirs clients, règlements liés aux deux documents, remboursements, compensations fournisseurs, reclassements, justificatifs et réservations de stock de secours.

Les index sont reconstruits à chaque lecture. Aucun cache ne survit à une synchronisation, une modification ou un changement d’entreprise. L’ordre source, le premier lien trouvé, les montants signés, les doublons de rôle et l’isolation des justificatifs sont conservés. Aucun contrôle comptable natif, écriture ou règle de synchronisation n’a été retiré.

## Mesure avant / après

Fixture générée, sans donnée réelle : pour chaque taille, autant de factures, dépenses, achats fournisseurs, avoirs, règlements, pièces jointes et produits. Les deux commandes natives de lecture sont simulées ; la fonction de normalisation est celle du vrai `desktopApi.loadWorkspace`. Un échauffement puis trois lectures par taille, même machine et même test, avant et après modification. Le hachage de toute la réponse est réalisé après la fenêtre chronométrée.

| Entrées par famille | Médiane avant | Médiane après | SHA-256 de toute la réponse, identique avant/après |
|---|---:|---:|---|
| 1 000 | 84,94 ms | 6,98 ms | `9476539e88e184a20973b2e8b7eac5bb14fbbf20f4c241e019aec93cd3cc2dd5` |
| 3 000 | 542,49 ms | 15,19 ms | `1c8a6ae444eab8d2c687f61eab994daa8c014d058e3131cd361efa38d3ccabe6` |
| 6 000 | 1 727,99 ms | 36,36 ms | `9954e1293c32ef0c86635c03b01929edb2b64a0c9126eba70079a2818882be6d` |

Durées individuelles avant (ms) : `[84.9369, 83.3690, 88.6781]`, `[657.9301, 542.4889, 491.8222]`, `[2014.1007, 1727.9909, 1362.9340]`.

Durées individuelles après (ms) : `[4.9513, 9.4661, 6.9839]`, `[14.8352, 18.5193, 15.1908]`, `[36.3561, 27.0571, 47.3732]`.

Reproduction depuis `desktop`, en PowerShell :

```powershell
$env:ZENTRA_PROFILE_FINANCIAL_RELATIONS = '1'
pnpm exec vitest run src/workspaceFinancialRelations.test.ts --reporter=verbose
Remove-Item Env:ZENTRA_PROFILE_FINANCIAL_RELATIONS
```

Le profil est ignoré dans les tests ordinaires ; la régression fonctionnelle demeure toujours active. Le test vérifie aussi que les données sources ne sont pas modifiées et qu’une deuxième entreprise possédant les mêmes identifiants ne récupère aucune relation du chargement précédent.

## Validation et limites

- 63 tests ciblés réussis : avoirs, paiements, remboursements, stock, justificatifs, indexation et changement d’espace.
- Suite frontend complète : **1 827 tests réussis**, un profil explicitement ignoré, 226 fichiers ; TypeScript sans erreur.
- La lecture SQLite, le transfert IPC, la taille de réponse d’environ 50 Mo de la recette historique et le rendu de l’interface ne sont pas mesurés par ce comparatif. Ne pas convertir ce gain en promesse de démarrage global ou de capacité pour 150 entreprises.
- Aucun serveur sollicité, donnée utilisateur modifiée, version changée, installation ou publication effectuée par ce lot.

Le travail suivant reste la réduction mesurée du volume lu/transféré et une recette native sur matériel modeste, sans supprimer les preuves comptables ou les données nécessaires à la synchronisation. Voir [la recette native du gros historique](VOLUMES-ET-PERIODES-20260928.md).
