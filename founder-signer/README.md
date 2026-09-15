# Zentra Fondateur

Application Windows personnelle du fondateur pour accorder un accès Zentra à partir d’une adresse e-mail.

## Accorder un accès par e-mail

1. Ouvrir **Zentra Fondateur** depuis le Bureau ou le menu Démarrer.
2. Saisir l’adresse utilisée pour se connecter à Zentra, puis **Vérifier le compte**.
3. Choisir **14 jours**, **Un mois** ou **Personnalisée**, avec le dernier jour d’accès inclus, heure suisse.
4. Cliquer **Accorder l’accès**. Attendre le message de confirmation du serveur.
5. La personne se connecte à Zentra avec cette adresse confirmée, puis ouvre ou reconnecte son application pour récupérer son accès. Aucun jeton à lui transmettre.

La liste à gauche permet de retrouver les accès, de les prolonger et de les retirer. Une note personnelle peut accompagner chaque attribution. Les accès terminés apparaissent avec la case correspondante.

- L’attribution commence immédiatement. Une adresse inconnue reste en attente jusqu’à sa connexion avec un e-mail confirmé.
- Les 14 jours et le mois calendaire s’ajoutent à la fin de l’accès offert en cours. Après expiration ou retrait, la durée commence au moment de la nouvelle attribution. La date personnalisée remplace l’échéance.
- L’accès offert est individuel (fonctionnalités Solo, une personne). Une entreprise déjà détenue par ce compte est conservée lorsqu’elle est unique ; sinon Zentra prépare un espace personnel séparé. Les autres membres ne reçoivent pas cet accès.
- Un abonnement payé conserve ses propres droits. L’outil ne facture rien, ne crée pas de paiement Stripe et n’envoie aucun e-mail.
- Le retrait et l’expiration bloquent les services en ligne. Une application hors ligne peut fonctionner jusqu’à la fin du dernier jour couvert par sa licence déjà signée. Ces licences sont renouvelées avec un bail court, sans la tolérance de trois jours des abonnements payés.
- Si Internet coupe pendant une attribution, utiliser **Reprendre la demande**. La demande est conservée chiffrée sur le PC et une nouvelle tentative ne prolonge pas deux fois l’accès.
- L’accès reste attaché à l’identité du compte confirmée lors de son rattachement. Réattribuer la même adresse à un autre compte ne transfère pas l’ancien accès.

### Accès réservé à votre PC

Une clé de gestion distincte est créée sur ce PC et chiffrée par Windows DPAPI pour votre session Windows. Le serveur connaît uniquement sa clé publique. Copier l’exécutable sur un autre PC ne donne pas le pouvoir d’accorder des accès. Gardez votre session Windows et son coffre privés.

Le service de gestion est `https://www.zentraapp.ch/api/founder/access`. Chaque requête est signée, horodatée et protégée contre la réutilisation. La clé privée n’est jamais envoyée au site ni à l’interface. Une connexion Internet est nécessaire.

## Signature avancée des jetons

La fonction d’origine reste accessible par **Signature avancée des jetons**. Elle utilise la clé de licence Zentra existante, distincte de la nouvelle clé de gestion.

## Utilisation

1. Ouvrir **Zentra Fondateur** depuis le Bureau ou le menu Démarrer.
2. Coller un jeton existant, son contenu JSON/Base64URL ou l’UUID v4 de l’installation affiché dans Zentra. Les jetons du coffre sont aussi accessibles à gauche.
3. Cliquer **Lire le contenu**, vérifier le bénéficiaire et la date, puis **Signer le jeton**.
4. Le contrôle HTTPS est coché par défaut. Si le serveur accepte l’activation, le résultat contient le jeton renvoyé et vérifié, avec sa date effective. Le serveur peut ajuster le nom, les droits et l’échéance selon la licence propriétaire ou l’abonnement.
5. Cliquer **Copier le jeton**, puis le coller sur l’appareil destinataire, dans la section licence de Zentra, sous **Ou installer un nouveau jeton signé**.

