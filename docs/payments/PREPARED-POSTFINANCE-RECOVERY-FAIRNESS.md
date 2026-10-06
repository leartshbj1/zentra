# PostFinance — assemblage local recovery 0081 et fairness 0082

Assemblage préparé dans `D:/Codex-Zentra-Temporary/2026-10-06/site335-postfinance-recovery-fairness-assembly`, à partir de Site335 `3b4125151b59a86b8b5e8a19eb83ba96c810a9ee`. Aucun commit, déploiement, accès à une base hébergée, paiement ou activation n’a été effectué. Le checkout canonique n’a pas été écrit et le stash `982a44386076a6fb87fe3bbdadc7ed3f70c26f51` n’a été ni appliqué, ni supprimé.

## Contenu exact

Le patch et l’archive contiennent douze fichiers : les sept du prototype recovery lus directement par `git show` dans le stash (trois fichiers suivis et quatre dans son troisième parent), et les cinq du prototype fairness relu à ses hashes gelés. Les cinq hashes de source du rapport recovery correspondent exactement. Le fragment fairness est maintenant `drizzle/0082_prepaid_renewal_admissions.sql`, avec ses octets gelés conservés.

Le journal ajoute seulement l’entrée 82 après l’entrée 81 du stash ; les objets 0–81 sont inchangés. Les 81 migrations publiées 0000–0080 sont byte-identiques au canonique et aux manifestes des preuves. Aucun ancien SQL, snapshot ou fichier de téléchargement n’est inclus dans le patch.

Une seule adaptation de test est nécessaire : la fixture `prepaid-worker-selection.test.ts` n’exécute plus le fragment SQL séparé après sa boucle des migrations, puisque la vraie 0082 y est déjà appliquée. La logique de production gelée reste inchangée.

## Comportement et limites

La récupération CREATE est une brique interne GET-only, sans import par une route ou un worker. Elle exige les données locales gelées, un claim financier exact `claimed` ou `uncertain`, une recherche complète et unique, deux lectures égales puis une nouvelle recherche stable. Son batch atomique lie l’ID fournisseur, le reçu CREATE et sa provenance ; il ne crée aucune preuve de règlement ni aucun droit. Une absence, une ambiguïté ou un changement ne permet jamais de renvoyer CREATE.

Un reçu CREATE récupéré peut seulement rejouer son résultat. Une observation déjà avancée est réservée au rapprochement. Si un futur appel explicite poursuit une observation PENDING, la logique existante exige à nouveau une lecture PENDING valide et toutes les clôtures de dispatch avant la première opération suivante. Aucun claim confirm ou ChargeFlow incertain n’est réinitialisé par recovery.

Fairness acquiert un bail de planification atomique, conserve toutes les conditions de mandat, propriétaire, cible, catalogue et preuve, puis reporte uniquement les refus du contrôle GET de mandat. Un contrat refusé ne bloque plus l’entreprise suivante. L’expiration de ce bail ne libère jamais une opération financière ; les CREATE ou ChargeFlow incertains restent exclus de la sélection. Le worker garde ses flags existants OFF par défaut et un renouvellement maximum par invocation. Aucun nouveau flag n’a été ajouté.

La revue indépendante n’a démontré aucun défaut d’interaction entre les deux briques. Les autres erreurs de configuration, base ou liaison conservent le 503 existant. Ce travail ne prouve ni la présence des champs sur un vrai compte marchand, ni un encaissement LIVE, ni la capacité de production. Les objets fournisseur, clés, identités, approbations et règlements des tests sont fictifs.

## Vérification fraîche de l’assemblage

- 344 tests Vitest dans neuf suites, plus 34 contrats du client : **378 tests passent**. Les deux nouvelles suites privées passent 15/15 et 22/22. Le fichier billing-worker-route.test.ts est absent de HEAD335 ; les 17 cas historiques sont dans worker-selection.test.ts (28/28 avec fairness), et lifecycle.test.ts couvre les refus HTTP de la vraie route.
- TypeScript global, lint ciblé et `git diff --check` passent.
- Les huit fichiers de code possédés passent le format. `db/schema.ts` présente un écart de format déjà identique dans HEAD335 ; ses octets exacts du stash sont conservés, sans reformater les anciennes définitions.
- `recovery-fairness-create-d1-result-01.json` : **7/7**, vrai D1 local, 83 migrations et 559 instructions, récupération sans POST et rollback réel du batch.
- `recovery-fairness-worker-d1-result-01.json` : **14/14**, même assemblage 83/559, vrai worker, report du premier mandat puis progression de l’autre entreprise, réponse ChargeFlow perdue sans second POST, huit acquisitions concurrentes, refus du bail périmé et rollback.
- `recovery-fairness-parser-d1-result-01.json` : les **neuf chunks officiels Wrangler** (0081 : cinq, 0082 : quatre) correspondent token par token aux breakpoints et sont chacun exécutés par `D1.prepare().run()` après les 550 instructions historiques. Les trois vues de droits contrôlées compilent.
- Zéro tentative HTTP externe dans chaque preuve. Les preuves précédentes sont conservées et rehashées, sans réutiliser leur ancien résultat comme succès de cet assemblage.

