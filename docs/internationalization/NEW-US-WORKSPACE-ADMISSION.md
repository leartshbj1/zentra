# Admission d'une nouvelle entreprise US — plan audité

Revue locale du 8 octobre 2026, sources SITE au commit `cac324837a7a959e62b1c68e8d3be2e595feb133`. Ce document décrit la prochaine étape à implémenter. Le protocole de création et les protections proposées ci-dessous **ne sont pas livrés** par ce commit documentaire. Aucun code, migration, drapeau de production, prix, abonnement ou donnée client n'est modifié.

Le périmètre est une création explicite avec **un nouvel `organizationId`**, indépendant des entreprises CH du même compte. Le compte Auth reste le même et conserve ses entreprises CH et US ; ce parcours ne crée pas un utilisateur US distinct. Une migration d'un livre existant exige une procédure distincte, explicitement autorisée ; aucun backfill, reclassement ou rattachement automatique n'appartient à ce parcours. Voir aussi la [revue du démarrage national](./ONBOARDING-REVIEW-20261008.md).

## Constats vérifiés dans les sources actuelles

| Point | Preuve locale et conséquence |
| --- | --- |
| Première configuration US fermée | [workspace-server.ts:101](../../lib/international/workspace-server.ts#L101) appelle le port d'admission ; son [binding réel:130](../../lib/international/workspace-server.ts#L130) répond toujours `409 legacy_review_required`. Le [test de binding:81](../../lib/international/workspace-server.bindings.test.ts#L81) vérifie le refus sans RPC. Le chemin réel n'est pas une création US ouverte. |
| Pays absent ≠ entreprise neuve | [workspace-service.ts:97](../../lib/international/workspace-service.ts#L97) recherche le parent ; [ligne 100](../../lib/international/workspace-service.ts#L100) conserve l'état legacy inconnu lorsque la configuration manque. Ces lectures ne prouvent pas l'absence de snapshots, contenus préparés ou publications CH. |
| Verrou national local à PostgreSQL | Le [RPC national:173](../../supabase/migrations/20261007194528_international_workspace_country_config.sql#L173) verrouille un parent existant ; il crée [reçu et configuration:193](../../supabase/migrations/20261007194528_international_workspace_country_config.sql#L193). Il ne crée pas une attestation de nouvelle entreprise et ne verrouille pas D1. Les deux lectures HTTP de configuration ne couvrent pas les écritures legacy. |
| Achat actuel peut réutiliser une entreprise | [stripe-gestion-purchase.ts:250](../../lib/payments/stripe-gestion-purchase.ts#L250) choisit une cible existante ; son [draft:292](../../lib/payments/stripe-gestion-purchase.ts#L292) génère un identifiant, puis [insère l'entreprise:320](../../lib/payments/stripe-gestion-purchase.ts#L320). Ce draft d'achat n'atteste aucun démarrage national. Il ne faut pas en déduire une création US distincte. |
| Droits et abonnement restent dans D1 | [team-seats.ts:24](../../lib/team-seats.ts#L24) lit les droits de l'entreprise exacte via `organizations` et `subscriptions` ; le [binding national:128](../../lib/international/workspace-server.ts#L128) exige `subscriptionActive`. L'[index unique:104](../../drizzle/0004_zippy_harry_osborn.sql#L104) interdit de rattacher deux organisations au même `subscription_id`. |
| D1 peut préparer avant de publier | [beginBootstrap:240](../../lib/business-sync-bootstrap.ts#L240) crée un espace `initializing`, head zéro, dans un [batch:252](../../lib/business-sync-bootstrap.ts#L252). Les [chunks:563](../../lib/business-sync-bootstrap.ts#L563), la [publication:231](../../lib/business-sync-publication.ts#L231), les [transactions:193](../../lib/business-sync-transactions.ts#L193), leur [commit:402](../../lib/business-sync-transaction-commit.ts#L402) et la [copie publiée:21](../../lib/company-copy.ts#L21) sont des écritures distinctes à protéger. |
| PG peut recevoir sans head publié | [prepareCollaboration:66](../../lib/company-collaboration.ts#L66) insère directement le parent, puis [snapshot:82](../../lib/company-collaboration.ts#L82) et [chunk:106](../../lib/company-collaboration.ts#L106). Le [prepare de contenu:32](../../supabase/migrations/202609200300_company_content.sql#L32) peut aussi créer le parent, avec contenu préparé avant publication. |
| Numérotation à deux autorités | La [route:37](../../app/api/sync/numbers/route.ts#L37) choisit PG si sa révision est positive, sinon D1. Le [SQL D1:61](../../lib/document-number-reservations.ts#L61) et le [RPC PG:79](../../supabase/migrations/202609140200_company_collaboration.sql#L79) ne constituent pas une admission nationale. Bloquer une seule branche laisserait un autre chemin legacy. |

## Contrat minimal de création

Une action de compte distincte, « Nouvelle entreprise aux États-Unis », présente le choix national et un résumé avant confirmation : nom, US, USD, adresse, fuseau, méthode cash/accrual et préfixe. Le serveur alloue l'identifiant ; le corps client ne choisit pas un ancien `organizationId`. Langue anglaise, ZIP, EIN, configuration absente, révision zéro ou booléen client ne sont jamais des attestations.

L'EIN reste facultatif. Le reçu lie l'acteur, l'identifiant alloué, le `requestId`, une version de confirmation et une empreinte de configuration. Les identifiants fiscaux privés ne sont pas recopiés dans les réponses publiques ou journaux. Une même clé avec un contenu différent produit un conflit ; un retry exact reprend la même création.

Le premier parcours peut partir de la session navigateur du compte. Un bearer d'appareil lié à une entreprise existante n'autorise pas implicitement une autre création. L'identité et la politique de création de compte sont contrôlées avant réservation ; l'appartenance owner et les droits de la nouvelle entreprise sont revalidés avant son ouverture. Les états en attente restent accessibles au seul parcours de reprise autorisé, sans devenir des entreprises activables par les anciens transports ou appareils.

### États durables proposés

| État de l'intention D1 | Condition et accès |
| --- | --- |
| `reserved` | Dans une transaction/batch atomique D1 : réserve le couple acteur/`requestId`, l'identifiant neuf et l'empreinte, puis les lignes de compte nécessaires à cet identifiant. Les écritures legacy sont déjà interdites. Aucun accès métier US n'est annoncé prêt. |
| `postgres_confirmed` | Après vérification d'un reçu PG durable lié exactement à cette intention. Un CAS D1 conserve le reçu et sa version. Il ne suffit pas qu'un appel HTTP ait répondu 200 ou qu'une configuration US quelconque existe. |
| `ready` | Le reçu concorde, les droits propres à cette organisation sont valides et la finalisation D1 a réussi. L'entreprise devient sélectionnable et accessible au moteur US. Les écritures CH legacy restent interdites pendant toute sa vie. |

Ces noms décrivent un contrat futur, pas une table existante. L'intention conserve aussi les informations de reprise et l'erreur exploitable. Son identité et son édition ne deviennent pas réutilisables pour CH après un échec ou un abandon.

La réservation D1 refuse un identifiant déjà présent dans `organizations`, les espaces/transferts métier, les copies publiées ou leurs références. Elle ne « certifie » pas un identifiant ancien par inspection de vacuité. L'absence d'intention conserve le comportement legacy existant ; elle ne constitue aucune preuve de juridiction CH.

## Allocation PG et exclusion des transports CH

Une nouvelle opération serveur PG doit créer, dans **une même transaction**, le parent complet, une attestation US immuable et le reçu national initial. Elle utilise un INSERT strict : tout parent préexistant, même à révision zéro, est refusé. Seul le replay d'un reçu déjà lié à l'intention exacte est accepté. Le parent réel contient notamment `revision`, `snapshot_id` et `number_floors` ([schéma:5](../../supabase/migrations/202609140200_company_collaboration.sql#L5)).

Les nouvelles preuves et opérations restent réservées au serveur, avec RLS et privilèges explicites ; aucun client anon/authenticated ne peut créer ou modifier une attestation. Préserver la séparation actuelle des [tables nationales:202](../../supabase/migrations/20261007194528_international_workspace_country_config.sql#L202) et de l'[exécution du RPC:213](../../supabase/migrations/20261007194528_international_workspace_country_config.sql#L213), sans ouvrir les anciens transports ni fournir une clé privilégiée aux appareils.

Le RPC national et ses protections SQL doivent vérifier l'admission lors de la première écriture US, sous le verrou du parent. Le port HTTP donne une erreur utile, mais ne remplace pas cette garantie au moment de l'écriture. Une lecture puis un PUT ultérieur laisserait une course. Un `FOR UPDATE` sur une ligne absente ne réserve pas l'identifiant : l'INSERT strict et l'unicité du parent règlent la compétition de création.

Chaque autorité sérialise ses propres écritures. **Il n'existe pas ici de transaction ou de verrou distribué D1/PG.** L'ordre requis est : réserve D1 et ferme ses transports legacy → crée et atteste atomiquement dans PG → vérifie le reçu → finalise D1. Une panne intermédiaire conserve la fermeture.

Les protections suivantes doivent être installées avant de brancher une admission US positive :

| Autorité / fichiers futurs concernés | Protection exigée à l'écriture |
| --- | --- |
| D1 : `business-sync-bootstrap.ts`, `business-sync-transactions.ts`, `business-sync-publication.ts`, `business-sync-transaction-commit.ts`, `company-copy.ts` | Contrôle atomique d'absence d'intention US dans les mutations legacy, avec contraintes/triggers ou prédicats SQL couvrant aussi la préparation et les uploads. Aucune publication, copie canonique, écriture transactionnelle ou avance de head CH sur un identifiant réservé/confirmé/prêt US. Un précontrôle applicatif seul est insuffisant. |
| PG : `company-collaboration.ts`, `company-content.ts`, futures migrations additives | Garde SQL pour les INSERT/UPDATE directs de snapshots, chunks, parts et blobs ; même verrou de parent et même vérification d'édition que les RPC. Protéger [prepare:33](../../supabase/migrations/202609200300_company_content.sql#L33), [réservation de blob:57](../../supabase/migrations/202609200300_company_content.sql#L57) et [commit:90](../../supabase/migrations/202609200300_company_content.sql#L90). Aucun contournement via accès `service_role` normal ou préparation non publiée. |
| Numérotation : `app/api/sync/numbers/route.ts`, `document-number-reservations.ts`, RPC PG legacy | Interdire les deux réservations legacy pour l'identifiant US. Le choix de transport doit suivre l'édition admise, sans repli CH fondé sur une révision zéro. Préserver séries et réservations des organisations CH existantes. |
| Création/lecture de compte et accès appareil | Masquer ou refuser l'activation des intentions incomplètes, y compris via listes d'entreprises, invitation, connexion d'appareil et ancien resolver. Le statut `ready` doit être vérifié côté serveur, sans accepter une déclaration client. |

Si une préparation CH PG crée le parent avant l'allocation US, l'allocation US échoue et n'adopte pas ce parent. Si la transaction US crée le parent et son attestation en premier, une préparation legacy doit constater cette attestation sous verrou et échouer, y compris après un `ON CONFLICT DO NOTHING` ancien. Tester aussi les INSERT directs : ajouter un contrôle au seul RPC de commit ne ferme pas la préparation.

Les objets de stockage sont extérieurs à la transaction PG. Exiger une réservation autorisée avant upload et une garde à l'enregistrement/finalisation ; traiter séparément les objets orphelins d'une réponse perdue. Une garde SQL sur le reçu ne prouve pas, seule, qu'aucun octet n'a été envoyé au stockage.

## Reprise et droits

- Échec ou indisponibilité PG : l'intention reste `reserved`, les accès métier et transports CH restent fermés. Aucune suppression d'historique, réutilisation de l'identifiant ou conversion du livre CH pour « débloquer » le parcours.
- Commit PG réussi, réponse perdue : le retry exact retrouve le même reçu et le vérifie ; il ne crée ni seconde entreprise, ni seconde révision initiale, ni nouvel événement de confirmation.
- Réponse de finalisation D1 perdue : relire l'intention et reprendre par CAS. Un état déjà confirmé/prêt avec le même reçu est un succès idempotent ; une empreinte ou identité différente est un conflit.
- Droits retirés pendant l'attente : refuser l'ouverture finale. Une attestation déjà durable n'est pas réécrite pour annuler silencieusement l'opération ; conserver la reprise contrôlée et la trace de l'état intermédiaire.
- Le même compte peut posséder CH et US, avec caches, session appareil, vendeur, livre et numéros séparés par organisation/édition. Ne jamais réaffecter le livre local d'un ancien PC CH au nouvel identifiant US.
- **Ne pas copier le `subscription_id` CH.** Son unicité est explicite. La nouvelle entreprise exige ses propres droits vérifiés, selon une politique de produit à définir. Aucun Price ID CHF ne devient USD et aucun module n'est activé gratuitement par le choix du pays.

La fiscalité reste `unconfigured` tant qu'un fournisseur réel n'est pas configuré et vérifié. La création nationale n'est ni une certification fiscale, ni une activation d'offre US. Ce document ne modifie aucun prix.

## Lot d'implémentation proposé

1. Ajouter un service et une route de création/reprise d'espace de travail US, indépendants du ciblage de l'achat actuel. Réutiliser les validateurs nationaux ; conserver le refus actuel pour toute première configuration sur un espace legacy non attesté.
2. Préparer une migration D1 additive d'intentions et les gardes atomiques des écritures legacy, sans backfill. Faire couvrir leurs mutations réelles avant d'exposer l'identifiant aux listes et appareils.
3. Préparer une migration PG additive d'attestation, d'allocation stricte et de gardes sur les tables/RPC existantes. Lier le reçu à l'intention, puis brancher le port d'admission serveur uniquement sur ce contrat durable.
4. Ajouter la reprise idempotente et la finalisation des droits. Définir séparément l'offre/entitlement de la nouvelle organisation ; l'absence de cette configuration bloque `ready` sans toucher l'abonnement CH.
5. Ajouter la confirmation propriétaire et le routage d'édition des appareils. Dans le clone natif audité au commit `0f53e632982fdc9cdc43d5e5a322aa33cb565571`, `desktop/src-tauri/src/company_account.rs:86` démarre le resolver legacy et `:102` peut retourner `ready` pour un espace déjà lié. Le nouveau routage doit préserver ce fonctionnement CH et empêcher qu'une sélection US passe par création/publication/restauration CH. L'attestation doit précéder tout rattachement US d'un livre local.

Ce lot nécessite une revue de chaque chemin de création et écriture ; la liste ci-dessus cible les chemins effectivement lus, sans prétendre constituer un inventaire exhaustif des accès de compte, stockage ou transports.

## Tests et critères d'admission avant ouverture

| Lot à réaliser | Résultat exigé |
| --- | --- |
| Services/HTTP (`workspace-server*.test.ts`, nouveaux tests de création/reprise) | Action explicite, identifiant serveur neuf ; preuve/role/identifiant client falsifiés refusés ; confusion A/B et révocation owner refusées ; même `requestId` avec autre contenu en conflit. Un espace ancien apparemment vide reste refusé. |
| D1 réel en environnement isolé | Réservation atomique face à bootstrap/prepare/publication/transaction/copie/numérotation legacy ; aucune mutation du livre ou des séries CH. Tests de réponse PG perdue, finalisation D1 perdue et reprise après interruption. Étendre notamment `business-sync-d1.test.ts`, les tests bootstrap/publication et `document-number-reservations.test.ts`. |
| PG avec schéma de collaboration complet | Refus d'un parent à révision zéro avec snapshot, parts/blobs préparés ou séries ; refus également du parent préexistant sans contenu. INSERT directs et RPC legacy bloqués après attestation. Même reçu exact rejoué une seule fois ; accès anon/authenticated refusés. Étendre les tests country, collaboration et contenu. |
| **Deux connexions PG distinctes en staging** | Orchestrer explicitement les verrous, sans prendre un délai arbitraire pour preuve. CH prend/crée le parent avant US : US refusé. US crée parent + attestation avant CH : CH refusé. Vérifier l'attente, libérer la transaction, puis comparer parent, reçu, contenus et séries. Aucun état final mêlant US et livre CH. |
| D1 staging et reprises interservices | Vérifier séparément le comportement de D1 face aux requêtes concurrentes et pannes aux trois frontières de finalisation. Ne pas présenter deux connexions PG comme preuve de sérialisation D1/PG. |
| Navigateur et ancien appareil hors ligne | Compte avec CH existant → nouvel US distinct → sélecteur cohérent. Retour de l'ancien PC sur son identifiant CH ; aucun upload ou rattachement au nouvel US. États pending/refus/timeout lisibles, reprises exactes, droits et contenus utilisateur conservés. |

Les futurs tests ne sont pas annoncés réussis ici. Aucun test de code n'est relancé pour ce seul document ; les références sont vérifiées sur les sources locales indiquées.

## Limites de preuve et condition de livraison

Le fixture [workspace-service.postgres.test.ts:34](../../lib/international/workspace-service.postgres.test.ts#L34) crée un parent réduit à `organization_id` dans une base PGlite en mémoire ([isolation:12](../../lib/international/workspace-service.postgres.test.ts#L12)). Il valide certains contrats nationaux locaux. Il ne prouve pas l'absence de données CH, les protections de la collaboration complète, deux connexions PostgreSQL réelles, la cohérence D1/PG ou une capacité de production. La [revue précédente:115](./ONBOARDING-REVIEW-20261008.md#L115) formule déjà cette limite.

L'ouverture US reste conditionnée aux gardes durables, aux tests staging ci-dessus, aux droits/offres réellement configurés et au routage d'appareil vérifié. La publication d'une visite produit ou la présence d'écrans pilotes ne remplit aucune de ces conditions. Aucun parcours fiscal réel, essai physique multi-appareils, déploiement de migration ou activation US en production n'est attesté par ce plan.
