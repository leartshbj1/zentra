# Plan préalable — relevé client CSV du pilote financier US

11 octobre 2026. **Plan local arrêté avant implémentation, dans l’objectif international autorisé.** Il remplace les contradictions du candidat antérieur et reprend les décisions root arrêtées dans `.qa/us-pilot-seller-integration/customer-statement-decisions.json`, après la contrelecture `customer-statement-review.md`. Le candidat et sa contrelecture ont été préparés sans édition produit ni contrôle exécuté. La présente étape crée et committe ce plan suivi avant toute modification des quinze sources ; les résultats du futur lot restent à obtenir.

**Baseline obligatoire avant code : `863a43a174a5230ce66e786b3e6244914e4c69ea` ; documentation B1 : `002d2d380e92fbf1cedefff7682579e762e8d21f`.** Le HEAD temporairement observé `cab04c30fdff72626cef1bfb07e43c478f724b8c` ne remplace pas ces placeholders : B1 a été validé puis livré dans les deux commits cités. L’arbre de départ a été vérifié propre à ce commit documentaire ; les quinze sources sont figées ci-dessous. Le code B1 a passé 7 151 tests sélectionnés, mais ces résultats ne sont pas les résultats du relevé client. Les résultats candidats ou historiques B1 ne seront jamais présentés comme des résultats de ce futur lot.

## Résultat utile et frontière arrêtée

Dans l'onglet Clients du pilote privé expérimental TEST US, choisir un client, consulter ses coordonnées actuelles au F observé et télécharger **un CSV complet** de ses factures émises, paiements affectés et avoirs. Le fichier contient le facturé, l'encaissé, le crédité et le reste à recevoir, par facture puis au total, tirés d'un seul livre V5 entièrement corroboré et rejoué.

Le périmètre est le livre **courant au F observé**. Le fichier n'est ni une lecture d'un ancien F après une écriture, ni un compte client à date passée, ni un relevé bancaire, ni une facture, ni une attestation fiscale ou comptable certifiée. Les factures soldées et créditées restent présentes. Les coordonnées d'en-tête sont celles du client au F demandé ; les noms historiques de chaque facture restent ceux enregistrés à l'émission. Les homonymes ne sont jamais fusionnés.

L'export n'écrit rien : aucun événement, journal, paiement, avoir, réservation fiscale, reçu, compteur, nouveau store ou état d'archivage. Il ne déclenche aucun appel fiscal, bancaire ou Stripe. F, L, B, S, les livres, registres et reçus restent exactement inchangés par sa génération. Aucun nouveau polling, timer métier, verrou de commande, migration ou endpoint n'est prévu.

Le fichier et ses invalidations dépendent de F et de son ledger L, pas des axes B/S. Une correction vendeur S seule ou une revue bancaire B seule ne modifie pas son contenu ; leurs dettes seules ne bloquent pas un F sain. Une véritable intention locale `pending` ou `writing`, bancaire ou vendeur comprise, reste bloquante et annule définitivement les résultats antérieurs de cette intention. Cette règle commune protège le lifecycle sans transformer S/B en sources du relevé.

## Raccords vérifiés en lecture seule

Les quinze chemins de l'inventaire existent au moment de cette préparation. Aucune insuffisance concrète de cet inventaire n'a été trouvée. Les lignes citées décrivent les octets actuellement lus ; elles devront être recorroborées sur la baseline B1 finale.

| Source actuelle | Conséquence pour l'implémentation |
| --- | --- |
| `us-financial-pilot-export-contract.ts:20–63,101–118,265–305` | L'union selector, les quinze champs communs, la variante devis et les sections sont fermés. Ajouter une vraie variante statement ; ne pas élargir les sections payments/credits existantes. |
| `us-financial-pilot-export-projection.ts:32–38,59–85,119–129` | Le builder générique à deux arguments capture/rejoue le livre complet, puis projette factures, paiements, avoirs et settlements. Le relevé s'y raccorde sans identité vendeur à trois arguments. |
| `us-financial-pilot-projection.ts:17–27` et `us-financial-kernel.ts:98–108` | Capture avant await, replay réel V5, F exact et settlements BigInt déjà disponibles. Les pages UI ne sont pas une source complète. |
| `us-financial-pilot-commercial-projection.ts:38–58` et `browser-us-financial-pilot-session.ts:222–228,800–805` | Lecture client actuelle et liée au F déjà disponible, avec garde après await. Réutiliser `session.readCustomer(id,F)` ; aucune modification de session générale ou de DTO client n'est nécessaire. |
| `invoicing.ts:180–192`, `runtime.ts:232–240`, `runtime-validation.ts:68–75`, migration ERP `20261007222349…sql:388–395` | Une baseline legacy valide peut réutiliser un paymentId dans deux factures. L'identité du registre paiements est **(invoiceId,paymentId)** ; l'unicité globale paymentId serait une régression. |
| `export-server.ts:87–105,166–228` et route `exports/reports/[kind]/route.ts` | La route REPORT transmet déjà le kind générique. Ajouter la query customerId et le filename dans le serveur existant. Le catch strict devis doit être étendu à cette seule nouvelle branche, y compris abandon/délai. |
| `browser-us-financial-pilot-export-session.ts:77–104,115–139,195–240` | ownerEpoch et ownerReady actuels sont liés à F/S et au devis. De simples booléens de controllers ne suffisent pas : les générations et les règles d'admission du résultat doivent être séparées. |
| `export-renderer.ts:20–60` | Le CSV sérialise parties/facts/sections, pas metadata/selector. Ajouter le fact customerId, même sans facture. Dates ISO et libellé crédité doivent rester spécifiques à la nouvelle branche. |
| `components/account/us-financial-pilot-export-actions.tsx:12–43` et `commercial.tsx:143–180,283–305` | Étendre le document UI par une variante client dédiée. Les états d'édition client et de sélection devis ne doivent pas servir de consultation relevé. Les styles existants suffisent. |
| `us-financial-pilot-exports.postgres.test.ts:215–284,288–290,328–377` ; `us-financial-pilot-seller.postgres.test.ts:159–161,286` | Deux recettes exports historiques distinctes32/34 existent. B1 ajoute la35e migration à la chaîne cumulative ; la prochaine recette exports sera une **troisième recette indépendante35**, sans nouveau SQL. |

