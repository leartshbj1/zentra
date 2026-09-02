# Migration de Zentra vers Supabase

## État et objectif

Supabase Auth est actif en parallèle sur le site, avec confirmation e-mail et sessions en cookies serveur ; SIWC reste un accès transitoire distinct. Aucun rapprochement n'est fait à partir de l'e-mail seul. Les données de compte et d'archives continuent d'utiliser D1/R2 jusqu'au basculement contrôlé vers Postgres/Storage. Aucune clé, aucun compte fictif et aucune donnée de démonstration ne sont contenus dans ces fichiers.

Le projet Supabase actuellement relié à l'environnement de test est hébergé en `us-east-2` (Ohio) sur l'offre gratuite. Il convient pour cette intégration technique, mais son emplacement n'est pas présenté comme suisse ou européen. Avant d'y conserver des archives réelles de clients, Zentra doit faire valider la région, les exigences contractuelles et, si nécessaire, migrer vers un projet dans la région retenue.

Le contrat HTTP de l'application de bureau reste stable (`/api/account/*`, `/api/archive/*`, `/api/stripe/*`). Le serveur pourra ainsi changer de stockage sans obliger les clients à manipuler directement une clé Supabase privilégiée.

## Architecture cible

- Supabase Auth identifie les utilisateurs par UUID et confirme leur adresse e-mail.
- Postgres conserve les entreprises, rôles, invitations, abonnements Stripe, autorisations d'appareil et métadonnées d'archives.
- Row Level Security isole chaque entreprise. Le rôle `anon` n'a aucun accès aux tables Zentra.
- Le bucket privé `zentra-invoice-archives` contient uniquement des PDF, limités à 12 Mio. Les membres autorisés peuvent lire les objets de leur entreprise; les écritures passent par le serveur Zentra afin de préserver le chaînage et l'idempotence.
- Les PDF continuent d'être versionnés. Une correction crée une nouvelle révision; l'original n'est jamais remplacé.
- Chaque archive conserve explicitement `fiscal_year_end`. `retention_until` doit être exactement la date obtenue dix ans après cette fin d'exercice, et non dix ans après la date de facture. La base refuse une fin d'exercice antérieure à la facture ou située plus de dix-huit mois après celle-ci.
- `organization_domains` prépare des domaines d'entreprise facultatifs. Le domaine principal du produit reste une configuration d'environnement, pas une valeur codée dans la base.
- Les tables `migration.legacy_*` servent uniquement au rapprochement contrôlé des identités SIWC et des identifiants D1 pendant la transition.

## Déploiement sans interruption

1. Créer un projet Supabase dans une région européenne adaptée et appliquer les migrations avec `supabase db push`.
2. Exécuter `supabase test db`, puis le contrôle statique `node scripts/check-supabase-contract.mjs`.
3. Configurer Supabase Auth: SMTP de production, confirmation e-mail, PKCE, durée de session et URL de redirection exactes. En production, éviter les jokers; ajouter séparément le domaine Sites actuel et le futur domaine Zentra pendant la transition.
4. Créer les comptes propriétaires. Importer ensuite abonnements, entreprises et métadonnées dans une transaction. Les anciens identifiants SIWC doivent être placés dans `migration.legacy_identity_links`; ils ne deviennent une identité Supabase qu'après connexion Supabase vérifiée et rapprochement explicite.
5. Copier chaque objet R2 vers Storage en conservant `object_key`. Vérifier la taille et le SHA-256 avant d'insérer la ligne `invoice_archives` correspondante. Renseigner la fin d'exercice qui a servi au calcul de conservation et vérifier `retention_until = fiscal_year_end + 10 ans`; ne pas déduire la fin d'exercice de la seule date de facture. Bloquer pour reprise manuelle toute archive historique dont cette information ne peut pas être établie. Ne basculer aucune entreprise dont un objet manque ou dont l'empreinte diffère.
6. Faire tourner les lectures de contrôle en parallèle, puis activer les doubles écritures serveur. Comparer les comptes, abonnements, membres, sessions et chaînes d'archives.
7. Basculer les API vers Supabase entreprise par entreprise. Garder D1/R2 en lecture seule le temps de la fenêtre de retour arrière.
8. Après validation et délai convenu, supprimer les données de rapprochement SIWC et révoquer les secrets temporaires de migration.

