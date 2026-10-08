# Zentra US — équipe et invitation d'un collaborateur

Plan écrit avant les modifications majeures de ce jalon. Base isolée `93aedd8f6820446f45d6fc70b4818e532e1f17df`. Les phases précédentes restent historiques et leur preuve n'est pas réécrite. Aucune migration, configuration Stripe, opération email ni donnée de production n'est modifiée.

## Lacune vérifiée

Les lecteurs d'accès US, la découverte CH/US et l'admission appareil existent. La seule insertion non-test dans `international_workspace_members` est actuellement l'owner lors de l'admission SaaS. Les invitations publiques actuelles utilisent les tables legacy CH. Les rôles US non-owner des tests ne prouvent donc pas un parcours collaborateur réel.

`0087_international_saas_authorities.sql` impose l'unicité entreprise/utilisateur, le rôle immuable, la révocation irréversible et un plafond des membres actifs. Il ne faut ni supprimer ces membres ni réécrire cette migration. La garde SQL de l'owner doit être renforcée, tout en conservant les preuves d'autorité et les familles appareil 1–3 et 4.

## Verticale locale

- Nouvelle migration D1 additive, générée par `wrangler d1 migrations create` avec configuration locale dédiée, sans exécution distante. Dernier SQL vérifié : 0089 ; le journal du générateur Drizzle ne couvre pas les derniers SQL bruts, donc aucun `db:generate` aveugle.
- Tables privées : tête/révision de l'équipe, invitations, reçus immuables, audit sans token et profils de membre (prénom/nom). La révision d'équipe reste indépendante des écritures ERP.
- Plafond provenant uniquement de l'offre US et du paiement vérifiés : membres actifs (owner inclus) plus invitations non expirées réservées. Aucun plafond, abonnement ou droit Automation ne vient du navigateur.
- Owner : tous les rôles non-owner ; admin : `member`/`read_only` seulement. Les autres consultent. Aucun transfert de propriété, retrait de l'owner ou auto-retrait. Chaque attente est encadrée par une revalidation fraîche ; les gardes D1 contrôlent les invariants transactionnels.
- Cinq commandes avec UUID de reprise et révision attendue : création, régénération, retrait d'invitation, acceptation, retrait de membre. Les rôles restent fixes et un membre révoqué ne peut pas être réactivé dans ce jalon ; une future génération d'accès versionnée sera nécessaire.
- Une acceptation consomme sa réservation, crée la membership et son nom NFC dans le même batch que reçu/audit. Aucun abonnement, licence, livre ERP ou consentement Automation nouveau. Pas besoin d'un ERP déjà initialisé pour gérer l'équipe.
- Révocation atomique du membre et de ses sessions US des deux familles. Les challenges historiques ne doivent plus pouvoir être consommés après perte d'accès.

## Lien et reprise

Token serveur CSPRNG de 32 octets, namespace US distinct, seul son hash conservé. Aucun token clair dans D1, URL query, logs ou analytics. Lien `/invitation/us#token=…`, capturé puis retiré du fragment par le client. Copie du lien uniquement : aucun envoi email.

Une réponse initiale peut livrer le lien si l'INSERT est réellement appliqué et correspond au hash généré. Un replay ou accusé perdu rend le reçu sans token. Le bouton explicite de régénération remplace atomiquement l'invitation et révoque l'ancien lien sans doubler la place réservée. La projection fraîche de l'équipe ne doit jamais être remplacée par un reçu historique.

Une résolution POST privée prend le token dans le corps. Elle exige Auth email confirmé et égal au destinataire avant de révéler entreprise, rôle, expiration et révision. L'acceptation demande prénom et nom ; aucune identité n'est devinée depuis l'adresse email. La route déduit l'espace de l'invitation enregistrée, jamais d'une sélection d'entreprise envoyée par le client.

## Ports et routes

Contrat/store privés : projection, recherche par hash, reçu, commit atomique et contexte d'autorité US vérifié. Le contexte contient identité Auth, espace, rôle/mode membre ou destinataire, abonnement/environnement/catalogue/Price/plafond et dates de validité. Il ne doit pas être un DTO public accepté comme grant.

Le binding réel fournit également la provenance navigateur ou session appareil US (identifiant et génération 1–3/4, sans bearer). Le store corrobore la session active dans la transaction. La résolution et l'acceptation restent réservées à une identité navigateur Supabase confirmée ; une session appareil ne prétend pas connaître l'adresse e-mail de son utilisateur.

- `GET/POST /api/international/workspaces/[organizationId]/team`.
- `POST /api/international/team-invitations/resolve`.
- `POST /api/international/team-invitations/accept`.
- Panneau Équipe du workbench et écran d'acceptation FR/DE/IT/EN, clair/sombre et mobile.

## Validation avant livraison

Chaîne D1 complète réelle dans workerd, deux identités Auth fictives explicitement identifiées, dernière place concurrente, reprise sans double membre, lien perdu/régénéré, noms Unicode, mauvais destinataire/espace, changements d'accès pendant attente, owner protégé même par SQL, sessions/challenges invalidés, expirations et rôles fixes. Tests HTTP, transport/UI, 320 px/texte 200 %, quatre langues, clavier, thèmes, TypeScript, lint, build et régression CH appropriée.

Les preuves de ce jalon vont dans `.qa/us-team/`. D1 local exécuté est distinct de l'Auth et des preuves de paiement injectées. Le catalogue live est vide par défaut, les flags restent fermés et aucune capacité d'entreprise réelle n'est affirmée. La migration de production, les recettes hébergées et la distribution native restent soumises aux validations et à l'approbation explicite utilisateur.

## Sources techniques consultées

Le batch séquentiel et son retour arrière reposent sur le contrat documenté de [D1Database.batch](https://developers.cloudflare.com/d1/worker-api/d1-database/). Les contraintes circulaires différées sont vérifiées à la fin de transaction, conformément aux [clés étrangères D1](https://developers.cloudflare.com/d1/sql-api/foreign-keys/). Les propriétés de l'utilisateur sont revérifiées par le lecteur Auth existant, qui demande l'utilisateur au serveur, dans l'esprit de [Supabase getUser](https://supabase.com/docs/reference/javascript/auth-getuser). Ces documents ne constituent pas une preuve de concurrence ou de déploiement hébergé.
