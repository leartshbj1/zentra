# Restriction Supabase — 27 septembre 2026

À 02:46 UTC, une lecture authentifiée et sans mutation de `zentra_workspaces` a reçu HTTP 402. Une seconde lecture bornée à zéro ligne confirme : `exceed_egress_quota` et `exceed_storage_size_quota`. Référence amont : `01a0e0c1-ef5f-7d42-9baa-d700ba7aadc3`. Aucun identifiant client ni contenu métier enregistré dans ces preuves locales.

Ceci établit un blocage actuel de l’infrastructure utilisée par la collaboration. Il ne suffit pas à attribuer rétrospectivement les 28 erreurs HTTP 500 observées la veille à la même cause. La levée de restriction relève de l’hébergement Supabase ; une demande a été adressée au titulaire, sans changement payant effectué.

## Correction de présentation du service

Le client serveur transforme uniquement un HTTP 402 de Supabase en code structurel `service_restricted`. Les réponses Compte et Support exposent HTTP 503 et `Retry-After: 60`, avec une référence corrélée. Le corps amont n’est jamais exposé. Les véritables erreurs 402 d’abonnement du client et les refus de droits gardent leur sens. Aucun rejeu automatique d’écriture n’est ajouté.

Cette correction ne restaure pas le fournisseur. Ne pas annoncer de synchronisation réparée avant une nouvelle lecture HTTP 200 puis une recette à deux appareils (création, émission, paiement, soldes, coupure/reprise et absence de doublons).

## Réduire la dépendance du téléchargement à la base

Les anciens fichiers de publication alourdissent le stockage du même projet. Les fichiers déjà distribués et leurs signatures doivent rester disponibles tant que leur usage n’a pas été inventorié. Préparer les nouveaux artefacts sur GitHub Releases, déjà utilisé pour les publications, évite d’ajouter ces gros fichiers au quota Supabase ; cela ne lève pas automatiquement une restriction déjà appliquée. Les anciens binaires continuent de consulter leur manifeste Supabase jusqu’à une migration validée.

Référence officielle : https://supabase.com/docs/guides/troubleshooting/http-status-codes#402-service-restriction
