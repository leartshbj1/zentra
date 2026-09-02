# Matrice de basculement des API Zentra

| Route actuelle | Source actuelle | Cible Supabase | Règle de sécurité à préserver |
| --- | --- | --- | --- |
| `POST /api/stripe/checkout` | Stripe + D1 `checkout_attempts` | Stripe + Postgres `checkout_attempts` | même origine, limite de débit, preuve opaque hachée, configuration Stripe vérifiée avant ouverture |
| `POST /api/stripe/webhook` | Stripe + D1 | Stripe + Postgres | corps brut, signature et mode vérifiés, `event_id` idempotent, traitement transactionnel |
| `POST /api/account/claim` | Supabase Auth ou SIWC transitoire + D1 | Supabase Auth + Postgres | utilisateur vérifié, session Stripe appartenant au navigateur et au même compte, un abonnement par entreprise |
| `POST /api/account/device/start` | D1 | Postgres | aucune clé Supabase privilégiée dans l'app, code aléatoire court, secret long haché, expiration et limites de débit |
| `POST /api/account/device/approve` | Supabase Auth ou SIWC transitoire + D1 | Supabase Auth + Postgres | membre actif de l'entreprise, abonnement actif, comparaison explicite du code |
| `POST /api/account/device/poll` | D1 + licence signée | Postgres + licence signée | échange consommable une fois, session longue aléatoire stockée hachée, rôle et abonnement revalidés |
| `GET /api/account/me` | D1 | Postgres | session d'appareil + activation + membre actifs; aucun simple JWT client ne remplace ce contrôle |
| `DELETE /api/account/session` | D1 | Postgres | révocation immédiate de la session et blocage du droit d'écriture local |
| invitations et révocations | Supabase Auth ou SIWC transitoire + batch D1 | Supabase Auth + transaction Postgres | propriétaire/admin seulement, jamais de dernier propriétaire supprimé, sessions et activations révoquées atomiquement |
| `GET /api/archive/invoices` | D1 | Postgres | métadonnées filtrées par entreprise et rôle |
| `POST /api/archive/invoices` | D1 + R2 | Postgres + Storage | création `pending`, objet privé non écrasable, SHA/taille contrôlés, finalisation unique `stored` |
| téléchargement archive | D1 + R2 | Postgres + Storage | revalidation de l'entreprise avant URL signée courte; ne jamais retourner l'URL publique d'un bucket |

## Adaptation de types

| D1 | PostgreSQL | Conversion |
| --- | --- | --- |
| secondes Unix `integer` | `timestamptz` | `to_timestamp(value)` à l'import; `extract(epoch from value)` seulement à la frontière HTTP historique |
| booléen `0/1` | `boolean` | `value <> 0` |
| fin d'exercice utilisée par l'archive | `fiscal_year_end date` | reprendre la valeur contrôlée côté serveur; `retention_until` doit être exactement `fiscal_year_end + interval '10 years'` |
| identifiant utilisateur SIWC texte | `auth.users.id uuid` | rapprochement contrôlé via `migration.legacy_identity_links`; jamais de cast automatique |
| SHA-256 texte base64url/hex | `bytea` pour les secrets, hex texte pour les archives | décoder selon le champ; comparer les octets avant insertion |
| clé R2 `organizations/...` | nom d'objet Storage identique | conserver le chemin et vérifier le contenu avant la métadonnée |

## Transactions obligatoires

Un enchaînement de plusieurs appels `supabase-js` n'est pas une transaction. Les opérations suivantes doivent être réalisées par une fonction Postgres privée appelée depuis le serveur via une connexion de base sécurisée, ou par une API serveur qui utilise une transaction SQL:

- création entreprise + propriétaire;
- acceptation invitation + création/réactivation du membre + consommation invitation;
- révocation membre + sessions + activations;
- revendication d'un abonnement Stripe + entreprise + propriétaire;
- prise en charge et finalisation idempotente d'un événement Stripe.

L'upload Storage reste hors transaction SQL. Utiliser le protocole `pending -> upload unique -> vérification SHA/taille -> stored`; nettoyer seulement les lignes `pending` expirées et les objets orphelins prouvés. L'insertion `pending` doit transmettre `fiscal_year_end` et l'échéance exacte calculée par le même contrat calendrier que `lib/account-security.ts`; une archive historique sans fin d'exercice vérifiable reste bloquée hors basculement.

Si la migration initiale est déjà installée, appliquer ensuite `20260902000300_zentra_archive_retention.sql`. Son remplissage inverse depuis l'échéance existante évite de modifier une archive chaînée; il ne remplace pas le rapprochement de la fin d'exercice avec la source comptable.

## Ordre de remplacement du code

1. Ajouter un dépôt Supabase derrière une interface serveur, sans modifier les réponses HTTP consommées par l'application de bureau.
2. Remplacer les lectures de compte et d'archives, puis comparer silencieusement Supabase avec D1.
3. Ajouter les écritures doubles et les métriques de divergence.
4. Retirer le repli SIWC après migration explicite des anciennes identités et validation du flux Supabase Auth PKCE sur le domaine définitif.
5. Basculer Stripe et les archives après validation des transactions et de la copie Storage.
6. Publier une version desktop à double origine avant de changer le domaine public.
