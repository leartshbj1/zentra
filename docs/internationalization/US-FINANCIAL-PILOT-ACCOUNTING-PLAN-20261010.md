# Zentra US — plan du pilote journaux et périodes V5

10 octobre 2026. Plan préalable à l’implémentation locale privée TEST. Base de livraison achats : 36190fa ; code achats 422d081, preuve us-financial-pilot-purchasing-20261010.json. L’audit statique principal et la lecture indépendante SQL ci-dessous ont vérifié la réutilisation du store cumulatif. Aucun résultat de la nouvelle phase n’est revendiqué ici. Aucun changement hébergé, abonnement, région ou distribution native n’est autorisé implicitement.

## 1. Périmètre confirmé

Raccorder exactement quatre commandes déjà implémentées : post_manual_journal, reverse_manual_journal, open_period, close_period. Elles doivent continuer le livre cumulatif du pilote financier navigateur privé TEST, avec les factures émises V5, avoirs, encaissements, commerce et achats actuels. Aucun moteur parallèle, promotion supplémentaire, repli ERP4, compte créé implicitement, mutation directe des sous-registres, provider fiscal, banque, rapprochement ou accès natif/public.

Aucun nouveau SQL n'est indiqué par l'audit. La recette de développement devra le démontrer sur les 33 migrations sélectionnées actuelles ; si elle révèle un vrai manque de persistance, réviser explicitement le plan avant d'ajouter une migration. Aucun gap SQL n'a été trouvé dans l'audit principal ni dans la lecture indépendante déléguée.

## 2. État réel des sources et gaps à raccorder

Tous les chemins ci-dessous sont relatifs à D:/Codex-Zentra-Temporary/2026-10-08/international-site ; les numéros sont ceux des sources auditées, à reverifier au gel suivant.

| Fait vérifié | Source actuelle |
| --- | --- |
| Les quatre identifiants sont dans ErpCommand. | lib/international/runtime-types.ts (union ErpCommand) |
| Le store pilote conserve createSupabaseUsFinancialInvoicingTestStoreV5 et route ses trois RPC vers les wrappers pilote. | lib/international/us-financial-pilot-store.ts:109,120,125 |
| Le prédicat invoicing comprend accounting, lui-même cumulatif avec achats/commerce. | lib/international/us-financial-kernel-runtime.ts:113,116 |
| Les effets journaux/périodes sont recalculés sur le vrai ledger V5, séparément de la compatibilité ERP privée. | lib/international/us-financial-kernel-erp.ts:58,71,82 |
| Le SQL courant matérialise factures, périodes et effets ensemble ; accounting_current pointe sur invoicing_current. | supabase/migrations/20261010100252_international_us_financial_test_invoicing_v5.sql:18,46 |
| La transition invoicing délègue ces commandes à accounting ; append les autorise ; replay et garde d'insertion comparent les effets exacts. | même migration :220,226,228,285,579 |
| Les wrappers pilote admettent opt-in/grant vivants avant read/receipt/append ; accès SQL privé service_role. | supabase/migrations/20261010104148_international_us_financial_pilot_dto1.sql:24,74,80,86,93,100 |
| Les 33 migrations de la recette sont 31 prérequis + pilot DTO1 + pilot invoice DTO1, et non toutes les migrations sans rapport du répertoire. | lib/international/us-financial-pilot-purchasing.postgres.test.ts:43,45,250,253 |
| Les anciens readers accounting/purchasing/commerce/settlement sont fermés après un événement d'émission invoice. | supabase/migrations/20261010100252_international_us_financial_test_invoicing_v5.sql:672 ; lib/international/us-financial-test-invoicing.postgres.test.ts:214 |

Gaps de présentation réels : les listes publiques journaux/périodes existent, avec pages de 25 et head global, mais les journaux n'ont ni détail de lignes ni commande navigateur ; les périodes n'ont aucun formulaire de mutation. Un journal public est identifié par journalRevision, pas par son entryId privé (us-financial-pilot-contract.ts:35 ; us-financial-pilot-projection.ts:66 ; components/account/us-financial-pilot.tsx:133). Le DTO compte des rapports omet cash (us-financial-pilot-contract.ts:57). Il faut des contrats, projections, routes, admission/erreurs, saisie/revue et intentions de session dédiés ; réutiliser une UI ERP4 qui attend ErpState divulguerait le mauvais modèle.