## Contrat fermé arrêté avant code

### Selector, transport et corrélation

Exporter depuis le contrat existant :

```ts
type UsFinancialPilotCustomerStatementExportSelector = Readonly<{
  kind: 'report';
  reportType: 'customer_statement';
  customerId: string;
  revision: number;
  language: CompanyLanguage;
  format: 'csv';
}>;
```

Raccord public inchangé :

```text
GET /api/international/workspaces/<org>/financial-pilot/exports/reports/customer_statement
    ?revision=<F>&customerId=<encoded-ID>&language=<fr|de|it|en>&format=csv
```

Les quatre query keys sont obligatoires, uniques et exclusives. Refuser extras, clés dupliquées, valeurs absentes, format PDF, body non vide et méthodes autres que GET ; les erreurs de méthode conservent405. F est entier sûr positif strictement inférieur à MAX_SAFE_INTEGER. Le customerId est une chaîne exacte de1–160 caractères, trim canonique, sans contrôles, ni NUL ni Unicode mal formé ; aucune conversion en UUID, normalisation Unicode ou correction silencieuse. La construction URL utilise URLSearchParams/encodage canonique ; le nouveau chemin refuse les encodages pourcent/UTF-8 mal formés plutôt que substituer un autre ID. Les règles nouvelles restent locales à cette branche.

Le fichier s'appelle exactement `zentra-customer-statement-r<F>-<lang>.csv`. Pas de nom, email, adresse ou ID client dans le filename. Le navigateur vérifie ce nom exact, les en-têtes existants org/F/L/USD/langue/format, scope, SHA256 du selector canonique **incluant customerId**, SHA256 du contenu, longueur, MIME, nosniff et no-store. Aucun nouveau header S/B/C, UUID de mutation ou hash privé n'est ajouté. Le corps contient aussi l'ID lisible : l'intégrité du transport ne remplace pas l'identification du document.

Conserver `createUsFinancialPilotExportHandlers(deps).REPORT(request,organizationId,reportType)` et la route/binding actuels. Le nouveau selector passe au builder public à deux arguments existant `buildUsFinancialPilotExportSnapshot(book,selector)` ; aucune nouvelle dépendance quoteIdentity, seller, banque, font ou port de mutation.

### Snapshot, facts et parties

Ajouter les types `UsFinancialPilotCustomerStatementExportMeta` et `UsFinancialPilotCustomerStatementExportSnapshot`, puis une variante discriminée de l'union globale : quinze champs communs existants plus **statement**, soit seize champs fermés. Les snapshots devis gardent leur propre metadata estimate ; les anciennes variantes gardent exactement leurs quinze champs. Interdire statement sur les anciennes branches, estimate sur statement, ainsi que toute metadata étrangère.

```ts
statement: {
  customerId: string;
  scope: 'current_at_financial_revision';
  customerBasis: 'current_at_financial_revision';
  unallocatedPayments: 'unsupported';
  deposits: 'unsupported';
}
```

Ordre fermé des facts : `organization`, `currency`, `accountingBasis`, `financialRevision`, `ledgerRevision`, **`customerId`**. Les six sont kind text, et corrèlent org/USD/accrual/F/L/ID exactement. customerId est égal au selector et à statement.customerId. Le renderer sérialise effectivement ce fact après les cinq communs, y compris pour un client sans documents et pour deux clients vides homonymes.

`number:null`. `recipient` contient la fiche client courante au même F : nom, billingAddress, email/phone ou null. Cette exception au recipient des rapports n'est autorisée que pour customer_statement. `issuer` conserve le modèle des rapports internes : nom/email/phone null, adresse de la configuration du livre. Pas de duplication Party dans metadata, pas de vendeur courant effectif B1. Notice explicite « coordonnées actuelles du client à cette révision » ; données utilisateur inchangées, jamais traduites.

Client existant sans facture : trois sections présentes, rows vides et totaux exacts0. Client absent dans ce livre :404 `financial_pilot_export_source_not_found`, uniquement après admission ; aucun essai dans un autre tenant. F périmé au replay :409 `financial_snapshot_changed`. Source malformée :503 fermé.

### Trois registres complets

Ajouter les section kinds `statement_invoices`, `statement_payments`, `statement_credits`. Étendre ReportType avec customer_statement, mais **exclure ce reportType de SectionKind** : aucune fausse section générique customer_statement. Ne modifier aucune colonne/totaux des sections historiques invoice_lines/payments/credits/receivables ou des six rapports existants.

