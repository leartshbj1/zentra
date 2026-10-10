# H4 — réception et classement Support US en arrière-plan

Base `083d02b`. Jalon local incrémental de la phase F ; aucun serveur, compte client, abonnement CH, région ou application distribuée n'est modifié. La mission internationale complète reste ouverte.

## Résultat visé

Après l'accord explicite d'un propriétaire/administrateur, une boîte de l'espace US est consultée en arrière-plan. Les nouveaux messages admissibles utilisent le même budget, la même déduplication et le même dispatch unique que H3a, puis deviennent les tickets H3b partagés. Le traitement s'arrête en cas de révocation, remplacement de boîte, perte de droit commercial, changement de politique accepté ou fermeture de gate. Il n'a aucun port pour envoyer un e-mail, acquitter/supprimer un message, comptabiliser ou payer.

Le worker possède un principal distinct et traçable. Il ne fabrique ni session navigateur, ni bearer utilisateur, ni session native pour appeler une route interactive. Le membre qui délègue et l'exécuteur automatique sont distingués dans la preuve. Les lignes historiques restent interprétées selon leur contexte d'origine.

## Éléments actuels relus

- `worker.ts` n'expose que `fetch` ; le relay/scheduler et `lib/support/mail-sync.ts` actuels ciblent le Support legacy CH. Ils doivent rester intacts.
- H1 établit l'entreprise US et les droits Gestion/Support d'une même période payée. H2a conserve une connexion chiffrée. H3a réserve et clôture un dispatch durable ; H3b conserve un ticket sans corps du mail.
- Les contextes privés et gardes SQL H1–H3b acceptent actuellement uniquement les credentials humains navigateur/appareil. Une délégation ne se réduit pas à une option de cron : elle exige une autorité worker fraîche, bornée et révocable, et des gardes SQL propres.
- La consultation H2a borne la pagination à 200 et utilise une date liée à la vérification de boîte ; elle ne constitue pas une preuve de réception exhaustive. Un watermark de date seul ne garantit pas la découverte d'un message tardif ou déplacé.

## Réalisation

1. Définir la délégation consentie, son reçu idempotent, sa révocation et un contexte worker discriminé ; vérifier les droits SaaS, le membre délégateur, la connexion et la politique courants à chaque frontière asynchrone.
2. Ajouter des migrations D1 versionnées et des gardes de bail/fencing. Partager H3a/H3b plutôt que créer un budget ou un second registre de tickets incompatibles.
3. Raccorder un service de classification commun, indépendant des routes HTTP, et une orchestration bornée avec découverte/reprises persistantes. Un dispatch ambigu ne peut jamais autoriser une nouvelle inférence.
4. Exposer une configuration simple FR/EN/DE/IT, l'état réel et les problèmes à reprendre. L'activation n'importe pas silencieusement tout l'historique. Les interfaces mobiles restent utilisables et les brouillons/reprises ne sont pas acquittés par un simple rechargement.
5. Tester sur données fictives les conflits, les baux expirés, la révocation en vol, les changements de boîte/politique/période, le budget, les messages illisibles, les réponses perdues et le raccord jusqu'au ticket. Exécuter les régressions CH/US, TypeScript, lint et build ; consigner les preuves et limites dans la livraison à huit rubriques.

## Points à établir avant activation réelle

La pagination et la stabilité de la source Infomaniak doivent être vérifiées dans ses sources primaires. Les garanties faibles du fournisseur seront signalées plutôt que converties en promesse de livraison sans pertes. Le contenu envoyé au modèle, les contrats, les transferts et les durées de conservation restent soumis aux éléments de recherche existants et à l'examen professionnel applicable.

L'application des migrations ou gates hébergées, la configuration d'un déclencheur réel, les appels au fournisseur et les essais multi-appareils réels demandent leur validation explicite. Retour arrière : fermer la gate et revenir au code précédent en conservant reçus, délégations révoquées et historique ; aucune purge n'est un rollback autorisé.