Le chart courant est exactement celui de l'adaptateur US, 11 comptes dont 7 permis pour le manuel : cash, inventory, fixed-assets, equity, sales, purchases, bank-fees. runtime-validation.ts:26 exige ce chart ; countries/us/accounting.ts:4 le définit. Le sélecteur doit lire les comptes admis du livre courant, avec leur flag cash, sans recréer cette liste à la main dans l'UI.

## 3. Contrat public fermé proposé

Enveloppe : consumer financial-pilot, schemaVersion 1, requestId UUID canonique, expectedRevision global sûr, command union fermée. Corps maximum 262 144 octets UTF-8, capture JSON privée immuable et rejet de toute clé supplémentaire, getter/symbole/prototype caché. Ni organisation, rôle, acteur/date de publication, currency/basis, policy/grant, source interne, ledger, fingerprint, hash ou clé d'idempotence client.

| Intention publique | Champs éditables | Construction serveur |
| --- | --- | --- |
| post_manual_journal | transactionDate, accountingDate, periodId, description, sourceReference, lines ; cashFlowCategory facultative | id pilot-journal:<UUID> ; source manual_journal déclarée ; acteur/date serveur |
| reverse_manual_journal | journalRevision du journal original, transactionDate, accountingDate, periodId, reason | id pilot-journal-reversal:<UUID> ; entryId trouvé dans le vrai ledger V5 ; lignes et catégorie cash inversées/reprises par le domaine |
| open_period | start, end | id pilot-period:<UUID> ; status open et audit serveur |
| close_period | periodId existant | aucune création d'ID ; cible et ordre validés dans le livre courant |

Clé privée commune : pilot:accounting:<UUID>. Le build natif reste un UsFinancialRequestV5 contenant erp_command/request ; les opérations persistées ont facts kind none. Les champs de présentation journalRevision et confirmations UI ne passent pas comme clés supplémentaires à ErpCommand. Le reçu public reprend le modèle achats : organisation, requestId, action exacte parmi les quatre, entityId attendu, revision = expectedRevision + 1, consumer/schema. Aucun reçu privé ni hash exposé.

Bornes à reprendre explicitement : 2 à 1000 lignes ; accountId/periodId/sourceReference 160 caractères ; description de journal, raison et description de ligne facultative 2000 ; dates civiles calendaires hors année 0000 ; chaque montant est une chaîne canonique entière non négative de 1 à 36 chiffres, zéro inclus. Description facultative absente plutôt que chaîne vide/null. Le plafond d'octets s'applique aussi à un texte Unicode valide. Le draft décimal reste une chaîne exacte, convertie par BigInt, sans Number/float/exposant/signe/séparateur de milliers ni blanc converti implicitement en zéro.

Chaque ligne porte exactement un débit positif ou un crédit positif et un zéro explicite sur l'autre côté ; comptes connus, exclusion de receivables/payables/tax-payable/deposits ; somme débit = crédit et non nulle. La catégorie operating/investing/financing est requise lorsque le mouvement NET des comptes cash est non nul, pas à la seule présence d'une ligne cash. Les sommes BigInt peuvent dépasser 36 chiffres : ne pas réutiliser purchasingTotal ni ajouter un plafond économique du total absent du domaine. Le contrat actuel des totaux/rapports autorise déjà 96 chiffres (us-financial-pilot-contract.ts:91).

Les dates transaction et comptabilité restent distinctes. Seule la date comptable doit appartenir à la période ouverte choisie et franchir les périodes clôturées ; aucune règle nouvelle transactionDate = accountingDate, date de contrepassation >= date originale ou ouverture seulement après clôture préalable. Sources : accounting/us-journal.ts:24,39,45,66,74,79,89 ; accounting/ledger.ts:95,111,116,124.