| Section | Colonnes fermées, ordre exact | Totaux, ordre exact | Identité |
| --- | --- | --- | --- |
| statement_invoices | invoiceId, customerId, number, customer, date, accountingDate, dueDate, total, received, credited, outstanding, status | total, received, credited, outstanding | invoiceId unique |
| statement_payments | invoiceId, invoiceNumber, paymentId, paymentDate, accountingDate, reference, amount | received | **paire (invoiceId,paymentId) unique** |
| statement_credits | invoiceId, invoiceNumber, creditId, number, transactionDate, accountingDate, reason, taxDisposition, net, tax, total | credited | creditId unique |

IDs, numéros, noms, références, motifs et statut sont text ; les dates sont date ; montants sont money alignés à droite. customer de ligne facture signifie le nom historique `invoice.customer.name`. Labels nouveaux à ajouter dans les quatre langues sans changer les anciens : titres customer_statement/statement_invoices/statement_payments/statement_credits, customerId/invoiceId/invoiceNumber/paymentId/creditId, consultation client et notices de portée/absence de fonctions. Le total d'avoir est libellé « crédité », jamais encaissé.

Ordre déterministe indépendant de locale :

1. Factures par date, puis number, puis invoiceId.
2. Paiements par paymentDate, puis accountingDate, puis invoiceId, puis paymentId.
3. Avoirs par transactionDate, puis accountingDate, puis invoiceId, puis creditId.

Comparer les chaînes par ordre explicite `<`/`>`, sans localeCompare. Ne pas inventer recordedRevision de paiement ni solde après chaque mouvement : les dates antidatées ne fondent pas un nouveau journal temporel de client.

### Provenance, calculs et validation

Capturer selector et livre avant les attentes pertinentes ; réutiliser `readUsFinancialPilotView` et le vrai `projectUsFinancialBookV5`, sans ERP4 ni copie des pages UI. Rechercher le client dans `view.customers` par ID exact, puis toutes les `view.invoices` dont `invoice.customer.id === customerId`. Paiements depuis leurs invoice.payments complets ; avoirs depuis view.credits liés à ces invoiceId ; settlements depuis la même vue replayée. Inclure baseline et événements V5. Un achat fournisseur, devis non émis ou journal manuel n'est pas une facture de ce client.

Le builder corrobore org, USD, invoiceId, customerId et invoiceNumber de chaque avoir avec sa facture ; il ne filtre jamais par nom. Le validator fermé corrobore le customerId des lignes facture à metadata/selector, les liens paiements/avoirs vers une facture présente et leurs numéros exacts, l'ordre et les identités ci-dessus. Une même paymentId peut figurer dans deux factures, sans fusion ni perte ; un doublon de la même paire est refusé. Deux erreurs opposées sur deux factures ne doivent pas se compenser.

Calculs BigInt uniquement. Par facture : somme des paiements = received ; somme des avoirs = credited ; `total = received + credited + outstanding`. Net+tax = total de chaque avoir ; historical_zero_tax impose taxe0 et adjustment_pending reste explicitement TEST, sans conclure à un remboursement. Montants non négatifs suivant les invariants réels du kernel ; aucun resserrement gratuit d'une baseline valide. Statut recalculé selon les cas actuels du kernel : open / partially_settled / paid / credited / settled_with_credit. Recalculer les quatre totaux globaux depuis les factures et les rapprocher des deux autres sections.

Le validator peut refuser un mouvement retiré avec un settlement resté inchangé, une paire dupliquée, un lien incohérent ou une arithmétique fausse. Il **ne peut pas démontrer la complétude/provenance d'un snapshot forgé entièrement cohérent**. Les tests du vrai builder doivent comparer tous les ensembles, cardinalités, lignes et montants au livre admis ; un hash et un total équilibré ne suffisent pas.

## Bornes, capture et bytes

| Borne arrêtée pour la nouvelle branche | Comportement |
| --- | --- |
| 96 chiffres décimaux canoniques en minorUnits, par valeur **et agrégat** | BigInt exact, zéro canonique, pas d'exposant/arrondi/Number. Source canonique représentable mais hors budget :413 financial_pilot_export_too_large ; forme non canonique/incohérente :503. Une somme de valeurs96 chiffres peut dépasser96 et doit être refusée. |
| 1000 lignes cumulées invoices+payments+credits | Précompter l'ensemble complet avant de construire les cellules.1001 →413, aucune tranche partielle.1000 n'est admis que si tous les autres plafonds sont respectés. |
| 50000 nœuds, profondeur14,500000 caractères de valeurs texte | Conserver les limites actuelles ; capturer les objets nouveaux par descripteurs et listes de clés fermées avant la copie de leurs champs. |
| 2097152 octets UTF-8 JSON du snapshot statement | Vérification spécifique nouvelle branche après capture bornée. Ne pas appliquer ce plafond aux anciens rapports, au livre complet ou aux anciens snapshots par convenance. |
| 12582912 octets de sortie, URL4096, deadline30s jusqu'au digest | Compter les vrais octets UTF-8/BOM ; refus entier, jamais fichier tronqué. Ne pas relancer une admission non bornée après expiration. |

