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

Après fermeture de Zentra par l’utilisateur, les six essais de l’exécutable empaqueté ont réussi : démarrage et redémarrage d’un profil neuf, initialisation et données synthétiques en 1.61.0, puis reprise et redémarrage en 1.67.1. La base migrée en schéma 60, les lignes métier, pièces jointes, écritures équilibrées et identité protégée sont conservées. Rapport : `.qa/zentra-installer-packaged1671-verified/report.json`. Ces essais portent sur l’exécutable et la reprise du profil, pas sur l’assistant NSIS ni sur des comptes utilisateurs réels. Aucun profil client n’a été utilisé.

Le canal public `latest-windows.json` annonce désormais **1.67.1**, SHA-256 `E1E2DEBD47BD9F6C9C3D0031CC35D2BB1E53B32F1612ADD9540FD7919E5ED940`. Le précédent manifeste 1.67.0 est conservé sous `latest-windows-before-1.67.1-ui-20260914.json`, empreinte `FD8A52A1C7BAC87534AFD6E492C4B3FE67032375C09B288A08D6BEEEFCA33AA3`. Le manifeste Mac 1.67.0 et le manifeste historique 1.46.1 sont inchangés et leurs empreintes ont été recontrôlées. Preuve : `.qa/public1671/channels-after-publication.json`.

Le site de téléchargement a été publié avec succès en Sites **143** à 21:02:47 UTC, source `7a807fbb911db51424f55949eda728ffa2caeb3f`, déploiement `appgdep_6aa860e896f48191a25fb45bc5d2d7fb`, environnement 27. Les quatre tests de contrat de téléchargement et le build passent. Il propose le paquet Windows 1.67.1 avec la même empreinte et précise que les fichiers Apple restent en 1.67.0. URL retournée par le déploiement : `https://elyko.alb-leart1.chatgpt.site`.

Mac et iPhone restent en **1.67.0**. Aucune compilation Apple 1.67.1 n’a été lancée : le lanceur de Codemagic renvoie une erreur et la sélection des branches reste bloquée. Aucun abonnement payant ni réglage de compte n’a été modifié. Ne pas présenter les anciens fichiers Apple comme contenant le correctif de route.
