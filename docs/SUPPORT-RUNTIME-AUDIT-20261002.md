# Audit serveur Support et Automation — 2 octobre 2026

## État vérifié

Checkout : `C:/Users/alb/Documents/ChatGPT/zentra-apple-design-20261001`. Branche `codex/support-runtime-corrections-20261002`, base `d2d563899609bfa62978050469ca99789c6d0dbf`.
Les correctifs ci-dessous sont locaux et non publiés. Aucun push, déploiement, paiement, envoi réel ou appel fournisseur de production réalisé par cet audit. Le lot est conservé dans un commit local de revue. Toutes les données des reproductions sont fictives, dans SQLite en mémoire.

## Deux défauts reproduits et corrigés

1. **Traitement ayant perdu son lease.** Avant correction, un remplacement de lease pendant l'analyse ou pendant le GET préparant une affectation Freshdesk fictive permettait au vieux worker d'envoyer un PUT. Deux tests rouges ont constaté exactement `expected 1 to be +0`. Le traitement vérifie désormais une prise encore valide avant les appels HTTP, renouvelle uniquement sa prise courante et vérifie le nombre de lignes modifiées pour la préparation et le résultat final. Une requête expirée ne peut pas reprendre sa propre réservation ; elle doit laisser un nouveau traitement la réclamer. Les événements de réussite et d'erreur ne sont écrits que pour le résultat effectivement enregistré. Le conflit public 409 reste distinct d'une panne réseau, même lorsque le transport masque son exception.
2. **Première création simultanée d'espace.** Deux appareils créant un espace pour le même compte échouaient avec `UNIQUE constraint failed: support_workspaces.owner_id`. L'index empêchait le doublon mais le handler signalait un échec. L'INSERT utilise maintenant `ON CONFLICT(owner_id) DO NOTHING` et retrouve l'espace gagnant. Les deux réponses contiennent le même ID, avec un seul espace et un seul événement de création.

Fichiers de production modifiés : `lib/support/service.ts` uniquement. Régressions : `lib/support/support.test.ts`, quatre cas supplémentaires (trois pertes/expiration de lease et une création concurrente).

## Validation locale après la dernière modification

- **607 tests réussis, 0 échec, 0 ignoré, 39 fichiers** : toutes les suites sous `lib/support`, `lib/automation`, `lib/supplier-inbox`, `lib/appointments` et `lib/company-mail`.
- Les trois régressions lease passent : perte pendant l'analyse ; perte pendant le GET fournisseur ; expiration sans successeur, puis nouvelle reprise qui effectue exactement un PUT et confirme l'état `routed`.
- Les suites préexistantes conservent le routage normal Zendesk/Freshdesk/Gorgias fictifs, la déduplication des rediffusions, les réservations de quota, l'isolation d'entreprise, les reprises de documents, et l'état `uncertain` qui empêche un second envoi de réponse après un timeout de soumission.
- TypeScript `tsc --noEmit` et `git diff --check` réussis.
- Rapport JSON réel : `C:/Users/alb/AppData/Local/Temp/zentra-support-runtime-audit-20261002.json`.

Commandes :