Ne pas élargir le helper money, private-json ou le CSV partagé. Le captureSnapshot historique ne compte pas les caractères des clés : le nouveau chemin doit refuser les clés inconnues/accessors/symboles/prototypes exotiques/cycles avant d'adopter les champs, puis vérifier les limites exactes. Ne pas promettre une borne mémoire générale avant toute allocation par JSON.stringify. Aucun getter privé/message arbitraire ne doit être exécuté pour la validation d'erreur. Les traps qui rejettent ou retournent des formes invalides ferment proprement ; un Proxy transparent n'est pas universellement détectable en JavaScript.

Rendu nouveau uniquement : UTF-8 BOM, records CRLF, guillemets/délimiteurs/newlines correctement échappés, nombres USD à point et deux décimales sans séparateurs. Dates **ISO YYYY-MM-DD** dans les cells et facts date de cette branche, dans les quatre langues. Ne pas modifier displayCell/factValue des anciennes variantes. Tous les textes utilisateur passent par les primitives CSV anti-formule existantes, y compris préfixes Unicode whitespace/Cf ; les montants issus de BigInt restent des décimales canoniques. Les labels, statuts et notices sont traduits ; noms, IDs, références, motifs et autres données utilisateur sont conservés.

Le selector interdit PDF422. Le renderer PDF appelé directement avec un snapshot statement refuse via l'erreur export indisponible409 existante ; pas de chargement de fonts sur le chemin CSV. Préserver exactement le rendu existant des CSV financiers et les contrats des PDF facture/devis. Aucun format d'import bancaire ou logiciel tiers n'est promis pour ce CSV multi-sections.

## Serveur : admission et fermeture du nouveau chemin

Réutiliser la même admission : cookie, Expected-User, same-origin/Fetch-Metadata, refus Authorization et credentials device, rôle owner/admin/accountant, Gestion active, gates financiers TEST, opt-in/grant/policy actuels et US/USD/accrual. « Owner requis » côté navigateur signifie **objet réel de session financière propriétaire du résultat**, pas une réduction du rôle serveur à owner. Member/read_only restent refusés comme aujourd'hui. F-only ne dispense d'aucune permission actuelle.

Déroulé : paramètres publics fermés → gate/rate-limit/autorité → capture configuration/scope et méthodes read/head → lecture privée complète → capture/replay F → projection/validation → CSV et capture bytes → hash contenu puis selector → **head F courant exact** → pleine admission finale → réponse. Renouveler l'admission après les attentes privées réussies et rejetées ; vérifier la fermeture avant toute publication. Le store bancaire/vendeur, quoteIdentity et fonts ne sont jamais appelés pour ce relevé, même si leurs dépendances existent dans le binding.

La classification customer_statement est connue dans le catch indépendamment de la réussite de projection. Pour cette seule nouvelle branche :

- Après erreur privée, une404/409/413 ne peut sortir que si la pleine admission finale a réussi dans la deadline. Source absente404 puis scope503 →503 générique, sans nom/ID privé/message sous-jacent.
- Denials401/402/403 déjà corroborés gardent leur priorité ; une nouvelle révocation prouvée remplace le succès ou l'erreur précédente. L'allowlist inspecte descripteurs propres, jamais getters/toString arbitraires.
- Abandon du signal ou deadline épuisée empêchant de prouver la réadmission → réponse503 timeout/unavailable bornée ; ne pas conserver un vieux404/409 comme si l'admission avait réussi. Aucun octet/header de fichier n'est publié.
- Un F déjà périmé au replay, ou changé au fence final d'un résultat réussi, produit409. **Aucune priorité409 universelle n'est promise sur toutes les exceptions privées** : le catch n'a pas à relire head après un échec sans fichier. La réadmission reste obligatoire pour publier une erreur dépendante.

Ne pas refondre le catch des anciens rapports/factures ni changer leurs codes. Copier les bytes rendus avant l'attente du hash et ne pas exposer une référence mutable. Les erreurs possèdent seulement les headers de sécurité existants et leur code public borné : pas de livre brut, opération, clé privée, credentials, hash de source interne ou stack.

La dernière lecture F et les contrôles Auth/D1/PG ne constituent pas une transaction distribuée. Ils protègent un fichier cohérent au F courant lors des fences observés ; ils ne réservent pas l'état après téléchargement et n'empêchent pas une écriture postérieure au dernier fence.

## Session navigateur et action Clients

Introduire dans **la session d'export existante** une politique interne par selector. La nouvelle variante exige le vrai objet financialSession, même tenant, status ready, snapshot F exact, aucune dette F, aucun pending/writing. Elle ignore la dette B seule, la dette S seule et les changements externes B/S seuls. Le devis conserve S et ses en-têtes E/C/S ; les anciennes variantes conservent leurs comportements et la cancellation seller déjà existante.

Séparer réellement les générations, par exemple lifecycle/identité communs + génération financière/mutation + génération vendeur. Un stamp statement ne compare pas la génération vendeur ; un stamp devis la compare. L'observateur ne doit pas incrémenter la génération financière pour une simple correction S ou dette S. En revanche, tout début d'intention locale pending/writing invalide définitivement l'ancien stamp, même si l'intention échoue et F reste identique. Un retour à ready ne ressuscite jamais un résultat annulé.

Garder le single flight d'export local ; aucun verrou commun de write n'est acquis par le download. Vérifier ownership/génération/tenant/F avant départ, après chaque await réussi ou rejeté, après notification réentrante, avant adoption WeakMap, lors de createObjectURL, avant et après click. Stop/denial/changement de session ou tenant/F/debtF/pending annulent streaming/digest tardifs et révoquent les URL. Clone de résultat, autre owner ou résultat ancien refusés. Capturer les méthodes de la session et du port comme aujourd'hui ; dispose purge controllers/readers/timers/listeners/URLs.