## 4. Identité de contrepassation et reprise exacte

Résoudre journalRevision UNIQUEMENT dans view.ledger.entries obtenu par projectUsFinancialBookV5 du livre admis. Ne jamais utiliser compatibility() de us-financial-kernel-erp.ts:58 : ce modèle temporaire enlève les écritures d'avoirs et compacte ses révisions. Un test avec avoirs intercalés doit rendre visible toute résolution depuis la mauvaise projection.

Le serveur transforme cette révision en entryId immuable avant de construire l'enveloppe native. La recherche d'identité et la validation d'éligibilité d'une NOUVELLE mutation sont distinctes. Une relecture courante nécessaire à la reconstruction du build/hash doit retrouver la même identité immuable ; elle ne doit pas exiger encore original non contrepassé ou période encore ouverte pour restituer un reçu historique exact. Le domaine/SQL garde l'original intact et construit exactement les lignes inversées, descriptions et cashFlowCategory ; il refuse une source invoice/payment/credit/vendor_bill/vendor_payment/other/reversal et une deuxième nouvelle contrepassation.

Conserver receipt-first, vérification de la demande/acteur/action/entité/révision et préfixe historique exact du kernel. Toute garde de création/source ajoutée avant executeUsFinancialKernelV5 doit sonder le reçu sous admission fraîche, puis re-sonder avant un rejet dépendant de source si un commit a pu intervenir entre probe et read. Une seule récupération bornée après revision_conflict renouvelle l'admission puis rejoue exactement la même demande ; ni nouvel UUID, ni expectedRevision remplacé, ni auto-rebase de montants/source.

Cas obligatoire : append réel du journal ou de la contrepassation, réponse perdue ou 409 postflight, autre événement/contrepassation/clôture ultérieur, puis retry de la demande d'origine : même reçu, aucun doublon, état inchangé au retry. Même exigence pour open_period puis clôture ultérieure et close_period déjà clôturée sous le même UUID. Un nouveau UUID reste soumis aux règles courantes. Références : us-financial-kernel-runtime.ts:220 ; us-financial-pilot-purchasing-server.ts:132,145,153 ; invoicing_v5.sql:287-293.

## 5. Lectures, routes et pagination proposées

Conserver /snapshot, /head, /lists/journals et /lists/periods. Ne pas élargir par cast l'union fermée UsFinancialPilotPageKind.

- POST /financial-pilot/accounting/operations : les quatre intentions fermées.
- GET /financial-pilot/accounting/context?revision : DTO dédié contenant head + ledgerRevision, comptes manuels autorisés {accountId,code,name,type,cash:boolean}, periodCount, latestPeriodEnd et earliestOpenPeriod ou null. Calcul sur TOUTES les périodes, pas la première page descendante. Catalogue borné à 25, chart actuel de 11/sept admissibles ; aucune simulation de chart >25 dans une fixture prétendument valide.
- GET /financial-pilot/journals/[journalRevision]?revision&lineCursor : détail public, row publique existante, cashFlowCategory ou null, lineCount, lignes paginées, liens de contrepassation par révision. Les lignes comportent ordinal stable, compte public, debitMinor/creditMinor et description nullable. Totaux calculés sur toutes les lignes, jamais sur la page. Tous les kinds peuvent être consultés ; seule la source manual_journal non contrepassée propose l'action.
- GET /financial-pilot/periods/[periodId]?revision : période ciblée, état et éligibilité courante à clôturer ; lecture directe nécessaire même au-delà des 25 premières.

La nouvelle page journal_lines est indépendante ; maximum 25 lignes ; cursor canonique lié à kind, révision GLOBALE, offset multiple de 25 et scope journal:<journalRevision>, sans réemploi entre journal, type ou snapshot. Rejeter page incomplète incohérente, nextCursor/total contradictoire, révision future/obsolète, doublon d'ordinal et query/route inattendue. lineCount <=1000 ; les totaux d'en-tête restent exacts sans limite à 36 chiffres. L'UI doit permettre de revoir chaque page de l'original avant contrepassation ; aucune ligne de contrepassation ne revient du client.

