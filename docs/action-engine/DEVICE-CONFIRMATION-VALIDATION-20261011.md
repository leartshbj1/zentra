# Action Engine — A7 : confirmation appareil privée

## Résultat et périmètre

Le raccord serveur privé relie désormais une réservation d'origine authentifiée, un fait de publication PostgreSQL corroboré, l'archive publiée complète et la preuve métier A6, avant de confirmer le reçu dans le registre D1. Il confirme la création historique d'un brouillon existant ; il ne crée, n'émet et n'envoie aucun devis.

**Ce lot est local, non exposé et non déployé.** Aucun endpoint Action Engine, commande native IPC, déclencheur Support, interface ou notification n'est ajouté. La composition n'est pas un parcours utilisable dans l'application publiée. Les gardes du chemin de planification restent distinctes : un catalogue publié ne devient jamais une preuve de création métier.

La régression finale passe **1 641/1 641 tests dans 52 fichiers**, sans test ignoré, en 113,015 secondes. Le typage, le lint ciblé et le build de production passent également. Aucun contrôle natif ni déploiement n'est inclus dans ces résultats.

## Sources et parcours

Nouveaux composants et tests de ce lot :

- `lib/action-engine/confirmation-records.ts`, son fixture et son test : lecture de la proposition, réservation, liaison de provenance et témoin de planification historiques depuis D1. L'identité entreprise/source/proposition/réservation/acteur/installation est exacte. L'empreinte du plan est recalculée, puis une seconde lecture atomiquement autorisée corrobore de nouveau les champs immuables après l'attente du digest. Une réservation ancienne sans sa liaison d'origine demande une revue ; elle n'est pas réparée.
- `lib/action-engine/confirmation-publication.ts`, son fixture et son test : chargement privé d'une publication du même acteur et de la même installation, corroboration du fait PostgreSQL permanent, puis lecture authentifiée de la copie de transport et de tous ses chunks. Tailles, manifeste normalisé, SHA de chaque chunk et SHA de l'archive entière sont comparés avant le lecteur ZIP A6. Le retour est une copie privée de la vraie SQLite extraite.
- `lib/action-engine/device-confirmation.ts` et son test : composition appareil → droits actuels → accès Support délégué → réservation liée → preuve existante ou première vérification canonique → journal de preuve → confirmation du registre. L'appelant ne fournit que quatre sélecteurs fermés ; ni autorisation, reçu, plan, acteur, SQL ou fait de publication n'est accepté depuis son entrée.
- `lib/action-engine/sqlite-worker-plugin.test.ts` : tests du véritable plugin de build et de la distribution épinglée, décrits plus bas.
- `drizzle/0104_action_engine_quote_evidence_preconfirmation.sql` : migration additive proposée pour empêcher atomiquement la première preuve sur une réservation déjà confirmée par un autre chemin.

Le lot réutilise les composants A6 `quote-archive.ts`, `sqlite-reader.ts`, `canonical-quote.ts`, `quote-publication-evidence.ts`, les gardes historiques et le registre durable. La correction de concurrence modifie également l'INSERT du journal de preuve dans `quote-publication-evidence.ts`. Les 10 fichiers TypeScript créés, les trois fichiers TypeScript modifiés et la migration créée sont identifiés avec leurs empreintes dans `docs/evidence/action-engine-device-confirmation-20261011.json`. Le présent rapport, `STATUS.md`, le README du noyau et `PUBLISHED-CONTEXT-CONTRACT.md` complètent la documentation.

## Autorité, captures et ordre des opérations

Les sélecteurs et les headers de la requête sont détachés avant la première attente. L'autorité provient du véritable authentificateur appareil et de ses prédicats SQL serveur, pas de champs d'identité transmis par le navigateur. Une seconde authentification doit conserver la même entreprise, le même utilisateur et la même installation.

La lecture historique conserve les droits actuels : session et activation valides, rôle autorisé, siège disponible, branche commerciale explicitement prise en charge et délégation Support/Gestion toujours autorisée. Les branches commerciales du premier adaptateur restent limitées aux packs Complets Stripe payés ; essais, droits manuels, prépayés et autres transitions ne deviennent pas implicitement compatibles. Le droit de confirmer un fait historique est séparé de celui de préparer une nouvelle proposition : une pause d'Automation n'autorise pas une nouvelle préparation, mais ne transforme pas à elle seule une preuve déjà acquise en un nouveau travail à exécuter.

Les droits et la délégation sont renouvelés avant et après les opérations asynchrones, y compris sur leurs rejets. Les lectures et mutations D1 protégées exécutent leur assertion SQL dans le même batch que l'opération. Une révocation pendant le chargement, la vérification ou le rejeu refuse le résultat ; elle ne divulgue pas un succès ou une erreur issus d'une ancienne autorisation.

Le chargeur capture les réponses et octets de ses ports avant d'attendre le contrôle d'autorité suivant. Sa copie utilise les primitives intrinsèques ; les buffers partagés, y compris à prototype falsifié, sont refusés à cette frontière. Le downloader existant peut rejeter plus tôt un itérateur hostile lors de son propre hash : ce cas est testé comme un refus, pas comme une garantie d'absence d'évaluation dans toutes les couches. Les résultats externes ne deviennent pas des capacités de preuve par simple copie JSON.