Dans Clients, ajouter une action courte « Relevé » et **un état de consultation distinct** de customerDraft, de sa revue d'édition et du selected devis. Charger `session.readCustomer(customerId,F)` directement, sans rechercher le client en parcourant les pages ni ouvrir le formulaire Modifier. Afficher ses coordonnées et la portée du relevé ; proposer uniquement « Télécharger le relevé CSV », sans menus date/format/PDF.

Étendre le document de UsFinancialPilotExportActions par `{kind:'customer_statement',customerId}`. Le picker des six rapports existants ne gagne pas une entrée customer_statement sans ID. Réutiliser le même financialSession, les classes fp existantes et les deux fichiers copy inventoriés pour tous les nouveaux textes : aucun fichier commercial-copy ou CSS supplémentaire.

La tâche est conditionnée à l'onglet Clients visible et liée à la référence de session, tenant, F, customerId et langue. Chaque changement/démontage invalide synchroniquement les identités de vol ; les réponses tardives et les notifications réentrantes ne peuvent adopter une fiche, notice, erreur ou fichier chez le client suivant. Purger feedback et URLs sur cleanup/StrictMode. Une correction S/B seule n'entraîne pas de rekey ou blocage artificiel. Les drafts/revues/reprises client, devis, facture, banque et vendeur ne sont ni réécrits ni effacés par la consultation.

## Inventaire exact — quinze fichiers existants de code/tests

| # | Chemin | Changement prévu dans ce lot |
| --- | --- | --- |
|1|`lib/international/us-financial-pilot-export-contract.ts`|Selector CSV, metadata statement et trois sections fermées ; facts, corrélations, capture/budgets locaux.|
|2|`lib/international/us-financial-pilot-export-contract.test.ts`|Contrats hostiles, identité paiement composite, arithmétique/statuts et plafonds.|
|3|`lib/international/us-financial-pilot-export-projection.ts`|Projection complète client depuis le vrai livre V5 et bornes avant cellules.|
|4|`lib/international/us-financial-pilot-export-projection.test.ts`|Sources mixtes réelles, baseline compatible, current/historical et ensembles complets.|
|5|`lib/international/us-financial-pilot-export-server.ts`|Query customerId, nom exact, branche failclosed succès/rejet/abort/délai.|
|6|`lib/international/us-financial-pilot-export-server.test.ts`|Vrais handlers mémoire, admission/fences/query/bytes/budgets et dépendances non appelées.|
|7|`lib/international/us-financial-pilot-export-renderer.ts`|Trois sections, notices, ISO statement uniquement, refus PDF, anciens bytes inchangés.|
|8|`lib/international/us-financial-pilot-export-renderer.test.ts`|CSV parsé indépendamment, langues/formules/Unicode/96digits et parité des anciens exports.|
|9|`lib/international/us-financial-pilot-export-copy.ts`|Labels et notices documentaires quatre langues ; aucun remplacement de données utilisateur.|
|10|`lib/international/browser-us-financial-pilot-export-session.ts`|URL/filename, owner requis, générations F/S distinctes et politique F-only.|
|11|`lib/international/browser-us-financial-pilot-export-session.test.ts`|Vraie session+handlers+kernel, reentrance, streaming/hash/download et compatibilité devis.|
|12|`lib/international/browser-us-financial-pilot-export-copy.ts`|Action/consultation/feedback/erreurs client quatre langues ; pas de conseil « période plus courte » pour un filtre absent.|
|13|`components/account/us-financial-pilot-export-actions.tsx`|DocumentKind client et CSV fixe, tâches/feedback/owner liés au contexte.|
|14|`components/account/us-financial-pilot-commercial.tsx`|Consultation client dédiée et action sans changement du formulaire d'édition.|
|15|`lib/international/us-financial-pilot-exports.postgres.test.ts`|Troisième recette cumulative35 séparée, contexte2 B1 et S/B-only réels, clean reopen.|

Zéro fichier code nouveau, quinze existants modifiables. Documentation ultérieure séparée : plan suivi, livraison huit rubriques, evidence JSON et préfixe STATUS bytepreserving après résultats réels. Les harnais/recorders ignorés sont séparés sous `.qa/us-pilot-customer-statement/` et ne deviennent pas des fichiers produit.

Route générique, bindings export, session financière générale, commercial contract/projection, kernel, money/csv partagés, migration/RPC/SQL, dépendances/package, CH, natif, SaaS/Stripe, providers et gates d'hébergement hors inventaire. **Toute nécessité démontrée d'un seizième fichier exige un amendement suivi avant son édition.** Le nombre15 n'autorise pas une modification cachée ailleurs ni une dégradation d'une garantie. Aucun besoin supplémentaire prouvé à cette lecture.

## Étapes concrètes sous ce plan arrêté