Pour un projet ayant déjà appliqué `20260902000100_zentra_platform.sql`, la migration corrective `20260902000300_zentra_archive_retention.sql` doit également être appliquée. Elle ajoute la fin d'exercice de façon idempotente et reconstruit seulement les valeurs absentes depuis l'échéance déjà stockée, sans modifier `retention_until`, les empreintes ni les objets. Elle s'arrête avec une erreur si une archive ne respecte pas la plage cohérente attendue. Cette reconstruction préserve l'intégrité technique mais ne prouve pas la fin d'exercice historique : chaque valeur, en particulier une archive issue d'un 29 février, doit être rapprochée des pièces comptables avant le basculement.

## Domaine futur

Le site public peut recevoir un domaine personnalisé chez l'hébergeur choisi. Supabase Auth doit alors avoir ce domaine comme `Site URL` et l'URL exacte `/api/auth/confirmation` dans la liste des redirections. Le domaine API Supabase (`api.votredomaine.ch`) est distinct du domaine du site et nécessite l'option Custom Domain de Supabase.

L'application de bureau 1.19 contient encore l'origine `https://elyko.alb-leart1.chatgpt.site` dans sa liste de confiance. Avant le basculement DNS, publier une version signée qui accepte à la fois l'ancienne et la nouvelle origine, puis retirer l'ancienne dans une version ultérieure. Ne rendre jamais cette origine arbitrairement modifiable par l'utilisateur: elle fait partie de la frontière de confiance de la licence.

## Sécurité et secrets

- La clé `publishable` peut être publique; elle n'accorde que les droits autorisés par RLS.
- `SUPABASE_SECRET_KEY` ou l'ancienne clé `service_role`, les clés Stripe et la clé de signature des licences restent uniquement côté serveur.
- Les jetons d'invitation, d'appareil et de session sont stockés sous forme SHA-256 (`bytea`), jamais en clair.
- Les mutations sensibles restent derrière les API Zentra. Le serveur vérifie le JWT Supabase, l'appartenance à l'entreprise et le rôle à chaque requête.
- Les webhooks Stripe restent vérifiés sur le corps brut, idempotents par `event_id` et indépendants du navigateur.
- Activer MFA au minimum pour les propriétaires et administrateurs avant une ouverture commerciale.

## Archivage et limites de conformité

La migration protège les métadonnées: chaînage SHA-256, révisions uniques, transition unique `pending -> stored` et refus des suppressions d'archives stockées. La contrainte SQL impose la conservation jusqu'à exactement dix ans après la fin d'exercice déclarée. Le bucket est privé et aucune politique client ne permet l'écrasement ou la suppression.

Ce dispositif n'est toutefois pas une certification WORM/Olico. Une clé serveur privilégiée ou un administrateur Supabase peut toujours intervenir sur Storage, et les sauvegardes de la base Supabase n'incluent pas automatiquement les objets Storage. Pour une conservation probante, prévoir une seconde copie indépendante avec verrouillage de rétention, tests de restauration, journal d'accès et procédure documentée.

## Vérifications avant le basculement

- Tous les tests RLS passent pour propriétaire, comptable, membre, lecture seule et non-membre.
- Aucun accès `anon` aux tables ou objets Zentra.
- Un membre d'une entreprise ne voit aucune ligne ni aucun PDF d'une autre entreprise.
- Les cas calendrier et fin d'exercice, y compris le 29 février, produisent la même échéance dans le serveur et dans PostgreSQL.
- Un `read_only` ne peut déclencher aucune écriture serveur.
- Révocation d'un membre: sessions d'appareil et activations correspondantes révoquées dans la même opération serveur.
- Réception répétée d'un webhook Stripe: aucun double traitement.
- Copie R2 -> Storage: quantité, taille, SHA-256 et chaîne identiques.
- Redirections Auth exactes sur le domaine provisoire et le domaine final.
- Retour arrière testé avant coupure de D1/R2.