```text
node node_modules/vitest/vitest.mjs run --config vitest.config.ts lib/support lib/automation lib/supplier-inbox lib/appointments lib/company-mail --reporter=json --outputFile=C:/Users/alb/AppData/Local/Temp/zentra-support-runtime-audit-20261002.json
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

## Revue des chemins et limites

- Quotas Support : réservation atomique par INSERT conditionnel, identité de réservation distincte, décompte des réservations non expirées et facturation d'une analyse terminée. Aucune modification des règles commerciales.
- Réponses e-mail : préparation avant prise durable de soumission ; résultat ambigu conservé `uncertain` ; replay et double clic n'effectuent pas de seconde soumission dans les tests. Une acceptation du transport ne prouve pas la livraison au destinataire.
- Workflows : identité stable des éléments et des runs, contrôles d'organisation, rôle, délégation, version de règle/source et sièges. L'audit n'a pas ajouté de nouvelle action automatique.
- Factures/agenda : originaux et identités de réception dédupliqués par organisation. La piste d'un changement d'organisation du lien pendant la capture n'est pas retenue comme défaut accessible : `saveGestionLink` interdit ce changement et l'index `support_gestion_organization` impose un lien 1:1. Aucun guard supplémentaire inventé pour une modification directe de DB.
- Le contrôle de réservation protège les appels qui n'ont pas encore commencé ; il ne peut pas annuler rétroactivement une requête déjà reçue par le fournisseur. Les tests couvrent une perte pendant l'analyse ou le GET avant le PUT, et une expiration avant reprise, pas une transaction distribuée avec le fournisseur.
- **Point performance à mesurer ensuite** : EXPLAIN QUERY PLAN, sur toutes les migrations réelles dans SQLite en mémoire, montre `MATERIALIZE company_seats`, `SCAN m USING INDEX organization_members_active_idx`, un tri temporaire de la fenêtre, puis `SCAN w`. La recherche d'espaces Support calcule donc les rangs sur l'ensemble des appartenances actives avant le filtre utilisateur. Une éventuelle optimisation doit restreindre les organisations candidates, tout en gardant les autres membres de chacune pour calculer correctement le nombre de sièges. Aucun temps Cloudflare/Supabase ni seuil de capacité client mesuré ; ce point est une observation de plan, pas une promesse de gain.
- Tests locaux et revue ne certifient ni la charge production à 150 clients, ni la livraison des mails, ni les échanges réels avec Stripe/TypeSafe/Zendesk/Supabase. Aucun nouveau test natif ou package multiplateforme lancé dans cette étape.

## Inventaire de lecture et empreintes SHA-256

`intégrale` signifie que le corps du fichier a été relu ; `chemins ciblés` désigne les handlers, mutations, gardes, requêtes, fixtures ou régressions explicitement utilisés dans cet audit. Les fichiers simplement exécutés par Vitest ne sont pas présentés comme relus intégralement. Empreintes des fichiers locaux après correction, distinctes du SHA de commit de base.

| Fichier | Lecture | SHA-256 |
|---|---|---|
| `app/api/support/route.ts` | intégrale | `3596d0471ffeef21b0b2f1c8d8c0e16ffea37a5ca4a069ec6e2e84fdb7b334ba` |
| `app/api/support/mail-sync/route.ts` | intégrale | `107f3ab922c5cdd5d7f4bb61553352fbd9cd486e370021f28c9594a65dd2af37` |
| `app/api/support/hooks/[connectionId]/route.ts` | intégrale | `864a41306f32ab382ad5c29285d5ed1b69b336a655b59296d6fe9d8753b3cbaa` |
| `app/api/automation/route.ts` | intégrale | `3fbbe51ca3176be423b7480fdd543dbc67bba1778d65287774c5b96da5803616` |
| `lib/automation/access.ts` | intégrale | `b4d88ff51663d67f6b287d1e34a755fd85b49fe8c696101ff9e8782045c56595` |
| `lib/automation/entitlement.ts` | intégrale | `c6b4540962f939325d3c0a233834e116e2da0aafd41c1279ea75b7d3fda78d53` |
| `lib/automation/execution.ts` | intégrale | `2d72632c7934d07c1455392f6ed75084d5c8762c0f35434c249204361737c7f7` |
| `lib/automation/invoice-scan.ts` | intégrale | `e01c5aeb37b2e542c53c72db3ce8c0144ee0e8a40c34058d8479887aca062c02` |
| `lib/automation/provider.ts` | intégrale | `6883ef14c80af17db0daaedf9fc53298b08a69245bb83a29459219c11d04dced` |
| `lib/automation/transport.ts` | intégrale | `e997597adaf92ded4df700cb158dc4795355ee0ea2bf3ff4b09da608660102f0` |
| `lib/support/workspace-access.ts` | intégrale | `f0c8d9d794d2f689c88eb15f92a5011b8e28d8448e0a510101a6828d822e1893` |
| `lib/support/mail-sync-batch.ts` | intégrale | `75a98c1b18018a9a58bcfd2bebaee1c07677775bb584a54cd795feee39a20f41` |
| `lib/support/mail-sync-batch.test.ts` | intégrale | `2b8cde5907b484e4bac6b5ac8a68511d5b25e2c700cf27df7964fe4d4f413553` |
| `lib/runtime.ts` | intégrale | `08a49a1ea2a22c70c014e6ab84209caba9c56915595a132588204b758937c978` |
| `lib/supabase-server-runtime.ts` | intégrale | `08575c7bf2756d7bbc954011beec9a98fa263cbb0dba16143f036823068d7a73` |
| `vitest.config.ts` | intégrale | `41432102bfe7373907b7b1d18a7994ca33ab5908be93d57752ec425c14970fbf` |
| `lib/support/service.ts` | chemins ciblés | `42db413389e049ff1ebce0ba8c3d5d2796505b0842bb7ea8ff872f07d9010b91` |
| `lib/support/support.test.ts` | chemins ciblés | `1018186bc1ab09b918e2b4ef0ae070915dd7555026541ddb529f214635dbf3e5` |
| `lib/support/connectors.ts` | chemins ciblés | `4b69be29b969561f96e137fbc438e61753d9d851d4c4b64bc2c91251aa0e4b79` |
| `lib/support/mail-sync.ts` | chemins ciblés | `0100103430c73e74b9e4c3f92b81694f3bbd0fc6cb6b2f72714ab79f6965d465` |
| `lib/support/mail-claim.test.ts` | chemins ciblés | `062954c41165e28ef861c08cb402710abd2052ff8d65b603ad74bb30fa3124bb` |
| `lib/support/billing.ts` | chemins ciblés | `5ba1d88d1cc5b77bb8d77198099eca510b4f79a816fc6a67289f9f0caad45aaa` |
| `lib/support/billing.test.ts` | chemins ciblés | `1051afa01b75cd29bb090b7b9fc712a67f42493dee7a4218ba5c8c351600f06f` |
| `lib/support/jev.ts` | chemins ciblés | `0775d8f9406d3d8025b24e3b41294c9c38d3b0d02a308b32845b01a5a4e21b80` |
| `lib/support/reply-transport.ts` | chemins ciblés | `dd007971041adac10b584341e2a5f6a70b16ba48608d80aded5bf51300e216e5` |
| `lib/support/solicitation-service.ts` | chemins ciblés | `e333d92f588661bc526d6f00bb7595d0823a65db9bd0e72577f1993bc0d8a514` |
| `lib/support/solicitation-service.test.ts` | chemins ciblés | `a5dbc83e0ea8586803d80b344838592ce7498a7f82451b5927c3b0e4353400eb` |
| `lib/support/types.ts` | chemins ciblés | `d3f1602bb0c815665e575e1666a6d275550253b4f738ce0d8168ee50f7038936` |
| `lib/support/sender-policies.ts` | chemins ciblés | `beaa319355feffb67296f414bae881dfddb74a689ec15f69baf7ad0925ee5cc0` |
| `lib/support/productivity.ts` | chemins ciblés | `e5b72c07dad9a297644fc2b7fe0a4a09934ecf89ede9aecb8573324485940057` |
| `lib/automation/service.ts` | chemins ciblés | `16605c2d8b91d649a3d99a94c89294434ae3ebf8108069ca6cab132d9db3b65a` |
| `lib/automation/workflows.ts` | chemins ciblés | `75ecacce7db8842b4d460bc3db4ca13afd74a451d9367c3ff4b5623d91a361da` |
| `lib/automation/activity.ts` | chemins ciblés | `3dbf211ceddfb283d24291df5a6e522789460bef3636d4cc7137c7f3efa1286a` |
| `lib/supplier-inbox/service.ts` | chemins ciblés | `c44d12c7b39c6dbf7dc4a202a5a3bdec3fe6367966a6696c3cb922a6cefb5305` |
| `lib/supplier-inbox/capture.ts` | chemins ciblés | `830b0a25fdc77e664814e9c80d1e14ce0856d806eb687aaca43d5ced0758729f` |
| `lib/supplier-inbox/capture.test.ts` | chemins ciblés | `a1466844e90fca7d076c68aff2689b6d68ee182794a9469f156424254f8dbd1e` |
| `lib/appointments/service.ts` | chemins ciblés | `a61faf3ff1a4bf2227978edbc650a611ce34f108e12aa0896a045447a9d4c7a8` |
| `lib/appointments/service.test.ts` | chemins ciblés | `fbfc7c65ff99ba1e627e1ed7593c4a51783cb210c1ba6162526d272bca66b368` |
| `lib/supabase-server.ts` | chemins ciblés | `4845bbc30eb64236c2d7251dae03fa3b2e04f135981241b5b52e1c037cbb3175` |

## Complément : limiter le calcul des places aux entreprises du compte

Source : `64cb23cd4099f3934ba03d66d725558cc0bf14fc`, commit local non poussé et non déployé. L'ancienne requête classait les membres actifs de toutes les entreprises avant de chercher les espaces de l'utilisateur. La requête exportée limite désormais les entreprises candidates, tout en classant chaque membre actif de ces entreprises : les autres collaborateurs continuent à occuper leurs places. Les quatre paramètres, les rôles, les conditions commerciales et l'ordre des résultats sont conservés. `service.ts`, les index et les migrations ne changent pas.

La comparaison utilise les 69 migrations réelles, leurs contraintes et leurs triggers, avec 12 membres actifs et deux révoqués par entreprise. **657 comparaisons de résultats identiques** et 48 assertions passent ; un filtrage volontairement erroné des personnes avant le classement diverge pour 69 comptes à chaque volume. Les nouveaux tests vérifient aussi les quatre paramètres indépendants, les limites 1/3/10 et illimitée, le titulaire prioritaire, les rôles directs de Support et les comptes révoqués.

| Entreprises | Médiane avant → après | p95 avant → après |
|---:|---:|---:|
| 50 | 0,96 → 0,41 ms | 1,11 → 0,58 ms |
| 150 | 2,70 → 0,49 ms | 2,82 → 0,69 ms |
| 1 000 | 23,42 → 2,12 ms | 24,27 → 2,47 ms |

Ces mesures concernent la requête préparée dans SQLite local 3.53.3, après échauffement, sur 240 paires alternées. Les huit entreprises candidates comptent 96 membres actifs. La recherche des candidats et des espaces conserve des scans globaux : ce résultat ne mesure ni la latence D1, ni la concurrence, ni les coûts ou la capacité de production.

Validation du source : huit nouveaux cas ciblés ; **615 tests réussis dans 40 fichiers** Support / Automation / achats reçus / rendez-vous / e-mails d'entreprise ; TypeScript et `git diff --check` réussis. Les preuves, plans SQL et empreintes sont dans `C:/Users/alb/AppData/Local/Temp/zentra-support-workspace-sql-audit-20261002/report.json`. Le registre de lecture distingue les fichiers intégralement lus des seules plages examinées.

## Complément : connexion immédiatement après révocation

Le commit local `aeb49224e4227b43a63c6cf250082fe499a525cd` corrige une annonce de connexion réussie qui pouvait être suivie d'un refus dès la page suivante. La reproduction utilise les vraies routes, le client Supabase réel avec fournisseur synthétique et les 69 migrations SQLite : une nouvelle connexion par mot de passe et la révocation des anciennes sessions dans la même seconde recevaient un JWT avec `iat` égal au seuil de révocation. La condition stricte `iat > revoked_before` refusait ensuite cette nouvelle session, bien que la route de connexion ait déjà annoncé un succès.

La route n'écrit maintenant les cookies et le succès qu'après admission par la même règle de session. Seule une session créée par le mot de passe de cette requête peut attendre la frontière de seconde, puis demander **un renouvellement unique**. L'identité, l'adresse confirmée et la politique sont relues avant admission. Un jeton inchangé, une autre identité, une suppression, un seuil futur ou une seconde révocation restent refusés sans cookies d'authentification ni faux succès. Les anciens cookies ne passent pas par ce rattrapage. L'attente de frontière est bornée à 1,1 s ; les appels réseau gardent leur propre délai et le temps total n'est donc pas garanti à 1,1 s.

**15 nouveaux cas**, puis **702 tests réussis dans 46 fichiers**, TypeScript et diff-check passent. La revue précise de 33 fichiers complets et trois plages ciblées, les empreintes, preuves et limites sont consignées dans `C:/Users/alb/AppData/Local/Temp/zentra-auth-session-final-manifest-20261002.json`. Les migrations ont été exécutées comme fixture et ne sont pas présentées comme intégralement auditées. Aucun appel externe, aucune modification de JWT/politique/clé/migration ni déploiement dans ce lot.

Une autre course entre deux onglets a été reproduite séparément dans les composants réels : un renouvellement ancien du compte A peut terminer après les cookies de connexion B et remettre A dans le navigateur. La preuve `C:/Users/alb/AppData/Local/Temp/zentra-auth-ui-refresh-race-20261002-evidence.json` établit un affichage sous A, pas une écriture sous B. Cette course reste ouverte au moment de ce complément ; le correctif précédent ne prétend pas la résoudre.

## Complément final : admission du compte choisi malgré une réponse ancienne

Le commit local `f4ceed1367774b4a1b4419b09027e5c6f289c483` ferme l'admission sous le mauvais compte dans cette reproduction. Une authentification explicite, vérifiée auprès du fournisseur, pose désormais une barrière propriétaire HttpOnly, Secure, SameSite=Lax et `__Host-`, valable pendant 30 jours fixes. Les lectures et renouvellements doivent retrouver cette identité avant de retourner un compte ou d'écrire les cookies. Le renouvellement automatique ne crée ni ne prolonge la barrière. Confirmation d'adresse, signature fournisseur et politique stricte de révocation restent nécessaires : la barrière seule n'accorde aucun accès.

Les quatre reproductions initialement rouges passent sur Edge et WebKit, avec les vrais composants et routes. Les réponses tardives A écrivent encore effectivement leurs jetons dans la fixture ; la barrière B reste présente et la page protégée refuse A, puis une reconnexion explicite rétablit B. Ce correctif ne préserve pas les jetons B, n'annule pas les requêtes déjà authentifiées et peut donc demander une reconnexion. Les sessions anciennes sans barrière, malformées ou expirées doivent aussi se reconnecter. La déconnexion garde la barrière jusqu'à expiration mais le marqueur de déconnexion et l'absence de jetons interdisent l'accès.

Vingt nouveaux tests vérifient ces contrats, dont l'expiration fixe malgré des jetons renouvelés, les identités incohérentes, les anciennes sessions, l'ordre réel des écritures de cookies et les refus avant attribution d'accès. **722 tests réussis dans 47 fichiers**, TypeScript et diff-check passent. Le registre final `C:/Users/alb/AppData/Local/Temp/zentra-auth-owner-final-manifest-20261002.json` distingue 37 lectures intégrales et 21 lectures ciblées, conserve les empreintes, les quatre preuves avant/après et l'étude Web Locks. Cette dernière ne devient pas un correctif de production : les callbacks directs échappaient au verrou coopératif. Les transports et bases de test restent synthétiques ; ni sessions de clients, ni clés, ni données réelles n'ont été touchées. Aucun push, déploiement ou installateur dans ce complément.