1. **Baseline et preuves de compatibilité.** Renseigner les commits B1 finaux, vérifier les quinze interfaces et la chaîne35, enregistrer les SHA de départ. Conserver les sources/bytes de référence des anciens CSV et toutes les preuves B1, banque, devis et clients. Arrêter les labels/langues et les types exportés ci-dessus avant travail parallèle.
2. **Contrat et projection.** Ajouter la variante fermé, les facts/sections et la capture/budgets statement ; implémenter le filtre complet V5 et les corrélations par facture puis globales. Écrire les tests source/hostile/baseline pour la paire de paiement ; ne fabriquer ni chart invalide ni snapshot financier incohérent pour contourner une limite.
3. **Rendu et HTTP.** Ajouter copie document et renderer statement, garder les vieux bytes exacts, raccorder REPORT sans route/binding neuf. Fermer admission/catch/abort/deadline uniquement pour la nouvelle branche et tester les attentes/rejets privés sans fuite.
4. **Session et interface.** Séparer générations/politiques, puis ajouter la consultation dédiée et l'action CSV fixe avec le vrai owner. Couvrir B/S-only, pending de chaque famille, mutation/réentrance/cleanup et tous les points d'adoption/download.
5. **Recette PG cumulative et persistance.** Ajouter uniquement la troisième suite dans le fichier15, à DB NodeFS distincte. Utiliser réellement B1 context2 et des corrections S/bank-only admises ; produire des assertions numériques/ensembles indépendantes et l'invariance des sources après export.
6. **Gel et validations sérialisées.** Geler les quinze sources et dépendances avant chaque run d'acceptation. Root orchestre ciblés, qualité globale et régression de la sélection B1 finale augmentée ; aucun PGlite concurrent. Conserver toutes les tentatives/erreurs/recettes et comparer les empreintes avant/après. Aucun nombre de tests attendu ne devient un résultat sans run réel.
7. **Recette UI groupée et revue indépendante.** Monter le vrai composant/session/handlers avec données synthétiques bornées, collecter téléchargement réel et preuves des états nécessaires quatre langues/deux thèmes/desktop/mobile/clavier. Une passe de corrections groupée puis confirmation bornée sur les octets figés, sans preuve navigateur simulée. Contrelecture indépendante du diff et de la concordance des preuves avant livraison.
8. **Livraison documentaire.** Produire les huit rubriques ci-dessous et leurs manifests à partir des résultats effectivement obtenus. Ne pas activer un host, publier, migrer un service ou prétendre couvrir le natif/la production avec ce lot privé.

## Acceptation discriminante à exécuter plus tard

| Critère | Preuve attendue |
| --- | --- |
| Source complète et sommes indépendantes | Vrai livre V5 baseline+nouvelles émissions, clients homonymes distincts et client vide. Fixture chiffrée à figer : total10700 / reçu5000 / crédité3500 / restant2200 minorUnits, par exemple factures7000 partiellement payée,3500 créditée et200 ouverte. Comparer chaque facture et tous les ensembles/rows au livre, pas seulement l'égalité globale. Au moins27 paiements affectés ; cas couvrant aussi les cinq statuts et sélection d'un client au-delà de la première page25. |
| Compatibilité historique | Baseline ERP réellement valide : deux factures du même client ont le même paymentId et des idempotencyKeys distinctes. Promotion réelle puis deux lignes distinctes exportées ; doublon de la même paire refusé. Correction client réelle : nouveau recipient au nouveau F, anciens noms et valeurs des factures intacts. Client vide : ID sérialisé et trois sections vides. |
| Corrélations hostiles | Paire dupliquée, customerId/numéro discordant, mouvement déplacé/omis avec settlement inchangé, statut/taxe faux et erreurs compensées entre factures refusés. Complétude du vrai builder comparée à la source ; ne pas attribuer au validator le rejet d'un faux snapshot entièrement cohérent. |
| Montants et capacités | Un centime, au-delà de MAX_SAFE_INTEGER, valeurs/agrégats96 chiffres admis sous les autres budgets,97 canoniques refusés413 ; exposant/leading-zero/-0 non canoniques503.1000 lignes cumulées sous budgets admises,1001 refusées ; cas séparés nœuds/profondeur/texte/UTF-8 JSON/sortie/deadline. Getter non exécuté, symboles/cycles/prototypes/extras/traps rejetants et mutation d'alias pendant replay/hash fermés. |
| CSV et ancien rendu | Parser indépendant : BOM, UTF-8 fatal, CRLF, cardinalités/IDs/totaux des trois groupes, Unicode/multiline/guillemets/virgules et formules après préfixes invisibles. ISO et décimales exactes dans quatre langues. Comparaison SHA/bytes des anciens CSV sur snapshots de référence capturés avant édition ; contrats PDF facture/devis conservés, PDF statement refusé et fonts non appelées. |
| Autorité et erreurs | Vrais handlers mémoire : query fermée/ID encodé/méthode/body/PDF/Authorization/device/origin/tenant/Expected-User/rôles/Gestion/gates/grant/opt-in/policy/config. Révocation et panne pendant succès **et rejet** source/render/hash/head ; source404→scope503 fermé503, render/hash rejeté→denial frais, abort/délai→pas de vieux404/409 ni bytes. F périmé ou changé avant fichier409. Sorties privées malformées503 sans getter/fuite, aucun port mutateur/provider/identity/seller/bank/font appelé. |
| Owner et invalidations | Vraie session+handlers : owner manquant/foreign/clone/résultat ancien, double appel, notification réentrante à chaque adoption/createObjectURL/click, stop/denial/StrictMode/client/langue/onglet/F. S-only pendant fetch/stream/digest/avant click conserve statement mais invalide toujours devis ; dettes S/B seules admises. Toute famille pending/writing annule définitivement même si F revient inchangé, sans second verrou/timer ni perturbation des reprises. |
| Parcours et persistance | Consultation distincte du formulaire Modifier, CSV fixe, client vide/absent/>25, clavier, desktop/mobile320px, quatre langues/deux thèmes et téléchargement réel corrélé aux octets/headers/SHA. Recette PostgreSQL35/context2 et clean reopen ci-dessous. Compter les observations réellement faites ; une assertion SSR ne remplace pas cette recette. |

