# Zentra 1.67.2 — Transfert de l’entreprise

Les envois échouaient avant de joindre Supabase Storage : `redirect: 'error'` est refusé par le moteur workerd utilisé par le serveur. Le client utilise maintenant `manual` et rejette les réponses 3xx, sans transmettre de secret vers une autre destination. L’appel par défaut à `fetch` conserve également son contexte global, nécessaire au moteur Workers.

Le correctif serveur est déployé dans Sites 144 (`d8994ce902879509121128f3bc9a6b160baeefd9`), avec succès le 14 septembre 2026 à 21:19:16 UTC, déploiement `appgdep_6aa8649b530481918abef11938588553`. Il s’applique aux installations 1.67.1 sans attendre leur remplacement. La base Supabase et les copies de travail existantes sont conservées.

Dans l’app, les erreurs renvoyées par le service distant et les erreurs de connexion ne sont plus préfixées par « Champ invalide ». L’historique de version décrit ces corrections dans les quatre langues.

## Vérification

- Reproduction du défaut dans workerd 4.20260515.0 : `Invalid redirect value` avec `error`, réponse 200 avec `manual` sur un fichier public.
- Essai du véritable client TypeScript compilé dans workerd avec un serveur HTTP local : envoi, téléchargement à l’octet près, suppression et trois redirections refusées. Aucune donnée client ni aucun secret réel n’est utilisé. Script versionné côté site : `scripts/check-company-storage-worker.mjs`.
- 35 tests serveur passent : stockage, isolation des entreprises, reprises d’envoi, invitations et rôles.
- Test natif du libellé des erreurs distantes et deux tests de l’historique passent.
- L’envoi depuis une installation cliente réelle doit être distingué de ces tests locaux ; sa confirmation a été demandée après le déploiement.

Les paquets 1.67.2 Windows, Mac et iPhone restent à compiler et à vérifier avant publication.