Un jeton reste lié à son couple exact licence/installation. La signature avancée ne crée pas d’accès par e-mail. Une activation initiale nécessite une connexion Internet dans Zentra.

### Nouvelle installation propriétaire

Une nouvelle signature ne crée pas automatiquement une autorisation serveur. Si un UUID correspond à un jeton déjà connu, l’application conserve sa licence existante. Sinon, elle crée une licence propriétaire et en conserve le jeton chiffré ; les signatures suivantes réutilisent cette identité.

Si le serveur indique **Activation à autoriser**, ouvrir **Identité de licence et autorisation serveur** et copier l’empreinte du couple licence/installation. Ajouter cette valeur SHA-256 à `OWNER_LICENSE_BINDING_SHA256` dans l’environnement du serveur Zentra, **en conservant les valeurs existantes**, puis déployer cette configuration. Revenir dans l’application et cliquer **Vérifier l’activation**. Le serveur accepte au maximum 32 couples dans cette liste.

Pour une licence d’abonnement existante, l’état de l’abonnement, les autorisations de l’appareil et la session liée restent contrôlés côté serveur. Ne pas inscrire une licence client dans la liste propriétaire pour contourner ces contrôles.

## Données locales

- Programme : `%LOCALAPPDATA%\ZentraFondateur\ZentraFondateur.exe`.
- Le composant Microsoft `WebView2Loader.dll` reste dans le même dossier que le programme ; l’installateur local le copie automatiquement depuis les dépendances compilées.
- Coffre : `%LOCALAPPDATA%\ZentraFondateur\vault`.
- La clé privée et les jetons sont chiffrés par Windows DPAPI pour le compte Windows courant. Les permissions du coffre sont limitées à ce compte et SYSTEM.
- La clé privée n’est ni intégrée au programme, ni transmise à l’interface, ni envoyée au serveur. Sa correspondance avec la clé publique officielle est vérifiée avant signature.
- Les jetons signés sont mémorisés chiffrés, avec une génération récente par couple licence/installation. Les fichiers propriétaires importés sont conservés.
- La copie met uniquement le jeton choisi (ou l’empreinte choisie) dans le presse-papiers. L’application ne lit pas le presse-papiers.
- La signature avancée contacte `https://elyko.alb-leart1.chatgpt.site/api/stripe/refresh`. Les redirections sont refusées, la réponse est limitée à 16 Ko et la signature ainsi que l’identité renvoyées sont contrôlées. La gestion par e-mail contacte uniquement le service de gestion ci-dessus, avec une réponse limitée à 256 Ko.
- Ne pas distribuer le coffre. Copier les fichiers DPAPI vers un autre compte Windows ne suffit pas à les déchiffrer.

## Compilation et installation locale

Prérequis de compilation : Rust pour Windows GNU, dépendances du `Cargo.lock` et WebView2 pour l’exécution (déjà utilisé par Zentra).

```powershell
cargo test --manifest-path founder-signer/Cargo.toml --locked
powershell -NoProfile -ExecutionPolicy Bypass -File founder-signer/installer-local.ps1 -Build
```

L’installation importe uniquement les copies chiffrées déjà présentes dans `secrets/license-signing-key.dpapi` et `secrets/owner-license-token*.dpapi`, puis vérifie le coffre avec le véritable exécutable. Les clés existantes ne sont pas remplacées. Aucun jeton ou secret n’est inclus dans les sources ou le paquet exécutable. L’exécutable personnel ne possède pas de signature Authenticode d’éditeur.

Test HTTPS facultatif, réservé au PC du fondateur avec le jeton iPhone déjà autorisé :

```powershell
cargo test --manifest-path founder-signer/Cargo.toml --locked live_owner_signing_and_server_acceptance -- --ignored
```

Ce test signe en mémoire et contrôle l’acceptation serveur ; il ne modifie pas la licence installée dans Zentra.