### PostgreSQL35, B1 réel et clean reopen

Chaîne sélectionnée exacte :31 migrations jusqu'à `20261010100252_international_us_financial_test_invoicing_v5`, puis `20261010104148_international_us_financial_pilot_dto1` (=32), `20261010131903_international_us_financial_pilot_invoice_dto1` (=33), `20261010155848_international_us_financial_pilot_bank_test_v1` (=34), `20261010212730_international_us_financial_pilot_seller_test_v1` (=**35**). Recopier/revalider leurs noms/ordre/SHA depuis la recette B1 finale, jamais déduire36 du nombre de fichiers de livraison ou du dossier entier de migrations. Ce lot ajoute **zéro migration**.

La troisième suite utilise une nouvelle base NodeFS et les vrais wrappers financiers/HTTP ; autorités Auth/D1/taxe sont déclarées synthétiques. Émettre au moins une vraie facture via sellerInstalled/context2 après B1, conserver une facture historique et les paiements/avoirs réels, puis comparer le CSV complet à des ensembles et valeurs attendus indépendamment. Une correction S-only effective après promotion puis une revue B-only ne changent ni F/L/livre ni les bytes statement ; la nouvelle présentation vendeur ne fuit pas dans ce rapport interne. Aucun retrait de guard/trigger pour fabriquer ces transitions.

Avant/après chaque export, comparer livre canonique/SHA, F/L, counters, événements/reçus et registres/audits banque/vendeur ; toute écriture de préparation du fixture est séparée du périmètre de ces comparaisons. Une vraie écriture F pendant rendu est refusée au fence final. Recette read-only sous admission courante et refus rôles/tenant/grant ; le téléchargement ne peut créer DML ni reçu.

Fermer proprement PGlite, rouvrir par **une nouvelle instance** sur le même NodeFS, relire avec les wrappers réels : mêmes livres/registres/reçus, même snapshot statement et mêmes CSV/SHA sans nouvelle écriture. Comparer aussi les quatre totaux et ensembles aux attendus indépendants après reopen, pas uniquement à une précédente projection. Cela prouve une persistance après fermeture propre locale, pas crash recovery, concurrence multi-connexion, performances ou comportement hébergé.

Préserver strictement les chaînes/recettes historiques exports32 et quote34 ainsi que les sorties des autres lots. Nouvelle variable proposée à arrêter dans le runner : `ZENTRA_US_CUSTOMER_STATEMENT_RECIPE_LABEL`, label borné `[a-z0-9][a-z0-9-]{0,63}` ; nouvelle sortie `.qa/us-pilot-customer-statement/postgres-recipe-<label>.json` et CSV/proofs par label. N'écraser aucun alias ancien ni un résultat précédent ; restaurer/archiver les alias éventuellement produits par les anciennes suites lors d'une régression globale. Le recorder futur relève noms/bytes/SHA de sources,35 migrations, dépendances, recettes, raws, fichiers téléchargés et toutes les tentatives.

## Livraison finale obligatoire en huit rubriques

Les huit rubriques reprennent la convention des livraisons US existantes. **Elles seront renseignées après implémentation ; aucune n'annonce un résultat déjà acquis ici.**

1. **Résumé des modifications.** Parcours réellement fourni, scope au F courant, client actuel versus pièces historiques, CSV complet et absence d'effet financier.
2. **Fichiers créés.** Aucun nouveau fichier code prévu ; lister séparément les documents/evidence effectivement créés et les harnais ignorés. Toute création code passe d'abord par amendement.
3. **Fichiers modifiés.** Les quinze chemins exacts, rôle de chacun, SHA finaux, base et commit livré ; décrire toute extension préalablement amendée.
4. **Migrations proposées et retour arrière.** Zéro migration ; chaîne réelle35 utilisée uniquement en recette locale ; retirer l'action/variante selon le lot sans annuler de faits ni données. Aucun déploiement hébergé autorisé.
5. **Tests exécutés et résultats.** Commandes/runs/codes de sortie/counts réels, ciblés/régression/qualité, recette35 et reopen, parser/bytes/hash et parcours navigateur réellement observés. Préserver échecs/tentatives/not-run ; ne pas reprendre des counts B1 comme preuve du lot.
6. **Risques identifiés.** Courant F, non archivage/asOf, absence d'acomptes libres, limites/capture, fences non transaction distribuée, local/synthétique versus hosted/native/production non testés ; aucune conformité inventée.
7. **Fonctionnalités terminées.** Seulement critères corroborés : consultation, ensembles et montants complets, compatibilité, autorité et lifecycle, download réel. Identifier clairement tout critère restant.
8. **Fonctionnalités expérimentales et suite.** Pilote privé TEST, prochaine verticale selon besoin utilisateur, étapes Auth/D1/PG réels/publication/natif distinctes si autorisées ; pas d'activation US complète ou de promesse provider.

## Hors périmètre et condition de passage au code

