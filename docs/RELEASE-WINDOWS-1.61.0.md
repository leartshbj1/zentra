# Windows 1.61.0

## Contenu

- Documents : Inter et Literata sont disponibles pour le corps, les titres et les passages sélectionnés, en normal, gras, italique et gras italique. Les polices sont incluses dans l’application et les PDF pour fonctionner hors ligne, avec les mêmes formes et mesures à l’écran et à l’export.
- Factures d’acompte et de solde : préparation en trois étapes, **Prestation → Paiement → Vérifier**. Les dates d’échéance suivent les conditions choisies et restent modifiables. La prestation peut être reprise depuis l’autre facture liée.
- Les erreurs renvoient à l’étape et au champ à corriger. Une écriture en cours ne peut pas être envoyée deux fois ; les modifications sont conservées après un refus. Sur mobile, le champ actif reste visible au-dessus des actions.

Les modèles, couleurs, logo, marges et paragraphes de l’atelier restent disponibles dans **Paramètres → Présentation des documents**. L’import de polices personnelles ou d’un document Word complet n’est pas inclus. Les montants sont calculés par l’application ; le certificat annuel officiel garde sa présentation réglementaire.

## Périmètre

Préversion Windows x64 publiée le 13 septembre 2026. L’identifiant `ch.helvichantier.desktop` et le schéma SQLite 59 sont conservés. Aucun nouveau paquet macOS, iOS ou Android n’est inclus.

La mise à jour utilise la signature Tauri/Ed25519 existante. Aucun certificat Authenticode n’est disponible : Windows peut afficher « Éditeur inconnu ».

## Validation

Les parcours de préparation ont été vérifiés dans Edge et WebKit à 320, 390, 844 et 1 440 pixels de large. Les factures émises restent verrouillées. Les scénarios SQLite de paire acompte/solde et de reprise d’un ancien acompte passent. Les tests des huit variantes de police, les exports PDF et leur inspection visuelle passent.

La suite complète passe : **1 441 tests d’interface** et **699 tests natifs**, sans échec. Deux tests natifs sont ignorés par défaut. Le contrôle HTTPS de renouvellement de licence a été exécuté séparément avec un jeton fictif refusé et réussit. La recette HTTPS de sauvegarde entre deux installations, nécessitant des autorisations navigateur dédiées, n’a pas été exécutée. TypeScript, Vite et la compilation Windows de production passent.

Le programme exact du paquet a passé six essais isolés : premier démarrage et redémarrage, initialisation d’un profil 1.60, lecture de ses données fictives, remplacement du programme par 1.61 et nouveau redémarrage. Les contrôles vérifient l’intégrité SQLite, les clés étrangères, les empreintes des données et des pièces jointes, l’identité protégée et l’équilibre des écritures. Le profil contient un client, un projet, un devis, une facture avec paiement, un collaborateur, une pièce jointe et des séquences fictifs.

Les premières tentatives de recette ont révélé deux défauts du montage de test : le vérificateur ne connaissait pas encore la version 1.61 et la copie du programme 1.60 ne contenait pas sa bibliothèque WebView2Loader. La liste des versions a été complétée et la bibliothèque vérifiée, identique à celle de l’ancien dossier et du paquet actuel, a été ajoutée à la copie de test. Les six essais ont ensuite été exécutés depuis de nouveaux profils. L’essai HTTPS lancé pendant la suite native avait aussi rencontré le verrou Windows de l’exécutable de test ; sa reprise après la fin de cette suite passe. Ces corrections de recette ne changent pas le programme distribué.

Ces essais remplacent le programme dans des profils de test. Ils n’exécutent pas NSIS et ne représentent pas une installation client. La [recette GitHub de l’installateur](https://github.com/leartshbj1/zentra/actions/runs/34750516408) n’a pas démarré : les deux tâches sont bloquées par la facturation du compte, sans aucune étape exécutée. L’installation neuve et la mise à niveau par l’installateur restent non vérifiées. Les essais navigateur utilisent une connexion simulée ; ils ne prouvent pas une synchronisation entre deux appareils réels.

## Livraison

La [préversion GitHub](https://github.com/leartshbj1/zentra/releases/tag/v1.61.0) est publique depuis le 13 septembre 2026 à 09:56:25 UTC. Les tailles et empreintes de ses quatre fichiers correspondent au lot local. Les fichiers publics Supabase ont également été téléchargés et comparés aux originaux.

Le canal Windows `latest-windows.json` annonce 1.61.0. Une lecture ordinaire, sans contournement du cache, a été vérifiée à **09:58:36 UTC** après renouvellement de son cache de 60 secondes. Le canal partagé `latest.json` reste inchangé, octet pour octet. Depuis Windows 1.50, le bouton **Mise à jour** utilise le canal Windows ; pour les versions plus anciennes, l’installateur manuel reste disponible.

Le [site Zentra](https://elyko.alb-leart1.chatgpt.site/download) a été publié avec succès à 09:57:23 UTC. Les quatre tests de téléchargement et le build de production passent. Le lanceur Sites n’a pas démarré son gestionnaire de paquets sur ce Windows ; le script de production du projet a été exécuté directement avec le pnpm existant. L’archive est produite et validée par le helper Sites, avec GNU tar configuré pour les chemins Windows.

- Source native compilée : `e8d81ad0bfb2754b99c7e42e81d26cc95567370a`.
- Révision de recette et de release : `368de4fe5fc138555a2475e62540e61486b6794b`. Seul le vérificateur de profils change après la source compilée ; les sources natives et les fichiers de dépendances sont identiques.
- Source du site : `a87230614df0c9235ce34a7f99f93a570a9b210b`.
- Installateur : `Zentra_1.61.0_x64-setup.exe`, **23 228 099 octets**.
- SHA-256 de l’installateur : `94FA0E1A35E12A7A246DBA5750F3B0E9BDAF13232D3FA621DBE5AD3A1822005F`.
- SHA-256 du programme après marquage NSIS : `A1253CFD9CC10AD3E664E45A43B612B7E23EA1BD17EAF0F810236C6E9D32B153`.
- Signature Tauri/Ed25519 vérifiée ; aucune signature Authenticode.

Preuves locales : `.qa/windows-161-ui.log`, `.qa/windows-161-native.log`, `.qa/windows-161-license-https-final.log`, `.qa/windows-161-build.log`, `.qa/windows-161-stage.log`, `.qa/windows-161-packaged-verified.log`, `.qa/zentra-installer-packaged161-verified/report.json` et `.qa/public161/`. Les tentatives de recette précédentes sont conservées séparément. La page de téléchargement est publiée depuis le checkout du site, distinct des sources natives.