La première lecture de publication applique le garde pays du transport existant. Les mutations et lectures historiques D1 refusent aussi une intention de création US. Le premier writer et sa preuve restent donc dans le périmètre natif CH/CHF ; ce raccord ne rend pas le moteur natif américain opérationnel.

## Première preuve et reprise sans doublon

Sans preuve durable, le chargeur exige une publication committed du même acteur et de la même installation, postérieure ou égale à la réservation selon les horodatages du registre, et une révision postérieure à celle liée lors de la planification. Un témoin PostgreSQL permanent seul ne suffit pas : l'archive réelle doit encore être disponible. La copie de transport et le fait PostgreSQL doivent correspondre exactement à l'identité D1 capturée.

Si D1 est encore pending alors que PostgreSQL possède déjà le commit exact, le chargeur peut clôturer ce témoin de transport après corroboration. Il ne crée aucune tentative, n'avance aucune tête PostgreSQL et n'invoque aucun nouveau commit ou close. Cette reprise de transport ne confirme pas encore le devis.

L'archive entière passe ensuite par le ZIP strict, la vraie SQLite en lecture seule et le vérificateur canonique A6. Le client, le devis, toutes les lignes, le reçu et l'audit doivent correspondre aux faits initiaux. Un devis déjà modifié, émis, supprimé ou incomplet avant cette première preuve impose une revue ; aucune recréation ou émission n'est tentée. La capacité privée produite par le vérificateur est nécessaire pour écrire le journal de preuve.

La preuve append-only est enregistrée avant la confirmation du reçu. Une réponse perdue après l'enregistrement de la preuve ou après la confirmation peut être reprise avec les mêmes identités et le même snapshot. Une preuve déjà acquise évite toute relecture de l'ancien fait PG, de la copie de transport et de l'archive, même après leur purge ou après une modification ultérieure du devis. Les permissions actuelles restent nécessaires. La réservation conserve ses IDs métier ; cette reprise ne crée aucun client, devis, appel modèle ou événement de confirmation supplémentaire.

Un reçu legacy seul n'est jamais rétroactivement assimilé à une preuve A6. La revue a identifié une course : le reçu pouvait être écrit après la lecture initiale mais avant le premier INSERT de preuve. La correction exige désormais `receipt_json IS NULL` dans la sélection SQL de ce premier INSERT ; la migration additive 0104 impose également cette condition à la frontière SQL pour les bases possédant déjà 0103. Le rejeu d'une preuve existante reste autorisé lorsque le reçu a ensuite été confirmé. Les deux cas concurrents pendant le chargement du fait ou des chunks passent, ainsi que les essais de DML direct et de rejeu après confirmation.

## Tests : portée réelle des preuves

Les tests de composition utilisent les migrations D1 cumulées réelles sur SQLite, les assertions et transactions du registre, les gardes historiques, le journal de preuve, des ZIP complets synthétiques au profil natif, le vrai module SQLite WASM et le véritable vérificateur canonique. Les fixtures SQLite exécutent le schéma natif réel ; elles ne sont pas une archive produite par le writer Rust.

Dans `device-confirmation.test.ts`, **l'authentification, la factory d'admission et les ports PostgreSQL/Storage sont explicitement simulés**. Les suites dédiées exercent séparément les chargeurs et leurs contrats. Cette composition ne prouve donc ni le login hébergé, ni les permissions du service Supabase en production, ni l'acheminement réel entre appareils. Les tests nécessitant le schéma natif sont conditionnés par `ZENTRA_NATIVE_SOURCE_ROOT` : une suite ignorée en son absence ne doit pas être comptée comme passée.

Les cas écrits couvrent notamment :

- première preuve, reprise d'un témoin D1 pending après fait PG committed, perte d'accusé de preuve ou de confirmation, et absence de doublon ;
- preuve historique après modification/suppression du document et nouvelle publication indépendante, sans accès à l'ancien transport ;
- reçu legacy, réservation non liée, course de confirmation pendant les attentes, archive purgée avant première preuve et document modifié/émis/supprimé/incomplet ;
- sélecteurs fermés, identité différente à la seconde authentification, mutation de requête ou de réponse après capture, et refus d'une intention US ;
- droits ou délégation révoqués, réponse externe rejetée, fait/manifeste/snapshot incohérent, taille/hash/chunk invalides et copie d'octets détachée.

### Véritable plugin SQLite : résultat déjà exécuté

**8/8 tests ciblés réussis**, avec le vrai `scripts/sqlite-worker-plugin.mjs`, sans modification de son code. La suite vérifie la distribution JS installée de `sql.js` **1.14.2**, son SHA-256 épinglé et le remplacement d'un unique token connu. Elle couvre les suffixes de requête Vite, les chemins Windows normalisés, l'absence de transformation des autres modules, le refus de bytes modifiés ou déjà transformés et l'absence de mutation des propriétés globales nommées de l'hôte.