Acomptes/paiements non affectés, trop-perçus, remboursements, allocations futures, opening balance, aging, solde chronologique ligne par ligne, dates/périodes/asOf, ancien préfixe F, PDF, portail/envoi/relance, archivage légal, providers/Stripe SaaS, Support/Automation, natif, hébergement, CH et production sont exclus. Le téléchargement n'est pas une nouvelle émission de facture.

Passage au code après commit du présent plan avec inventaire15 et décisions ci-dessus ; l’autorisation de développement découle de l’objectif Zentra US existant. Aucune nouvelle approbation n’est demandée pour ce travail local. Si un autre fichier/store/API/règle comptable devient nécessaire, le signaler avec le défaut concret et amender avant édition. Ce plan n’implémente rien et ne modifie pas le rollback ni les preuves B1.

## Empreintes de départ arrêtées

Ces empreintes ont été relevées sur l’arbre propre de `002d2d380e92fbf1cedefff7682579e762e8d21f`, avant édition produit. La recette nouvelle restera séparée sous `.qa/us-pilot-customer-statement/`. Root sérialise tous les contrôles ; les agents peuvent éditer uniquement leurs fichiers assignés, sans test, build ou serveur concurrent.

| Fichier | Octets | SHA256 de travail | Blob Git de départ |
| --- | ---: | --- | --- |
| `lib/international/us-financial-pilot-export-contract.ts` | 29940 | `615c2950a3e76ae42422fa5e7b03bfbbc5aa3d52b5dd8bd87053da2bc887342c` | `9d991ce68a6c47d8080afe4e88d36e7da9cbb577` |
| `lib/international/us-financial-pilot-export-contract.test.ts` | 19295 | `5fdcfef831263c751f37e105fc5f3608393232b1711d6b114fa926004ba836bc` | `b9c0368ccdb35226561c5c142d05d99039fc464c` |
| `lib/international/us-financial-pilot-export-projection.ts` | 13970 | `47ac68b329c13fe645047b07cad098b80704f34198601798ce424d6d9591c77e` | `54acacc20a980eb529a08ccf76fadbf0cbfbfead` |
| `lib/international/us-financial-pilot-export-projection.test.ts` | 30032 | `a58f7b8ed1e29be7059beeaad84640de00a00832c5c3ab413b94c180488af7b0` | `8e3cf0482e6ef9594362b7c6be1acd29452bc05d` |
| `lib/international/us-financial-pilot-export-server.ts` | 23566 | `010d10592ce447313fa7a99e6f892286b2814167aca55b3e7466cde4be5aff67` | `f4b5e7b79f8a67bb33c4d900abca27f7a4e53c79` |
| `lib/international/us-financial-pilot-export-server.test.ts` | 28804 | `64dfbbbfd2e36159b8eb32ba744e68878b4e643622a5f87861bdd25676e665ce` | `8c299c78fa0530188c96a09294b80f487bafe1f1` |
| `lib/international/us-financial-pilot-export-renderer.ts` | 18052 | `5ac68d2d0e067e94a0d6a40226cc302fe9c9d93ad40630d6cdf8bbef4726cbfd` | `4da4ad1d7745c960ee19152d738ca22a764656a1` |
| `lib/international/us-financial-pilot-export-renderer.test.ts` | 32360 | `b01c8eeebaf9eb9c9bcd16fbc0d6d706a30cbda63d4632a53add3a7085a5eb42` | `e3db3bcad5c565f8948a36011741ca7150410500` |
| `lib/international/us-financial-pilot-export-copy.ts` | 14727 | `a56581370f1eed990d8332088cad70e19272919c6dc77c246e41c5d797085d41` | `6681e7cde407347302c0b91fe588eb647b4179e4` |
| `lib/international/browser-us-financial-pilot-export-session.ts` | 18055 | `69da071c5b1e7a2876df1c7ca928ef2fd4ed7481d4ed3ec5ef04406edf8217a3` | `8884b0fb11ff1728639e0b8944a975c178776c6d` |
| `lib/international/browser-us-financial-pilot-export-session.test.ts` | 46411 | `51dc7c9f622e93a2b47244a3c677c3cf7c390a3f38a247d15563460399828376` | `14581159dce3c16b5c013ddd7054a469a8568843` |
| `lib/international/browser-us-financial-pilot-export-copy.ts` | 9611 | `cba478387e7b3cd7cf71f389a5edf1affc525d436925fc358d083c1b69f7b15e` | `57afbec5262ae998541aef28035521905f05e3bf` |
| `components/account/us-financial-pilot-export-actions.tsx` | 6139 | `5fcf63c4614cb08099457f9839e3491b735d386d0bf9d8c381b01e141e33e1fb` | `15328f4e8e124872a784ff1b363f53d75f61bd80` |
| `components/account/us-financial-pilot-commercial.tsx` | 47934 | `2cf4c7ccd6403ec7196f71f338fe04a253a1bc1b96ce7fc3c647751bead52738` | `451f6f0545f8dd16ea754214b99b2daf9972e521` |
| `lib/international/us-financial-pilot-exports.postgres.test.ts` | 70456 | `d3e7a1c6cc5c455910041e991fa45b39b355be8bb043a90dff8645f9ce97ffc8` | `ba35ee5e36c75601354347420848c26bf140dc52` |

Gate d’hébergement, migrations existantes, sources B1 hors inventaire, Stripe SaaS et distributions natives restent inchangés. Les tests de ce lot n’autoriseront aucun déploiement de production implicite.
