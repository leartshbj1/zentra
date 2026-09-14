# Zentra 1.67.2 — Transfert de l’entreprise

Les envois échouaient avant de joindre Supabase Storage : `redirect: 'error'` est refusé par le moteur workerd utilisé par le serveur. Le client utilise maintenant `manual` et rejette les réponses 3xx, sans transmettre de secret vers une autre destination. L’appel par défaut à `fetch` conserve également son contexte global, nécessaire au moteur Workers.

Le correctif serveur est déployé dans Sites 144 (`d8994ce902879509121128f3bc9a6b160baeefd9`), avec succès le 14 septembre 2026 à 21:19:16 UTC, déploiement `appgdep_6aa8649b530481918abef11938588553`. Il s’applique aux installations 1.67.1 sans attendre leur remplacement. La base Supabase et les copies de travail existantes sont conservées.

Dans l’app, les erreurs renvoyées par le service distant et les erreurs de connexion ne sont plus préfixées par « Champ invalide ». L’historique de version décrit ces corrections dans les quatre langues.

## Vérification

- Reproduction du défaut dans workerd 4.20260515.0 : `Invalid redirect value` avec `error`, réponse 200 avec `manual` sur un fichier public.
- Essai du véritable client TypeScript compilé dans workerd avec un serveur HTTP local : envoi, téléchargement à l’octet près, suppression et trois redirections refusées. Aucune donnée client ni aucun secret réel n’est utilisé. Script versionné côté site : `scripts/check-company-storage-worker.mjs`.
- 35 tests serveur passent : stockage, isolation des entreprises, reprises d’envoi, invitations et rôles.
- Test natif du libellé des erreurs distantes et deux tests de l’historique passent.
- Après déploiement, les journaux de production montrent des envois `PUT /api/account/collaboration` réussis (200) et la création d’une invitation `POST /api/account/team` (201). Une lecture SQL de métadonnées confirme la révision 5 publiée : 354 687 octets, 1 morceau attendu et 1 reçu, le 14 septembre à 21:21:38 UTC. Aucun contenu métier n’a été modifié pour cet essai. Cela confirme le transfert initial, sans constituer un essai de réception sur deux appareils réels.

## Windows et iPhone publiés

Source applicative : `b0c7bca142b3434f32259f738bd1f6a85771d5ea`.

- Windows : `Zentra_1.67.2_x64-setup.exe`, 23 526 443 octets, SHA-256 `07C40ED2268226C53DCF5E1548D2CDDB69D6397983AADD51D327343D0A136866`. Signature Tauri/Ed25519 vérifiée avant envoi puis sur le fichier public téléchargé. Pas de signature Authenticode.
- Six démarrages Windows isolés passent : nouvelle installation, redémarrage, initialisation et données de test en 1.61.0, remplacement du binaire par 1.67.2 et redémarrage. Base, documents, journal et identité protégée sont conservés, schéma 59 vers 60. Ces contrôles utilisent le binaire exact du paquet ; l’assistant NSIS n’a pas été exécuté.
- `latest-windows.json` diffuse 1.67.2, SHA-256 `C70D6B1A3E90548E07D16714D8A8B289591E19952B24B04C780C984CB9A6B2F5`. Le manifeste précédent est sauvegardé sous `latest-windows-before-1.67.2-ui-20260914.json`, SHA-256 `E1E2DEBD47BD9F6C9C3D0031CC35D2BB1E53B32F1612ADD9540FD7919E5ED940`.
- iPhone : `Zentra-1.67.2-iPhone-unsigned.ipa`, 25 014 284 octets, SHA-256 `61B152513F84BA9EC489DF41306766A3BC1151E2CC4BC0D25CF1AABDDA5AD4B2`. Build Codemagic `6aa86559573dbf0ad3404162` réussi : ARM64 iPhoneOS, identifiant `ch.zentra.mobile`, iOS 15 minimum. Quatre tests natifs Liquid Glass passent. IPA public sans licence personnelle intégrée, à signer avec Sideloadly ou AltStore ; installation sur iPhone physique non vérifiée.
- EXE, IPA, signatures et sommes de contrôle sont téléchargés depuis le stockage public et comparés octet pour octet aux fichiers locaux.