Après projection, contrôler store.head().revision puis renouveler toute l'admission avant retour, y compris si une projection/lecture asynchrone échoue. Le head et la première liste ne suffisent jamais à autoriser un DTO de détail. Réutiliser les helpers publics/readUsFinancialPilotView ; ne sérialiser ni book, événements internes, idempotencyKey, fingerprint, grants, policy ou secrets. Références : us-financial-pilot-projection.ts:18,44,58 ; us-financial-pilot-purchasing-projection.ts:9,107 ; us-financial-pilot-purchasing-server.ts:169,179.

## 6. Admission, session et revue UI

Bindings délégués aux ports usFinancialPilotDependencies existants, donc createSupabaseUsFinancialPilotStore unique. Flags core/ERP/V5-installed/pilot exact true, environnement exact TEST, cookies/origine, expected-user et marker pilote ; refus Authorization/credential natif/device. Auth sans offerAccess, membership/abonnement Gestion D1 effectifs, rôle owner/admin/accountant, configuration US/USD/accrual, grant/opt-in PostgreSQL versionnés vivants et policy capturée. Renouvellement avant/après attentes privées et avant divulgation ; diagnostics limités à operation/code/status. Les fences Auth/D1 et PostgreSQL ne deviennent pas une transaction distribuée. Sources : us-financial-pilot-bindings.ts:17,26,42 ; us-financial-pilot-store.ts:77,109 ; pilot_dto1.sql:24 ; foundation_v5.sql:84.

Prévoir allowlist d'erreurs propre : dates/montants/lignes/équilibre/comptes, journal absent/source non manuelle/double contrepassation, période inconnue/fermée/ordre/limite/collision et codes admission/CAS connus. Mapper explicitement les LedgerError attendues sans getter/message arbitraire ni détail SQL ; le handler achats n'expose actuellement qu'un sous-ensemble achats (purchasing-server.ts:21,41). Les codes d'erreur seuls ne prouvent pas l'absence d'append après postflight.

Ajouter pendingKind accounting et les méthodes accounting, retryAccounting, readAccountingContext, readJournal, readPeriod à LA session actuelle. Étendre son union pending et send, pas créer un deuxième transport/verrou. Payment, commerce, invoice prepare/issue et achats restent bloqués pendant l'écriture ou sa reprise incertaine. Garder le body exact et son UUID/expectedRevision en RAM. Erreurs d'écriture sans preuve de phase, y compris 409 tardif ou résultat invalide, restent incertaines à l'image achats ; pas d'abandon implicite du pending ni reconstruction sur nouveau head. Stop/dispose/perte d'autorité effacent pending et contenu privé ; aucune promesse de reprise durable après reload. Références : browser-us-financial-pilot-session.ts:29,133,137,169,235,257,282,346.

Surface dédiée sous onglets Journaux et Périodes existants : registre → détail → brouillon → revue → confirmation explicite. Ligne initiale débit/crédit et ajout/retrait accessibles, totaux exacts et différence lisibles, comptes autorisés par code/nom ; source déclarée, dates séparées et catégorie cash au bon moment. Revue contrepassation montre source complète consultable, raison, dates/période et inversion immuable. Revue ouverture montre bornes + dernière fin autoritative ; clôture montre la plus ancienne ouverte et son effet. Aucun solde automatique de résultat.

Conserver les brouillons quand le head avance ou que l'onglet change ; invalider revue/confirmation à chaque édition ou révision, relire comptes/source/période, demander une nouvelle confirmation humaine sans modifier les montants du draft. La clôture entre revue et confirmation doit échouer/réexiger revue sans perte de saisie. Après reçu, ne montrer qu'un détail à révision au moins celle du reçu. Même monde Operate/account, FR/DE/IT/EN, clair/sombre, clavier, mobile/320px ; pas de refonte globale ni nouveau contexte impeccable avant la phase d'implémentation déjà cadrée.

## 7. Inventaire borné proposé

Inventaire retenu pour le dispatch : 19 créations de sources/tests/routes et 2 modifications partagées.