Dans un contexte Node VM isolé, la distribution réellement transformée initialise le véritable WASM précompilé et exécute `SELECT 6 * 7`. `WorkerGlobalScope` est présent et l'accès à `self.location` provoque volontairement une erreur : le code transformé ne le lit pas et n'effectue aucun chargement réseau ou lookup de fichier à l'exécution. La distribution originale échoue dans ce même contexte avant l'instanciation. Ce test n'est ni un déploiement, ni une preuve que le bundler de production a inclus ce chemin, ni un nouveau smoke Workerd.

Commande ciblée réellement exécutée :

```powershell
& 'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/vitest/vitest.mjs run --config vitest.config.ts lib/action-engine/sqlite-worker-plugin.test.ts --maxWorkers=1
```

### Contrôles finaux

- Régression serveur : **1 641/1 641**, 52 fichiers, 0 échec, 0 ignoré ; **117 nouveaux cas** par rapport aux 1 524 d'A6. Les ciblés ne sont pas additionnés une seconde fois.
- Détail inclus : publication **40/40**, enregistrements **30/30**, orchestration appareil **27/27**, gardes historiques **9/9**, journal de preuve **25/25** dont trois nouveaux cas, plugin **8/8**. Les migrations cumulées jusqu'à 0104 sont exécutées sur des bases SQLite éphémères.
- `tsc --noEmit --incremental false` : sortie 0. Lint du noyau, schéma et route collaboration, test de route, plugin et configurations Vite/Vitest : sortie 0. Les anciens diagnostics Support hors de ce périmètre ne sont pas annoncés comme corrigés.
- Format des 13 fichiers TypeScript, contrôle des assets via le prebuild et `git diff --check` : sorties 0.
- Build de production `pnpm run build` : sortie 0. Les avertissements de classification statique des routes Vinext restent ceux du bundler ; un build réussi ne constitue pas une activation du parcours privé.
- Code serveur : `d0f9a4cd5341882322378c8a7c22a7ff3832808c`. Sources natives A6 inchangées : `3eee678aa16fc0eeb9f559232aa7a5ac66fb6453`, HEAD documentaire natif `a7f278c8f88fb8129ffe6fc1f4dc49414c0f6a8b`.
- Manifeste final : `docs/evidence/action-engine-device-confirmation-20261011.json`, SHA-256 `e524de66b801a7c21ed69a444e63474e63ae42407311cf071b60de28cc0ca46c`.

Les premières passes ont révélé deux fixtures de transport incompatibles avec les contrats réels, puis une assertion attendant encore la migration 0103. Ces échecs et les diagnostics de type/lint ont été corrigés avant la régression finale ; leurs rapports intermédiaires sont conservés et identifiés dans le manifeste.

## Migration et limites restantes

La migration D1 0104 est additive et testée localement ; elle n'a été appliquée à aucune base distante. Elle complète les registres 0099–0103 sans supprimer, réécrire ou migrer les données métier. Aucun nouveau schéma Supabase, déplacement de région ou changement de politique RLS n'est introduit par A7. Les prérequis de coordination A4 et de reprise A5 restent indispensables avant tout déploiement approuvé. Le retour arrière conservateur garde les tables, preuves et triggers, désactive le parcours et revient au serveur compatible précédent ; il ne supprime pas un garde ni une preuve pour tenter de réexécuter un devis. Aucune procédure de rollback hébergé n'a été exécutée.

Les bornes de preuve A6 restent inchangées : archive 16 MiB, SQLite 8 MiB, total décompressé 32 MiB et 512 entrées. Elles ne remplacent pas les limites du transport normal. La limite de heap SQLite ne borne pas toute la mémoire JS/WASM et aucune garantie stricte de CPU/opcodes n'est revendiquée.

**Les 68 tests natifs A3/A5/A6 sont écrits mais non exécutés.** A7 n'ajoute pas de raccord IPC ni de nouvelle exécution native. Le refus Windows App Control 4551 reste bloquant : aucun Cargo, build natif ou contournement n'a été retenté pour ce lot. Les parsages Rustfmt antérieurs ne prouvent ni compilation, ni typage, ni exécution du writer ou des restaurations/fusions.

Restent à valider sur un hôte autorisé : writer natif, véritable archive synthétique Rust, restauration/fusion, réponses perdues, changements de compte et essais avec plusieurs appareils. Restent ensuite à raccorder après validation : entrée applicative, commande native dédiée, déclenchement Support, supervision et notification ouvrant le véritable devis confirmé. Le plan de reprise et les risques de pending/outbox sont consignés dans `EXECUTION-INTEGRATION-PLAN-20261011.md`. Les opérations sensibles conservent leur validation humaine et les parcours métier existants.

Aucun appel JEV réel, e-mail, paiement, donnée client, migration hébergée ou déploiement n'a été utilisé pour cette livraison locale. D1, PostgreSQL, Storage et SQLite ne forment pas une transaction distribuée. L'objectif global reste en cours ; ce lot ne doit pas être présenté comme une exécution native connectée en production.
