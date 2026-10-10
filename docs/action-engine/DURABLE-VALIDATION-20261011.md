# Action Engine — lot A1 local, 11 octobre 2026

## Résultat et portée

Le registre D1 interne conserve une proposition immuable par entreprise/source/type, une réservation permanente attribuant les IDs métier et un reçu terminal. Le modèle ne possède aucune capacité d'écriture. Code : `31483afb1a76d0c1c6705d47c9a870dddc545999`. Ce lot **ne crée pas encore un client ou un devis dans Gestion** : il manque la composition d'admission réelle, la preuve de publication métier, l'intake Support, la commande native et la supervision raccordée.

Le contrat de reçu du noyau a été corrigé après inspection du vrai desktop 1.90.15 : un brouillon n'a pas de numéro. `quoteNumber` doit être NULL au moment de la création, même si le devis est émis ultérieurement. Aucun faux numéro ni commande d'émission.

## Fichiers créés

- `lib/action-engine/ledger-types.ts` : registre, réservations, résultats et barrière SQL serveur obligatoire.
- `lib/action-engine/ledger.ts` : persistance D1, assertions transactionnelles, journal, reprise et confirmation.
- `lib/action-engine/ledger.test.ts` : SQLite réel, historique de migrations complet, deux connexions et pannes.
- `lib/action-engine/ledger-d1.test.ts` : simulateur workerd/Miniflare de Wrangler épinglé, SQL et transactions D1.
- `db/action-engine-schema.ts` : déclarations du schéma.
- `drizzle/0099_action_engine_quote_ledger.sql` : migration additive proposée.
- `docs/action-engine/DURABLE-LEDGER-PLAN.md` : décisions, frontières et stratégie de migration.
- `docs/action-engine/NATIVE-ADAPTER-CONTRACT.md` : raccord natif précisément inspecté, encore à développer.

## Fichiers modifiés

- `db/schema.ts` : export du nouveau schéma.
- `lib/action-engine/types.ts`, `validation.ts` : reçu de brouillon non numéroté.
- `lib/action-engine/engine.test.ts`, `validation.test.ts` : création, historique, valeurs malformées et absence de coercition.
- `lib/action-engine/README.md` : état réel et limites.

La présente livraison, le statut et le manifeste de preuves sont ajoutés dans un commit documentaire séparé. Les copies natives et le dépôt utilisateur d'origine ne sont pas modifiés.

## Invariants vérifiés par les tests locaux

- Même identité + même empreinte : proposition d'origine ; autre empreinte : conflit, sans écrasement.
- Deux connexions/appareils : un seul propriétaire d'exécution. Aucun transfert automatique, même après un très long délai ou une réponse perdue.
- IDs client/devis figés ; un client existant peut servir plusieurs devis, mais un ID devis ne peut pas appartenir à deux propositions d'une entreprise.
- Barrière fausse ou NULL : transaction annulée, sans mutation, événement ni assertion résiduelle.
- Reprise non confirmée sur le même appareil : barrière `reserve` fraîche, pas simple lecture ; source/contexte modifiés refusés.
- Reçu corroboré seulement après preuve QA de publication exacte. Ces tables QA ne constituent pas la vérification de publication de production.
- Réponse perdue après COMMIT : erreur stable puis reprise par lecture, sans nouvel effet. ROLLBACK : aucun effet partiel.
- Reçu historique confirmé retrouvable malgré ancien catalogue/source devenus obsolètes, sous admission actuelle.
- Captures avant attente ; getters et coercitions refusés ; erreurs privées masquées.
- Propositions, identités des réservations et événements immuables. Tables WITHOUT ROWID et gardes de toutes les clés uniques contre REPLACE, même lorsque les triggers récursifs sont désactivés.
- Journal limité aux identités et étapes ; aucun corps d'e-mail, tarif, mot de passe ou clé API.

## Tests exécutés

Les preuves et empreintes sont consignées dans `docs/evidence/action-engine-ledger-20261011.json`.

| Vérification exécutée | Résultat |
| --- | --- |
| Vitest `lib/action-engine lib/automation` | **408/408**, 16 fichiers, aucun échec ni test en attente |
| Noyau Action Engine | 163 tests |
| Registre durable | 70 tests : SQLite réel 63, workerd/D1 7 |
| Régression Automation existante | 175 tests |
| TypeScript `--noEmit --incremental false` | Code de sortie 0 |
| Oxlint `lib/action-engine db/action-engine-schema.ts` | Code de sortie 0 |
| Contrôle des assets de marque | Code de sortie 0 |
| Build production Vinext | Code de sortie 0 |
| `git diff --cached --check` avant commit | Code de sortie 0 |

Le premier passage de régression comportait 407 tests ; le passage final en comporte 408 après ajout du cas de protection contre REPLACE par rowid. Aucun échec de test n'a été observé dans ce lot. Le build signale les avertissements existants sur `middleware` et la classification statique incomplète des routes Vinext ; sa réussite ne prouve pas un parcours hébergé. Les données sont fictives ; aucun fournisseur d'IA réel n'est appelé. Aucun essai natif, de session réelle, de QR-facture, de Stripe ou d'appareil physique n'est inclus dans ces résultats.

## Migration et retour arrière

Migration 0099 créée avec Wrangler contre une configuration locale sans accès de production. Elle ajoute quatre tables, leurs contraintes, index et triggers ; aucune table existante n'est supprimée ni vidée. Le journal Drizzle historique s'arrête à 0087 alors que les fichiers SQL atteignent 0098 : ce décalage antérieur est documenté, aucun historique existant n'a été réécrit.

Les tests appliquent le véritable historique SQL sur une base SQLite temporaire ; les tests D1 appliquent le nouveau SQL dans workerd local. Aucune migration distante/Supabase, aucun changement de région, abonnement, session ou donnée métier réelle. Le retour arrière opérationnel garde l'intégration désactivée, revient au code précédent et conserve les preuves ; pas de DROP automatique après création d'effets métier.

## Risques et limites restantes

La barrière SQL est un port interne **obligatoire**, sans défaut permissif. Elle garantit l'atomicité du prédicat fourni, pas sa justesse commerciale. L'adaptateur de production doit recorroborer session, délégation, membre, rôle, siège, Gestion + Automation, consentement, remboursements, expiration et action activée. Les branches non prises en charge doivent être refusées. Le contexte doit couvrir aussi l'identité et les archives des clients, pas seulement les articles.

La confirmation devra prouver une publication business-sync canonique et liée au reçu. Recevoir un JSON depuis la WebView ne suffit pas. Le registre ne garantit pas à lui seul un commit distribué D1 + SQLite. La réservation permanente peut rester bloquée si un appareil disparaît ; un rapprochement explicite et audité reste à construire.

Deux préparations concurrentes peuvent encore appeler le fournisseur avant la première sauvegarde : l'intake devra réserver cette préparation. Aucun routage Support, aucune création Gestion native, aucune notification utilisateur, aucun installateur ni appareil physique testés dans ce lot. Aucun déploiement. L'objectif global Action Engine reste en cours.