- lib/international/us-financial-pilot-accounting.ts et .test.ts : contrat fermé, build serveur et reçu.
- lib/international/us-financial-pilot-accounting-projection.ts et .test.ts : context/détails/cursor journal_lines.
- lib/international/us-financial-pilot-accounting-server.ts et .test.ts : admission, résolution V5, opérations/lectures, reprise et erreurs.
- lib/international/us-financial-pilot-accounting-bindings.ts et .test.ts : ports existants et absence de nouveau profil/provider.
- lib/international/us-financial-pilot-accounting.postgres.test.ts : vrais 33 migrations/wrappers/store/handlers, NodeFS.
- app/api/international/workspaces/[organizationId]/financial-pilot/accounting/operations/route.ts.
- app/api/international/workspaces/[organizationId]/financial-pilot/accounting/context/route.ts.
- app/api/international/workspaces/[organizationId]/financial-pilot/journals/[journalRevision]/route.ts.
- app/api/international/workspaces/[organizationId]/financial-pilot/periods/[periodId]/route.ts.
- lib/international/browser-us-financial-pilot-accounting-input.ts et .test.ts ; browser-us-financial-pilot-accounting-copy.ts ; browser-us-financial-pilot-accounting.test.ts.
- components/account/us-financial-pilot-accounting.tsx et .css.
- Modifications : lib/international/browser-us-financial-pilot-session.ts ; components/account/us-financial-pilot.tsx.

Aucune modification prévue aux moteurs/runtime-types/ledger, stores privés, ancien profil accounting, migrations historiques, prix/abonnements/Price IDs, région, CH, natif ou déploiement. Réutiliser rapports/exports actuels ; les modifier uniquement si une défaillance concrète et pertinente est démontrée. Les documents de plan/livraison et preuve finale seront séparés du manifeste d'implémentation ; artefacts locaux futurs sous .qa/us-pilot-accounting/. Ne pas modifier les contrôles globaux/détecteurs pour transformer une sortie manquante ou en échec en succès.

## 8. Tests significatifs et sortie de phase

Les tests ci-dessous sont à ÉCRIRE/EXÉCUTER dans la future phase ; aucun résultat n'est revendiqué ici.

1. Contrat/saisie : capture immuable et absence de getters/clefs privées, UUID/actions/receipt retarget, bornes UTF-8/1000 lignes/textes, montants > Number.MAX_SAFE_INTEGER, somme >36 chiffres valide, ligne double-positive/double-zéro, déséquilibre/total nul, compte inconnu/interdit, cash net non nul sans catégorie et cash net nul sans catégorie. Dates distinctes et périodes limites sans règles métier inventées.
2. Projections : journal/source hors page 1 ; 26+ journaux et 26+ lignes (25+reste), détail direct de période après page 1 ; cursor retarget type/journal/révision, head avançant pendant lecture, confidentialité à succès et échec, totalité des lignes/totaux/liens cohérente. Périodes descendantes >25 avec PLUS ANCIENNE ouverte hors page 1 ; 100 puis refus de 101 ; ouverture valide alors qu'une période précédente reste ouverte ; refus clôture d'une période plus récente.
3. Serveur mémoire/bindings : vrais handlers, source résolue dans ledger V5 avec avoirs intercalés et ledgerRevision différente de global/compat ERP, refus sous-registres et deuxième nouvelle reversal, IDs déterministes/collision, tenant/utilisateur/rôle/device/Authorization, grant/opt-in/policy/config/flags retirés pendant attendus reads/projection/commit ou échecs. Mapper les erreurs attendues sans fuite et préserver les erreurs d'autorité prioritaires.
4. Concurrence/reprise : deux sessions locales avec brouillon conservé et revue invalidée ; source ou période change avant confirmation ; vrai commit entre receipt probe et source/re-probe ; vrai append + réponse perdue puis événements ultérieurs ; vrai append + 409 postflight ; retry même UUID après reversal et close ultérieurs ; payload ou expectedRevision changés sous UUID refusés. Un reçu historique doit sortir avant toute nouvelle vérification sémantique bloquante. Aucune duplication ni rebase silencieux.
5. PostgreSQL local : charger exactement la sélection 33 actuelle ; utiliser createSupabaseUsFinancialPilotStore et les vrais wrappers/handlers. Livre mixte avec vraie émission invoice V5, avoirs/encaissements/commerce/achats, puis journal, contrepassation, clôture, ouverture suivante, nouvelle facture fournisseur et règlement. Vérifier révisions globales/ledger/audit distinctes, journal/cash-flow/balance/trial-balance/GL/export concordants, compteurs estimate/invoice/project inchangés par ces quatre commandes, original et snapshots inchangés, fermeture des anciens profils après invoice. Refus SQL de déséquilibre, compte inconnu/interdit, période/source/reversal falsifiée, stale CAS et admission, avec zéro mutation.
6. Fermer proprement PGlite NodeFS, rouvrir une NOUVELLE instance, comparer livre/rapports/détails puis reprendre les mêmes reçus après clôture/contrepassation, sans changement d'état. Les fixtures de pagination peuvent préparer l'historique ERP avant promotion puis contenir une vraie émission V5 ; ne pas prétendre mesurer charge ou 50+ nouveaux événements V5 consécutifs à partir de cet historique.
7. Une fois les sources figées : targeted tests utiles puis régression conservant les 188 fichiers achats livrés, dont les 181 fichiers invoicing précédents ; TypeScript global, lint ciblé avec --type-aware, marque/build, recette navigateur FR/DE/IT/EN clair/sombre bureau/mobile/320px, clavier/recovery/second client et revue indépendante. Conserver sorties brutes et échecs précédents, ne pas additionner les suites qui se recouvrent. Empreintes et recorder lient la sélection et les octets du commit final effectif, sans importer les 6136 tests achats ou leurs résultats comme succès de cette phase.

