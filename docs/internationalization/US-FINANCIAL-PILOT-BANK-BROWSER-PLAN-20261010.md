# Rapprochement bancaire V5 — plan navigateur et export

Plan préparé le 10 octobre 2026, avant implémentation de cette tranche. Il complète le [plan bancaire](US-FINANCIAL-PILOT-BANK-PLAN-20261010.md), dont les règles métier, limites et sources officielles restent applicables. L'étape 1 est livrée séparément : [rapport](US-FINANCIAL-PILOT-BANK-20261010.md), code `1112da34d6a30a12a67924f414da0e345b905acf`, preuve `77ffae11c5560711ee69ae751afdb162916952442b3df07c716d59789151c42c`, 6 498/6 498 tests dans 201 fichiers. Ces résultats ne valident pas encore les fonctions décrites ci-dessous.

## Décision et portée

Raccorder les six factories HTTP existantes à la session financière commune, ajouter l'import CSV explicite, l'approbation humaine de groupes exacts, la finalisation/annulation et l'export CSV complet. Aucun nouveau ledger, store navigateur indépendant, moteur de paiement, provider bancaire, abonnement, migration ou déploiement. Le registre et les douze sources de l'étape 1 restent inchangés.

Retenir l'inventaire de **18 fichiers** : **15 fichiers de protocole/transport/export/routes**, puis **3 fichiers d'interface**. Le module `us-financial-pilot-bank-export.ts` porte le snapshot, le renderer et le handler protégé complet. La route d'export reste mince. Si une séparation serveur devient nécessaire, amender cet inventaire avant de coder plutôt que cacher la logique d'admission dans une route.

Le type de dépendances HTTP vient explicitement de `us-financial-pilot-bank-server.ts`, sous un alias distinct : le domaine `us-financial-pilot-bank.ts` exporte un type homonyme incompatible. Le binding réel expose **STATEMENTS**, pas LIST.

## Session commune et état observé

Ajouter `bank` à l'unique union pending et aux branches conservatrices de `send`/`response`/`retry`. La session conserve uniquement en RAM le requestId, F/B/R, la commande canonique et son corps JSON exact. Les erreurs HTTP, y compris409/422, ne prouvent pas l'absence de commit : aucun déverrouillage implicite ni rebase. `retryBank()` réémet exactement l'enveloppe initiale. Les reçus historiques ne deviennent jamais un head courant et ne font pas régresser le snapshot financier.

Façade à ajouter à la session existante : `setBankActive`, `refreshBank`, `readBankContext`, `readBankStatements`, `readBankStatement`, `readBankMovements`, `reviewBankImport`, `reviewBank`, `submitBank`, `retryBank`, `exportBank`, `downloadBank`. La session possède les pages et leur query capturée par WeakMap, les reviews par WeakSet/epoch et au plus un résultat d'export. Elle utilise un contexte privé frais, déjà validé, pour construire les reviews.

Conserver des planchers F et B distincts par génération. Une paire F/B publiée doit avoir réellement été retournée atomiquement ; ne jamais combiner les maxima de deux réponses. Toute avance F invalide les lectures/reviews/export bancaires ; B seul invalide les faits bancaires sans recharger un snapshot financier de même F. Les lectures tardives sont refusées selon génération, mutation, epoch bancaire, tenant et paire. Un brouillon de vue reste éditable mais ses anciennes preuves ne redeviennent pas approuvables.

**Optimisation explicitement retenue :** un seul timer fixe3s. Quand la banque est active ou un pending bancaire existe, le tick utilise uniquement le head composite bancaire, qui inclut déjà l'admission financière ; charger le snapshot financier seulement si F change, hors pending/writing. `refresh()` financier public reste disponible. En cas d'échec bancaire non-denial, un unique repli sur le head financier courant est permis pour préserver les autres modules ; la banque garde son erreur et sa dette de fraîcheur, et le pending reste inchangé. Sur401/402/403 : purge commune, aucun repli. Pas de polling hidden/offline ni deuxième timer, ni fallback ERP4.

