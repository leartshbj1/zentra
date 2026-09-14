# Zentra 1.67.1 — Partage simplifié

Deux blocages du premier partage sont corrigés : les champs facultatifs `null` (notamment le code NOGA détaillé) ne sont plus rejetés par l’API de profil ; la route exacte `/api/account/collaboration` est autorisée par le client HTTPS natif. La politique conserve son origine fixe et refuse les autres routes, suffixes et URL externes.

Le partage complet utilise directement les données enregistrées de l’entreprise. Il n’attend plus un second envoi du profil partiel depuis le formulaire des paramètres. L’invitation prépare le partage avant de créer le lien ; un échec de transfert ne crée pas d’invitation. Les droits de rôle et les places disponibles restent contrôlés par le serveur. Chaque membre voit la base complète, salaires compris ; le rôle lecture seule continue de bloquer les modifications.

L’écran n’impose plus de case de partage supplémentaire. Le statut de synchronisation est compact et le parcours pour rejoindre une entreprise contient moins de texte. Les états d’erreur et le traitement explicite des modifications concurrentes sont conservés : cette version n’ajoute pas de fusion automatique.

## Validation

- 26 tests serveur : profil facultatif vide, champs invalides, sessions, rôles, places, transport et isolation des entreprises.
- 15 tests natifs ciblés : route autorisée, autres routes refusées, partage, sauvegardes, identité locale et numérotation.
- Facture réellement émise dans une base de test, reçue par deux autres bases, puis paiement enregistré par un autre membre : total 1 081 CHF, paiement 300 CHF, reste 781 CHF dans les trois bases ; écritures identiques et équilibrées, créateur original conservé. La plage de journal propre au deuxième appareil est adoptée avant son paiement.
- TypeScript et les 14 tests d’historique/scheduler passent. Le parcours WebKit vérifie l’invitation sans case à cocher, le refus d’inviter avant la fin du partage et la reprise après erreur.
- Aucun compte réel ni document utilisateur n’est modifié par les tests. L’essai avec deux comptes réels reste distinct des tests locaux et serveur.

Le correctif serveur a été publié dans Sites 142 depuis `65ff02943c0c44a9afa88e3ec1e919c4ea2451e0`. La correction native nécessite l’installation de la version 1.67.1 ; le seul correctif serveur ne peut pas modifier la liste de routes autorisées dans un ancien exécutable.

## Paquet Windows préparé le 14 septembre 2026

Source compilée : `6e5719f79d587e8ec5b0f6de65f7c478c8350a00`. La compilation fraîche et le staging ont réussi. Installateur `Zentra_1.67.1_x64-setup.exe`, 23 521 055 octets, SHA-256 `2ADFD54D93636ACA55BF98DC11D33A3466F00AC34D05DF0BC21A965F784D2D54`. Signature de mise à jour Tauri/Ed25519 vérifiée indépendamment ; pas de certificat Authenticode.

Les quatre fichiers immuables (EXE, signature, somme SHA-256 et `latest-windows-1.67.1.json`) sont déposés dans le bucket public `zentra-releases` de `xvfohjdlhlirksrvkiqu`. Ils ont été retéléchargés et comparés octet pour octet par leur SHA-256 ; la signature de l’EXE public a également été vérifiée. Preuve locale : `.qa/public1671/verification.json`.

Le canal `latest-windows.json` et le site de téléchargement restent en **1.67.0** : pas de promotion tant que l’essai de l’exécutable empaqueté et de la reprise du profil synthétique n’est pas terminé. L’app utilisateur est toujours ouverte ; elle n’a pas été arrêtée. Les helpers prêts sont `.qa/check-packaged1671-verified.ps1` et `.qa/verify-windows-release-profile1671.py`. Vérifier l’absence des deux profils QA avant le premier lancement.

Mac et iPhone restent en **1.67.0**. Aucune compilation Apple 1.67.1 n’a été lancée : le lanceur de Codemagic renvoie une erreur et la sélection des branches reste bloquée. Aucun abonnement payant ni réglage de compte n’a été modifié. Ne pas présenter les anciens fichiers Apple comme contenant le correctif de route.