La clôture actuelle change status et ajoute l'audit, sans solder income/expense ni créer d'écriture de résultat : accounting/us-journal.ts:89 ; accounting/ledger.ts:140. Présenter une période TECHNIQUE, sans affirmer adoption/changement d'année fiscale ou clôture annuelle complète. Références IRS examinées par le responsable de phase : https://www.irs.gov/publications/p583 et https://www.irs.gov/publications/p538 ; cette distinction de portée n'ajoute pas de condition préalable à l'implémentation.

Critère de sortie : quatre intentions réellement utilisables avec revue humaine, contexte/détails bornés, livre cumulatif unique, replay historique exact, autorité fraîche et tests/recette/checks du commit final satisfaits. Limites à documenter : PGlite sérialisé, Auth/D1/fiscal synthétiques, aucun multiconnexion/charge/crash recovery/SLA/hébergement ou certification US GAAP/SOC2/clôture fiscale ; reprise navigateur seulement en RAM. Les rapprochements, originaux, automation, fiscalité provider et distribution native demeurent des verticales distinctes.


## 9. Exécution bornée et livrables

Répartir contrat/projection, serveur/recette PostgreSQL et navigateur entre responsabilités sans chevauchement. Geler les contrats partagés avant leur consommation ; un seul responsable modifie la session et le shell. La qualité finale s’exécute sur les sources figées, puis le commit de code propre précède le recorder et les documents de livraison. Préserver toutes les preuves antérieures et distinguer vérifications moteur, navigateur mémoire et PostgreSQL.

La nouvelle surface conserve le brief .impeccable/surfaces/financial-pilot.md et les tokens existants. Revue humaine lisible, groupes de champs courts, ajout/retrait de lignes accessibles, totaux visibles et messages de reprise concrets. Pas de refonte globale. Inspection groupée des langues/thèmes/largeurs, un seul détecteur final et handoffs de revue/documentation selon le workflow existant.

Livraison en huit rubriques : modifications, créations, fichiers modifiés, migrations/retour arrière, tests et résultats réels, risques, terminé et expérimental. La recherche IRS bornée est conservée dans .qa/us-pilot-accounting/research.md et sera documentée avec ses limites. La Suisse et les données existantes restent préservées.
