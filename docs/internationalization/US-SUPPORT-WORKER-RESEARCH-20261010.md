# Support US H4 — limites du connecteur et du scheduler

Relevé du 10 octobre 2026. Ce document complète `US-SUPPORT-AUTOMATION-RESEARCH-20261008.md` ; il n'annonce pas une validation juridique ni une ouverture commerciale.

## Exécution planifiée

Cloudflare appelle le handler `scheduled()` depuis un Cron Trigger. `controller.cron` permet de distinguer les déclencheurs ; `scheduledTime` est un instant UTC en millisecondes. Le handler peut attendre directement une promesse. La configuration du déclencheur est distincte du code : ajouter le handler n'installe pas un cron hébergé. [Handler Scheduled](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

H4 n'ajoute pas de route HTTP publique de lancement. La route humaine sert uniquement à lire, consentir et révoquer. Le handler ne reconnaît que le motif minute prévu, un profil de déploiement cohérent et toutes les gates actuelles. Aucun Cron Trigger réel n'a été provisionné pendant ce jalon.

## Budget D1 : une limite distincte du quota d'analyses

La documentation D1 limite une invocation à 50 requêtes sur Free et 1 000 sur Workers Paid. Les limites par requête s'appliquent à chaque statement d'un batch ; grouper un millier d'instructions dans `batch()` ne les transforme pas en une requête. D1 traite les requêtes d'une base de manière séquentielle ; un test SQLite local n'établit donc ni débit hébergé ni capacité multi-entreprises. [Limites D1](https://developers.cloudflare.com/d1/platform/limits/).

La première instrumentation réelle a trouvé **2 667 statements pour un seul message**, avant optimisation. Ce résultat est un défaut corrigé dans le jalon, pas une mesure de performance acceptable. Le résolveur d'autorité automatique regroupe les faits durables courants dans une observation SQL et applique ensuite les validations pures du catalogue et du workspace. Il ne mémorise pas une autorité entre deux frontières asynchrones. Le coffre joint aussi l'admission actuelle à sa lecture privée.

Après correction, le scénario nominal mesure 434 statements ; une file de cinq messages n'en traite qu'un et mesure 432. Le scénario combinant tête, backfill, résolution de version et ticket à vérifier atteint 494 ; la réconciliation d'un ticket existant mesure 77, et la reprise d'un résultat terminé sans clé modèle 43. Les tests de composition imposent une borne de 800 statements par passage. Ces valeurs excluent les observations hébergées et les lectures de configuration propres au déploiement. Même la réconciliation mesurée dépasse Free : le pilote exige Workers Paid. Aucun débit commercial ni capacité de 150 entreprises n'est déduit de ces mesures.

Une invocation acquiert au maximum un bail de 120 secondes et traite un seul message. Le déclencheur minute est global : les entreprises se partagent ce débit, il ne fournit pas un passage par entreprise et par minute. Un fan-out durable ou une autre organisation de la file doit précéder un lancement à grande échelle.

## Découverte et identité des messages

Le connecteur existant est une API de fils paginés par offset. Le dépôt officiel Infomaniak documente aussi la liste de fils avec `limit`/`offset`, puis la lecture par identifiant de message ou UID avec un champ de date. [Contrat Mail officiel Infomaniak](https://github.com/Infomaniak/mcp-server-mail#tools).

H4 rafraîchit la tête pendant le parcours des pages et conserve les références observées avant le traitement. Cela évite de perdre sa propre file après interruption. Dans le contrat examiné, aucune preuve de snapshot atomique, curseur de réception durable, UIDVALIDITY ou date d'arrivée indépendante du champ Date n'a été établie. Il s'agit d'une limite de la preuve disponible et de notre adaptateur ; elle ne démontre pas que le fournisseur ne possède aucune autre API adaptée.

L'accord fixe un instant de départ. Le texte de l'interface précise que les **messages datés à partir de l'activation** sont admissibles ; il ne promet pas « tous les messages arrivés après activation ». La date réelle fournie lors de la lecture du message est vérifiée avant une nouvelle réservation et avant un nouveau dispatch. Une date ancienne empêche une nouvelle réservation ; une réservation déjà établie reste comptée si le renouvellement du consentement interdit ensuite son dispatch. Un résultat historique déjà completed reste récupérable sans nouvel envoi au modèle. Une source effacée/déplacée avant découverte ou un message antidaté peut rester absent : une garantie exhaustive demande un connecteur offrant les preuves appropriées.

Les réponses de page sont bornées, les références illisibles ont une empreinte sans contenu, et les erreurs transitoires retournent dans la file sans monopoliser les premiers éléments. Les pièces jointes ne sont pas lues par ce worker. L'import explicite H2b et le coffre d'originaux restent des parcours distincts.

## Portée de l'accord et du traitement

Le propriétaire/administrateur confirme la boîte exacte, les politiques et la durée (7, 30 ou 90 jours dans l'interface). La délégation est révocable et liée au membre actuel de l'entreprise. Le principal worker reste distinct d'une session humaine, possède un bail limité et ne reçoit que le droit de classifier puis créer un ticket. Il ne peut ni répondre, ni acquitter/supprimer un message, ni modifier un ticket existant, ni comptabiliser, ni payer.

Le texte des messages est envoyé au service d'analyse configuré. L'accord fonctionnel ne suffit pas à établir une base juridique ou un contrat de sous-traitance. Les vérifications de DPA, sous-traitants, transferts, données sensibles et durées de conservation identifiées dans le relevé précédent restent ouvertes avant usage réel. Aucune résidence US/Suisse, certification, rétention zéro ou conformité globale n'est annoncée.

## Avant une recette hébergée

Il faut approuver le périmètre staging, valider la chaîne de migration et sa méthode d'application, provisionner explicitement le déclencheur et les credentials de test, contrôler la disponibilité D1 correspondant au budget, puis mesurer les invocations, erreurs et courses sur le runtime hébergé. Les tests locaux utilisent exclusivement des données fictives. Aucun tarif USD, abonnement CHF, région Supabase ou compte client n'est modifié ici.