Logout, denial, stop et dispose purgent les heads, pages, reviews, demandes, brouillons et ressources d'export ; les réponses tardives ne les restaurent pas. Aucun CSV ou intent dans localStorage, IndexedDB ou URL. Un vrai conflit CAS sans reçu peut rester incertain : l'interface propose Reprendre et un rechargement explicite de l'espace, qui purge cette RAM puis relit l'historique. Ce rechargement ne promet ni annulation d'un commit ni reprise persistante. Un protocole futur de preuve de rejet pourrait améliorer ce cas ; aucun endpoint supplémentaire ici.

## Input pur et approbation

`browser-us-financial-pilot-bank-input.ts` est pur : aucun fetch, await, File/Blob/DOM, timer, stockage, UUID alloué ou import de session/bindings/handler. Les builders synchrones `captureBankOperationRequest`, `buildBankImportReview` et `buildBankCommandReview` capturent et figent les données propres. `BankInputError` est local et fermé ; la session traduit ses erreurs, sans cycle input→session. Ce module partage aussi selector, constantes et headers avec le serveur d'export.

L'import reçoit compte, dates, soldes USD explicites et texte UTF8 strict. Plafond fichier brut **524 288 octets**, contrôlé avant/après lecture avec TextDecoder fatal. Réutiliser le parser réel `date,amount,reference`, ses limites, dates, ordre et références exacts. Le serveur reçoit seulement les lignes canoniques ; l'original CSV n'est pas archivé. Body réel <=1 048 576 octets. Les montants et totaux utilisent BigInt, jamais Number/epsilon.

La review de match corrobore détail et pages avec leurs queries/cursors originaux, org/F/B/R/origin/L identiques, au plus40 pages de lignes et40 de mouvements, 1 000 sélections uniques par côté. Refuser les doublons, sélecteurs absents/indisponibles et contradictions. Les totaux signés doivent être exactement égaux ; les sélections hors page restent visibles. Chaque page est capturée sous son budget, puis la sélection compacte bornée est retenue ; aucune agrégation non bornée de métadonnées répétées.

L'import, le match, la finalisation et l'annulation exigent une review possédée et courante, aucun autre pending/writing et une **case d'approbation humaine explicite** avant soumission. Modifier un fait ou changer F/B invalide cette approbation. Une finalisation legacy reste enregistrée seulement, sans différences V5 inventées. Le blocker pending legacy est affiché pour son compte. Les frais manquants passent par le journal existant ; aucune écriture ni paiement n'est créé par le rapprochement.

## Export complet et fences

Selector bancaire fermé distinct des exports financiers : consumer/schema/kind, tenant, F/B/R, statementId, origin, format CSV, langue FR/DE/IT/EN. Query requise/unique : revision,bankRevision,statementRevision,origin,format,language. UUIDs et entiers canoniques ; pas de cursors ni PDF. SHA selector sur sa sérialisation canonique complète, tenant inclus.

Snapshot whitelist complet issu d'une seule lecture atomique `{book,register}`, capturés séparément avant await. Valider livre/histoire puis construire toutes les lignes, groupes, relations match→ligne et match→journal, mouvements courants, évaluation et completion enregistrée, sans boucle de projecteurs paginés. Aucun produit cartésien ou donnée privée. Pour legacy : mouvements/évaluation/source historique null, faits enregistrés seulement. Comparer les slices au DTO Stage1 dans les tests.

Extraire les trois primitives CSV sans modifier leur comportement financier. BOM UTF8, CRLF, quoting complet, dates ISO, décimaux USD exacts, labels traduits et neutralisation des formules après préfixes Unicode White_Space/Cf. Plafond distinct **12MiB encodés réellement**, sans troncature. Les budgets privés Stage1 restent applicables ; un snapshot valide peut encore être trop grand pour l'export.

