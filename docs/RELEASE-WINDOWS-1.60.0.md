# Windows 1.60.0

## Contenu

- Atelier de documents : modèles personnels réutilisables, format portrait ou paysage, police du titre, couleurs des tableaux, copie de style, listes numérotées, retraits et espacement des paragraphes. Les réglages précis et l’aperçu sur petit écran sont inclus. Les documents déjà émis gardent leur présentation enregistrée.
- Clients et fournisseurs : paiements, remboursements, utilisation d’avoirs et réceptions guidés, avec un récapitulatif avant validation et une reprise après lecture interrompue qui ne refait pas une écriture déjà confirmée.
- Catalogue et stock : fiches simplifiées, mesures précises, mouvements et comptages guidés, protection des modifications concurrentes.
- Projets : réparation d’une copie locale manquante avec le fichier original, explication par document et reprise de synchronisation au retour du réseau. Un fichier local endommagé ne bloque plus les autres envois.

L’atelier s’ouvre dans **Paramètres → Présentation des documents**. Le [guide de personnalisation](PERSONNALISATION-DOCUMENTS.md) explique les outils et leurs limites : les polices disponibles sont Helvetica, Times et Courier ; les fichiers Word complets et les polices personnelles ne sont pas importés. Les montants restent calculés par l’application et le certificat annuel officiel conserve sa présentation réglementaire.

## Périmètre

Préversion Windows x64. L’identifiant `ch.helvichantier.desktop` et le schéma SQLite 59 sont conservés. Aucun nouvel installateur macOS, iOS ou Android n’est inclus dans cette livraison.

La signature Tauri/Ed25519 authentifie le paquet de mise à jour. Aucun certificat Authenticode n’est disponible : Windows peut afficher « Éditeur inconnu ».

## Validation

Les 1 432 tests d’interface passent. La suite complète du moteur termine avec 696 tests réussis, aucun échec et deux tests ignorés par défaut. Le contrôle HTTPS du renouvellement de licence a été exécuté séparément et réussit avec un jeton fictif refusé par le serveur. La recette de sauvegarde HTTPS entre deux installations, nécessitant des autorisations navigateur dédiées, n’a pas été exécutée dans ce lot. TypeScript et la compilation de production passent.

La première suite complète avait révélé un scénario fournisseur qui utilisait des réceptions futures en octobre et novembre 2026. Les dates du scénario ont été replacées en 2025, puis le test ciblé et la suite complète ont été exécutés avec succès. Le refus des réceptions futures dans l’application est conservé. Le paquet final a été recompilé après cette correction du test.

Le programme exact inclus dans le paquet a démarré et redémarré avec un profil neuf. Un profil 1.59 contenant un client, un projet, un devis, une facture avec paiement, un collaborateur, une pièce jointe, des séquences et des écritures fictives a ensuite été ouvert avec le programme 1.59 puis avec le programme 1.60, et redémarré. Les six essais passent : intégrité SQLite, clés étrangères, empreintes des données et de la pièce jointe, identité protégée et équilibre des écritures vérifiés.

Ces essais remplacent le programme dans des profils de test isolés. Ils n’exécutent pas NSIS et ne représentent pas une installation client. La [recette GitHub de l’installateur](https://github.com/leartshbj1/zentra/actions/runs/34746404063) n’a pas démarré : les deux tâches sont bloquées par un problème de facturation du compte, sans aucune étape exécutée. L’installation neuve et la mise à niveau par l’installateur restent non vérifiées. La synchronisation de documents en production entre deux appareils reste également à vérifier ; les parcours navigateur utilisent une connexion simulée et les tests SQLite vérifient séparément la file et la réparation.

## Livraison

La [préversion GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.60.0) a été publiée le 13 septembre 2026 à 07:58:39 UTC. Le canal public `latest-windows.json` annonce 1.60.0 ; sa lecture ordinaire, sans contournement du cache, a été vérifiée à 08:00:24 UTC. Le canal partagé des autres plateformes est resté inchangé. Depuis Windows 1.50, le bouton **Mise à jour** utilise ce canal ; les versions plus anciennes disposent de l’installateur manuel.

Le [site Zentra](https://elyko.alb-leart1.chatgpt.site) a été publié avec succès à 07:59:41 UTC avec la page de téléchargement actualisée. Les quatre tests de liens et le build de production passent. Sur ce Windows, le lanceur de build Sites n’a pas démarré son gestionnaire de paquets ; le script de production du projet a été exécuté directement avec le pnpm du runtime. L’archive a ensuite été produite et validée par le helper Sites, avec GNU tar configuré pour traiter le chemin Windows comme un chemin local.

- Source native : `1ab187225264308faa31577610fa51526d10f715`.
- Source du site : `39ac53809b37b957d5178e4d3e5e7674d8339746`.
- Installateur : `Zentra_1.60.0_x64-setup.exe`, 23 018 306 octets.
- SHA-256 de l’installateur : `43D1BD6575B4272AA09FB89E0DACF035900A7C2F33D489513916D571FD72F626`.
- SHA-256 du programme après marquage NSIS : `B52E5AEE2356E962803974068719EAA581DD66BA7E7B94D5D0F51E0A1D2168D1`.
- Les fichiers téléchargés depuis Supabase et les empreintes des quatre fichiers GitHub correspondent aux fichiers validés localement. La signature Tauri/Ed25519 a été vérifiée.

Preuves locales : `.qa/windows-160-ui.log`, `.qa/windows-160-native-final.log`, `.qa/windows-160-date-regression.log`, `.qa/windows-160-license-https.log`, `.qa/windows-160-build-final.log`, `.qa/windows-160-stage.log`, `.qa/windows-160-packaged.log`, `.qa/zentra-installer-packaged160/report.json` et `.qa/public160/`. La page de téléchargement est préparée dans le checkout de publication du site, distinct des sources natives.