## Mac publié

Le premier contrôle WebKit a détecté deux attentes de test obsolètes : l’ancien texte d’aide et la case de consentement retirée lors de la simplification du partage. Le test `touch-team-journey.mjs` suit maintenant le parcours actuel : une invitation prépare automatiquement la copie complète, avec contrôle de l’ordre envoi/invitation et blocage d’une réception sans copie. L’essai Chromium passe aux trois tailles d’écran, y compris gestes, zoom, zones sûres, renouvellement du code, invitation par rôle et ouverture automatique.

Le commit `98d481178fe821fa4c77d252c0f691c7cb623e89` ne change que ce test ; le code applicatif est identique au source Windows/iPhone. La compilation Mac relancée `6aa868822703f926e0b7a414` réussit le 14 septembre à 21:53:36 UTC, avec toutes ses étapes valides.

- WebKit sur Mac : 6 parcours entreprise (clair/sombre, 320/390/1280 px), 3 formats tactiles avec zoom document/image/PDF et zones sûres, renouvellement du code et ouverture automatique de l’entreprise. 138 écrans contrôlés aux largeurs 320/390/1440 px : aucun contraste insuffisant détecté, styles restitués après retour au mode clair.
- DMG : `Zentra_1.67.2_macos-universal.dmg`, 50 231 797 octets, SHA-256 `2760396E9D2EF9EB3280D92F7E75EB034F9DD13A2CADF7534FB6015B562F2C42`.
- Archive updater : `Zentra_1.67.2_macos-universal.app.tar.gz`, 50 209 804 octets, SHA-256 `86F80DF52538206BBD2BCD5DB276EE93E7136F1905FC2E3CE3E2E76B9833C4D8`.
- Binaire universel ARM64/x86_64, identifiant `ch.zentra.desktop`, macOS 12 minimum. Vérification `codesign --verify --deep --strict` et `lipo` sur la machine Apple. Clé et adresse du canal de mise à jour vérifiées dans les deux architectures.
- Archive signée localement avec la clé Tauri/Ed25519 existante ; signature validée indépendamment avant publication puis après téléchargement public. La clé privée n’a pas été transmise à Codemagic. L’accès API temporaire local a été supprimé après récupération des paquets.
- `latest-macos.json` diffuse 1.67.2, SHA-256 `AB696FB9DC535024B34540647389F14F56891B38FC83E510BEB19A73B206029B`. Manifeste précédent sauvegardé sous `latest-macos-before-1.67.2-ui-20260914.json`, empreinte vérifiée `AFF741EC64EC770ADEFE20FF6CF60DC7F1E2282EACBC40C81BEC387BDB5B6C79`.

La signature Apple reste ad hoc, sans Developer ID ni notarisation. L’installation et la mise à jour sur un Mac physique n’ont pas été testées. Les contrôles sur le moteur WebKit et les signatures ne remplacent pas cet essai.

## Distribution

Les fichiers sont disponibles dans le bucket public `zentra-releases` de Supabase. Les deux canaux spécifiques servent 1.67.2 et le canal historique partagé `latest.json` reste strictement inchangé en 1.46.1, SHA-256 `5C3F809B7B32BF11B07AE2D1758EC96FCAD435177727D403B7281B27858BC444`.

La page de téléchargement affiche les trois versions 1.67.2 dans Sites 146, source `82405e3dd08f7a5245cbbac032dfa83c550acf02`. Déploiement `appgdep_6aa86dfd9f7c81918aff608bfb561abd` réussi le 14 septembre 2026 à 21:58:33 UTC ; adresse retournée `https://elyko.alb-leart1.chatgpt.site`. Les quatre tests du contrat de téléchargement et la construction du site passent. Le correctif serveur de Sites 144 est conservé.

Le partage conserve sa protection contre les changements simultanés, sans fusion automatique de deux copies modifiées. Aucune migration vers un autre fournisseur de base de données n’a été nécessaire.