Les suites D1 utilisent deux bases locales distinctes, mais chacune charge et exécute les deux nouvelles migrations et le code assemblé. Elles ne constituent pas une validation d’intégration marchande réelle. Les contrôles d’expiration/backoff tardifs avancent uniquement l’horloge injectée de planification, sans appel fournisseur à cette heure décalée.

## Livraison et intégration après publication native

`recovery-fairness-assembly.patch` est vérifié par `git apply --check --cached` contre HEAD335. `recovery-fairness-assembly-files.zip` fournit les octets exacts des douze fichiers. `recovery-fairness-assembly-report-final02.json` donne leurs hashes, les six hashes de base suivis et les hashes des preuves. La nouvelle 0082 contient les mêmes CRLF que le fragment gelé : l’archive est la référence pour une comparaison byte-exacte.

Root peut intégrer après Site336 si ce nouveau HEAD ne modifie que les téléchargements et si les douze fichiers correspondent aux hashes de base enregistrés. Ne pas appliquer aveuglément sur d’autres changements, ni appliquer à nouveau le stash par-dessus le patch. Toute normalisation de fins de ligne doit être identifiée et les preuves rehashées avant publication. L’assemblage ne change aucun réglage marchand, secret, mandat, scheduler ou flag LIVE. L’intégration et l’activation restent des décisions séparées.

## Intégration canonique du 6 octobre 2026

L’intégration a été exécutée après Site336 `0e53920519638c5395bd97649ff03f35b5af63f2`, qui modifie uniquement les deux fichiers de téléchargements. Les contrôles réels `--check` puis `--apply` ont vérifié les douze fichiers, les 81 migrations historiques, le journal et le stash. Le stash reste conservé ; ne pas l’appliquer par-dessus cet ensemble intégré.

Une seule adaptation des octets a suivi la copie : la nouvelle migration 0082 passe de CRLF à LF pour correspondre à son futur blob Git. Son hash est désormais `0832c0d89135251e51cb34c34bf9cef28346f5e51ed7675e9ff45bb557be427c`, au lieu de `82b2e67b0c2f358df4b9673ceb704f2e47be69e0b3f162095cb23710c2d2aabd`. Aucun contenu SQL ni fichier historique n’a changé. Les anciennes preuves sont conservées.

Les preuves canoniques fraîches `canonical-lf-create-01.json`, `canonical-lf-worker-01.json` et `canonical-lf-parser-01.json` passent respectivement 7/7, 14/14 et 3/3 sur 83 migrations et 559 instructions, sans HTTP externe. Le découpage officiel conserve cinq instructions pour 0081 et quatre pour 0082. Les 378 tests du client et des routes, TypeScript, le lint ciblé et le build passent également dans le checkout canonique. Ces résultats n’activent aucun paiement et ne prouvent aucun règlement marchand réel.

## Reprise bornée après l’échec de migration Site337

Le déploiement `appgdep_6ac501fbaeb48191b75e56d33fadf4bc`, source `a8eb09aad7c2d3cf063a9be9a919903468c21593`, a refusé la migration avec `incomplete input: SQLITE_ERROR`. Son archive et ses preuves sont conservées. Le migrateur Drizzle D1 installé réussit localement ; le migrateur interne Sites et son watermark hébergé ne sont pas accessibles avec les outils disponibles. L’aperçu des cinquante premières tables ne prouve pas l’absence des deux tables nouvelles.

Un test D1 local isolé observe que `exec()` refuse une ligne de commentaire seule avant la première instruction, sans créer d’objet. Retirer cette seule ligne permet d’exécuter la même instruction, puis l’index et les deux triggers. Son erreur locale diffère de l’erreur hébergée ; cette piste ne constitue pas un diagnostic certain du serveur.

La reprise standard retire uniquement cette première ligne de commentaire de 0082, dont le hash devient `188b140fc46301baaf269bd063333354e1ed54b7a403c58acaf3d81ddd13b37f`. Les neuf instructions CREATE de 0081/0082, leurs contraintes, les anciennes migrations et le journal restent inchangés. Aucun SQL manuel, IF NOT EXISTS, effacement, assouplissement de garde, nouvel accès marchand ou activation de worker n’est introduit. Un objet déjà présent doit produire une erreur plutôt que masquer une application partielle.

Même si cette reprise standard réussit, elle ne suffit pas à prouver la présence des neuf objets dans la base hébergée. Les workers restent OFF ; la vérification du schéma, du compte marchand et des preuves réelles de règlement demeure nécessaire avant activation. Un nouvel échec ou une ambiguïté doit conduire au diagnostic du schéma réel, sans réparation aveugle.

## Hosted migration boundary and formatting trial (2026-10-06)

A temporary authenticated metadata diagnostic observed `__appgarden_migrations` ending at `0080_standalone_support_plan_change.sql`, with all nine recovery/admission objects absent. Migrations 0081 and 0082 are therefore not recorded as applied at that observation. The diagnostic secret was removed and environment revision 41 was deployed before this trial.

The only SQL change from the preserved Site 338 candidate is two spaces in the closing `END ; END ;` of the 0081 trigger, matching historical trigger formatting. Its 1,023 SQLite tokens and all guards are unchanged. This is a formatting trial, not a demonstrated diagnosis of the hosting parser. Migrations 0000–0080 remain unchanged. PostFinance production flags and the renewal scheduler remain disabled; no real payment or mandate is validated by these checks.