Handler avec deadline globale30s et signal, méthodes/dépendances capturées, navigateur cookie-only/expected-user/origin/marqueur, rate limit et admission complète : Auth/D1, US/USD/accrual, droits, flags TEST, gate bancaire, grant/opt-in/policy. Renouveler les fences après les attentes réussies **et rejetées**, notamment rendu/hash. Capturer les octets rendus dans un buffer possédé avant hash. Après rendu : seconde lecture atomique corroborant F/B/R/origin/id et record cible canonique, puis head F/B et admission complète finale. Divergence :409, aucun attachment réussi.

Transport d'export dans la même session : deadline couvrant fetch/stream/hash, max réel, UTF8/BOM, filename sûr, media/length, headers scope/org/F/B/R/L/origin/id/USD/langue/format, hashes selector/contenu et headers de sécurité corroborés. Un seul export en vol/résultat ; mutation ou changement de paire invalide le résultat. `downloadBank` accepte seulement un résultat possédé, crée son URL, la révoque après activation et lors de purge. Aucun head n'est dérivé du reçu ou des headers d'export.

## Inventaire avant code

Nouveaux protocoles/export (6) :

- `lib/international/us-financial-pilot-bank-export.ts`
- `lib/international/us-financial-pilot-bank-export.test.ts`
- `lib/international/us-financial-pilot-csv.ts`
- `lib/international/browser-us-financial-pilot-bank-input.ts`
- `lib/international/browser-us-financial-pilot-bank-copy.ts`
- `lib/international/browser-us-financial-pilot-bank.test.ts`

Sept nouvelles routes sous `app/api/international/workspaces/[organizationId]/financial-pilot/bank/` :

- `head/route.ts` → HEAD
- `context/route.ts` → CONTEXT
- `statements/route.ts` → STATEMENTS
- `statements/[statementId]/route.ts` → STATEMENT
- `statements/[statementId]/movements/route.ts` → MOVEMENTS
- `operations/route.ts` → POST
- `statements/[statementId]/export/route.ts` → nouveau handler complet

Deux sources existantes modifiées pour le protocole :

- `lib/international/browser-us-financial-pilot-session.ts`
- `lib/international/us-financial-pilot-export-renderer.ts` — extraction des primitives seulement

Puis trois fichiers d'interface :

- Nouveau `components/account/us-financial-pilot-bank.tsx`
- Nouveau `components/account/us-financial-pilot-bank.css`
- Modification `components/account/us-financial-pilot.tsx`

## Acceptation future et limites

Avant gel : inventaire exact, staging et whitespace, puis tests ciblés sur sources définitives. Après gel : régression conservant les201 fichiers précédents et ajoutant les deux nouvelles suites, TypeScript global, lint typé, marque et build. Ne pas additionner les totaux ciblés/globaux. Vérifier notamment vraie chaîne import→match→complete, livre F inchangé, B seul sans reload financier, F seul, heads hors ordre, verrou entre tous modules, réponses perdues/409 tardifs et reprise exacte, grands/négatifs/net0, selections hors page, purge, intégrité CSV financier après extraction, export complet>25 lignes, legacy, formules Unicode, bornes UTF8, captures mutables, fences succès/rejet et sept routes réelles.

Pour l'interface : réutiliser l'identité Zentra, les thèmes et contrôles du pilote, traduire toute la copie FR/DE/IT/EN, puis inspection groupée desktop/mobile clair/sombre et une correction groupée. Tests et captures Stage2 **non exécutés dans ce plan**. Aucun résultat Stage1 n'est présenté comme validation de cette interface.

TEST privé seulement. Aucun provider/fonds, règle fiscale nouvelle, production, migration hébergée, distribution native ou modification CH/Stripe. Exact coverage, plafonds de capacité, absence d'échéancier de chèques/dépôts en transit et absence d'archivage d'original restent explicites. La gate reste fermée par défaut, même après montage des routes. L'objectif international demeure actif.
