# Pilote US V5 — PDF des devis, plan préalable

10 octobre 2026. Plan préalable arrêté après lecture du code et contrelecture indépendante. Le jalon clients est livré séparément : code `ceaed1c`, documentation `82862ab`, régression sélectionnée 6709/6709. **Implémentation et tests PDF devis à réaliser après ce commit de plan.** Les preuves customer-edit et les documents historiques restent intacts.

## Résultat et lacunes vérifiées

Depuis le détail d'un devis enregistré du pilote privé TEST, télécharger son PDF US Letter en FR/DE/IT/EN. Le fichier représente le devis à sa révision E dans le livre courant F, avant détermination de sales tax. Il ne crée ni facture, acceptation, reçu, journal, e-mail ou nouvel historique documentaire.

| Fait actuel | Référence et conséquence |
| --- | --- |
| Le pilote exporte facture/rapports seulement | `lib/international/us-financial-pilot-export-contract.ts:18–24`, `us-financial-pilot-export-server.ts:183`, `browser-us-financial-pilot-export-session.ts:42–54`. Ajouter une branche fermée, pas rouvrir l'export ERP1–4. |
| Le détail devis et ses montants existent | `us-financial-pilot-commercial-projection.ts:16–20,61–85` ; `components/account/us-financial-pilot-commercial.tsx:299–305`. Réutiliser le vrai replay V5 et le document enregistré complet, jamais le formulaire ou une page tronquée. |
| Le devis fige le client, pas le vendeur | `lib/international/invoicing.ts:11` ; `documents.ts:214–215`. Le nom/adresse/contact client viennent de `estimate.customer`, même après correction de sa fiche. L'identité vendeur sera **actuelle à l'export**, sans prétendre être celle de la création/acceptation du devis. |
| Les deux sources vendeur sont déjà versionnées | `seller-profile.ts:9–11,48–68,82–87` fournit S et le profil US ; `workspace-service.ts:13–19,94–106` fournit C et la configuration/adresse. `runtime-bindings.ts:91–96` perd S lorsqu'il transforme le profil en seller snapshot : ne pas utiliser cette projection amputée pour le nouveau fence. |
| Le binding export ne lit pas de vendeur courant | `us-financial-pilot-export-bindings.ts:5–16`. Nouveau lecteur privé nécessaire, sans tax merchant, secret/provider, profil CH ou fallback vers le vendeur d'une autre facture. |
| Renderer et bornes sont réutilisables, leurs libellés sont encore spécifiques | `us-financial-pilot-export-renderer.ts:20,82–94,131–141` ; `us-financial-pilot-export-copy.ts:6–8`. Ajouter titre/notice/date/totaux de devis ; ne pas afficher « vendeur à l'émission », « facturé » ou taxe zéro déterminée sur un devis. |
| Le téléchargement a sa propre session de lecture | `browser-us-financial-pilot-export-session.ts:60–80,153–164` ; `components/account/us-financial-pilot-export-actions.tsx:13–26,27–48`. Aucun raccord au pending/mutation financier dans ce composant aujourd'hui. Le nouveau chemin doit observer la session financière, sans deuxième verrou d'écriture ni timer. |

## Inventaire proposé exact — 21 fichiers de code/test

**18 existants modifiés, 3 nouveaux.** Pas de CSS, migration, dépendance, font, store/kernel ou modification de session financière générale prévue.

| # | Chemin | Changement |
| --- | --- | --- |
| 1 | `lib/international/us-financial-pilot-export-contract.ts` | Selector devis, variante snapshot fermée, labels/sections/headers et bornes. |
| 2 | `lib/international/us-financial-pilot-export-contract.test.ts` | Schémas/corrélations/arithmétique/budgets, anciennes branches inchangées. |
| 3 | `lib/international/us-financial-pilot-export-projection.ts` | Snapshot depuis le vrai devis V5 et l'identité privée capturée. |
| 4 | `lib/international/us-financial-pilot-export-projection.test.ts` | Client historique, vendeur courant, E/F/L et livres mixtes. |
| 5 | `lib/international/us-financial-pilot-quote-identity.ts` | **Nouveau** : capture/validation/lecture bornée des versions C/S, validation locale fermée de l’enveloppe country. |
| 6 | `lib/international/us-financial-pilot-quote-identity.test.ts` | **Nouveau** : séquences de lectures, changements/no-op, données hostiles et admission. |
| 7 | `lib/international/us-financial-pilot-export-server.ts` | ESTIMATE, dépendance privée d'identité, admission/fences et headers. |
| 8 | `lib/international/us-financial-pilot-export-server.test.ts` | HTTP, identité absente/changée, attentes/revocations et fences. |
| 9 | `lib/international/us-financial-pilot-export-bindings.ts` | Lecteurs country/seller existants sous admission pilote. |
| 10 | `lib/international/us-financial-pilot-export-bindings.test.ts` | Ports capturés et délégation route ESTIMATE. |
| 11 | `app/api/international/workspaces/[organizationId]/financial-pilot/exports/estimates/[estimateId]/route.ts` | **Nouveau** : GET mince. |
| 12 | `lib/international/us-financial-pilot-exports.postgres.test.ts` | Nouvelle recette complète actuelle, exports historiques et absence d'effets. |
| 13 | `lib/international/us-financial-pilot-export-renderer.ts` | Rendu PDF devis, notices et libellés appropriés. |
| 14 | `lib/international/us-financial-pilot-export-renderer.test.ts` | Texte, tableaux/multipage, glyphes et vraie structure PDF. |
| 15 | `lib/international/us-financial-pilot-export-copy.ts` | Copie documentaire quatre langues. |
| 16 | `lib/international/browser-us-financial-pilot-export-session.ts` | URL/headers devis et garde de session financière pour ce chemin. |
| 17 | `lib/international/browser-us-financial-pilot-export-session.test.ts` | Transport et intégration vraie session/handlers/kernel ; invalidation/download. |
| 18 | `lib/international/browser-us-financial-pilot-export-copy.ts` | Action PDF devis, identité actuelle, missing/stale/budgets. |
| 19 | `components/account/us-financial-pilot-export-actions.tsx` | Variante devis et garde commune ; un flight synchrone. |
| 20 | `components/account/us-financial-pilot-commercial.tsx` | Action dans le détail enregistré courant ; passage de l'owner financier. |
| 21 | `components/account/us-financial-pilot.tsx` | Fournir `expectedUserId` et le callback `exportDenied` existants au composant commercial ; transmettre ce callback à l’action PDF. |

Documentation de livraison séparée : plan suivi, livraison en huit rubriques, preuve JSON et STATUS. Aucun document antérieur/proof bancaire/customer-edit réécrit. Si le raccord impose une mutation du runtime, un nouveau RPC, un autre composant ou une migration, amender cet inventaire **avant** édition. Pas de CSS nécessaire : réutiliser `.fp-export-task`, `.fp-export-actions`, `.fp-export-feedback` et le détail commercial existant.

## Contrats proposés fermés

```ts
type UsFinancialPilotEstimateExportSelector = Readonly<{
  kind: 'estimate'; estimateId: string; estimateRevision: number;
  revision: number; language: CompanyLanguage; format: 'pdf';
}>;
type UsFinancialPilotQuoteIdentity = Readonly<{
  organizationId: string; countryRevision: number;
  configuration: CompanyConfiguration; sellerRevision: number;
  seller: UsSellerProfile;
}>; // privé, jamais accepté du navigateur
type UsFinancialPilotQuoteIdentityDependencies = Readonly<{
  country(actor: FinancialAuthority): Promise<WorkspaceCountryState>;
  seller(actor: FinancialAuthority): Promise<UsSellerProfileState>;
}>;
readUsFinancialPilotQuoteIdentity(
  deps: UsFinancialPilotQuoteIdentityDependencies, actor: FinancialAuthority,
  revalidate: () => Promise<FinancialAuthority>,
): Promise<UsFinancialPilotQuoteIdentity>;
type UsFinancialPilotEstimateExportMeta = Readonly<{
  estimateId: string; estimateRevision: number;
  status: 'draft' | 'accepted' | 'declined';
  countryRevision: number; sellerRevision: number;
  issuerBasis: 'current_at_export'; amountBasis: 'before_sales_tax';
}>;
// Ajouter à l'union existante sans changer les anciennes formes invoice/report :
// snapshot devis = les 15 champs existants + `estimate` de type Meta ci-dessus.
// selector.kind === 'estimate' impose cette unique forme supplémentaire.
buildUsFinancialPilotEstimateExportSnapshot(book, selector, identity);
// Nouveau builder privé explicite ; l’entrée historique invoice/report à deux arguments reste inchangée.
createUsFinancialPilotExportHandlers(deps).ESTIMATE(request, organizationId, estimateId);
```

Route : `GET .../financial-pilot/exports/estimates/<estimateId>?revision=F&estimateRevision=E&language=fr&format=pdf`. Exactement ces quatre query keys requises, chacune unique ; ID canonique 1–160 caractères sans contrôles/trim implicite, URI encodée. F/E positifs, sûrs et strictement inférieurs à `Number.MAX_SAFE_INTEGER`; aucun B, historique, corps, statut, vendeur, client, taux ou autorité transmis. Tous les états de devis existants sont lisibles/exportables, avec leur état affiché ; ce téléchargement n'enregistre aucune acceptation.

Snapshot : `consumer:'financial-pilot'`, schemaVersion1, tenant/F/L/USD/Letter/langue et selector corrélés ; E et ID du metadata égaux au selector et au devis relu. Issuer = profil US actuel + adresse de sa configuration C ; recipient = client **figé dans le devis**, jamais fiche courante. Dates date/expiresAt, délai, état, notes et toutes les lignes conservés. Une section `estimate_lines` ordonnée : description, quantité exacte, prix unitaire, remise par ligne en points de base, net après remise. La copie affiche les points de base en pourcentage exact (1000 → 10 %), sans flottant financier ; elle ne masque pas la remise d’une ligne derrière le seul total. Totaux exacts `subtotal`, `discount`, `net` ; somme des lignes = subtotal−discount = net. Ne créer ni colonne tax/received/credited/outstanding, ni total prétendant être TTC. Afficher explicitement « avant sales tax », la sales tax étant déterminée lors d'une facture ultérieure. Labels devis distincts de `date`/`total` actuellement libellés pour une facture.

Conserver le SHA du selector canonique ; nouveaux headers uniquement sur ESTIMATE : `X-Zentra-Estimate-Revision`, `X-Zentra-Country-Revision`, `X-Zentra-Seller-Revision`, `X-Zentra-Issuer-Basis: current_at_export`. E doit égaler le selector ; C/S positifs/sûrs correspondent aux metadata imprimées et au contexte capturé. Le content hash couvre le PDF complet. Aucun profil brut, configuration privée, policy/grant, acteur ou preuve fiscale dans les headers/erreurs. Nom déterministe sûr `zentra-estimate-r<F>-e<E>-<lang>.pdf`, sans texte utilisateur. Les anciennes réponses/headers PDF facture et CSV/PDF rapports gardent leurs formes.

## Identité, admission et déroulé serveur

Le module identité capture ses callbacks et arguments avant await, utilise `validateCompanyConfiguration` et `validateUsSellerProfileState` sur des snapshots JSON détachés, et valide lui-même l’enveloppe WorkspaceCountryState fermée (clés/status/tenant/C positif sûr/configuration). Le validateur d’enveloppe country actuel est privé et ne sera pas exporté ou modifié et ne fait aucune écriture. Port proposé dans les dépendances export : `quoteIdentity(actor, revalidate):Promise<UsFinancialPilotQuoteIdentity>` ; requis seulement pour ESTIMATE. Le helper reçoit les lecteurs actuels country/seller et le hook de pleine admission. **C et S sont des révisions différentes de F/E/L ; aucune n'est dérivée d'un reçu.**

Lecture bornée C1 → S → C2, pleine admission autour des attentes : C1/C2 configurés, tenant identique, même révision et configuration canonique ; seller configuré, US, S positif. Pas de retry/rebase silencieux si changement. Exiger configuration US/USD/accrual strictement identique à la configuration capturée d'admission et à la baseline du vrai livre V5. Le profil n'apporte aucun droit ; `getUsSellerProfile` vérifie un acteur structurel, le serveur pilote doit continuer à démontrer Auth/D1, rôle owner/admin/accountant, entitlement, gates TEST, opt-in/grant versionnés et policy. Une enveloppe country/seller hostile ou malformée produit503, sans acceptation partielle. Un profil manquant produit un refus public fermé `financial_pilot_seller_required`409 ; C/S différent lors du fence, y compris no-op revenant aux mêmes valeurs, produit `financial_pilot_quote_identity_changed`409 ; upstream malformé/outage reste503.

Ordre : capture Request/deps → paramètres/same-origin/cookies/Expected-User, refus Authorization → admission/rate limit → store read/head possédés → vrai livre à F et policy/configuration correspondantes → devis à E exact → identité C/S stable → snapshot validé → fontes possédées → rendu → octets/SHA → relecture identité C/S complète identique → head F exact → pleine admission finale → réponse. Les erreurs après lecture dépendante restent soumises à la pleine admission avant publication, en priorisant révocation/denial ; deadline/abort n'autorisent aucun fichier partiel. Les contrôles existants restent nécessaires après fonts/render/hash, pas seulement avant le calcul.

**Limite explicite :** ces lecteurs et fences successifs ne constituent pas une transaction unique Auth/D1/PG. C1=S=C2 ne signifie pas égalité de leurs nombres : seule la stabilité de C1/C2 encadre la lecture S. Les relectures prouvent des observations versionnées, pas une absence de changement après la dernière lecture. Un requirement de capture/fence atomique PG couvrant F+C+S exigerait un RPC/migration additif et un amendement préalable ; ne pas revendiquer cette garantie dans le lot sans SQL. Ne pas utiliser le contexte fiscal marchand pour obtenir le vendeur d'un devis : cela ajouterait des préconditions fiscales étrangères à cet export.

## Bornes et navigateur

Réutiliser les plafonds export actuels : 1000 lignes maximum, 500000 caractères, 50000 nodes/profondeur14, PDF200 pages, sortie12582912 octets, URL4096 caractères ; glyphes non disponibles refusés422. Ajouter pour le **snapshot devis seulement** un plafond explicite UTF-8 de2097152 octets sur sa sérialisation complète, après capture structurelle bornée ; aucune troncature de notes/lignes ou pagination de l'export. Un devis historique >100 lignes reste exportable jusqu'aux plafonds documentaires, indépendamment de la limite100 du formulaire. Rejouer le livre entier sous ses budgets existants, sans reconstituer une fausse vue ERP4.

Server deadline total30000ms (borne privée de tests existante max120000), incluant lectures/admission, fonts, rendu/hash et postflight. Deux fontes copiées ≤2097152 octets chacune ; `getUsExportFonts` est embarqué et ne fait ni FS ni réseau à l'exécution (`export-fonts.ts:11–17`). Noto Sans Regular569208/Bold575740 octets, provenance/OFL épinglées existantes ; conserver ces fichiers et `pdf-lib`/fontkit sans dépendance nouvelle. Client deadline30000ms inclut stream+digest ; erreur4096 octets max, Content-Length/flux/MIME/%PDF-/hash/headers corrélés, annulation du body et abort même si refus avant création du reader. GET `referrerPolicy:'no-referrer'`.

La session d'export reste une **lecture distincte**, pas un second moteur de mutations. Pour le selector estimate, fournir obligatoirement à `createBrowserUsFinancialPilotExportSession` l'owner financier capturé (type-only `Pick<BrowserUsFinancialPilotSession,'getState'|'subscribe'>`). Avant départ, après chaque await, à l'adoption et avant `download` : même référence réelle de l’owner/tenant/lifecycle, status ready, snapshot F exact, aucun state.requiresRefresh financier/pending/writing. bank.requiresRefresh seul n’est pas une dette financière et ne doit pas annuler le devis. Abonnement synchrone : début mutation commune, F nouveau/dette, stop/denial invalident l'epoch des lectures/résultats, abortent le stream et révoquent les URL. Invalidation temporaire ne dispose pas définitivement le task : après rejet d'un write sans changement F, une nouvelle demande doit rester possible. Dispose terminal au démontage/tenant/session/denial. WeakMap de résultats → selector/epoch/owner ; clone ou résultat ancien interdit. Aucun fichier confirmé ne modifie F/B/floors ou le pending financier.

Ne pas bloquer l'écriture financière pendant ce GET : un write peut avancer, ce qui annule l'export en vol. Un seul flight d'export gardé synchroniquement dans le task ; ce n'est pas un lock financier additionnel. B seul externe ne change ni devis ni son F, donc ne l'invalide pas ; write bancaire local invalide via publication writing/mutation. Clé React du task : owner/tenant/F/ID/E/langue ; onglet/détail changé purge le task. Aucune confirmation humaine nouvelle pour télécharger ; une demande fraîche relit toujours S/C. La copie explique l'émetteur actuel et le client historique. Préserver les brouillons commerciaux et le pending incertain lors d'un refus d'export ; denial purge par le parent. Ajouter `expectedUserId` et le callback parent `exportDenied` au seul passage parent→commercial→ExportActions nécessaire, avec dépendance React sur la référence réelle de l’owner, sans exposer une nouvelle autorité.

## Critères à exécuter après plan suivi

1. Schémas et captures : clés exactes, IDs/E/F/langue/PDF, prototypes/getters/symboles/Unicode, source/selector/callbacks modifiés pendant attente, arithmétique BigInt et quantités exactes. Anciennes branches export inchangées.
2. Identité réelle : C/S séparés, C change entre C1/C2, S change/no-op pendant fonts/render/hash/postflight, profil absent/étranger/CH/malformed, config différente de la baseline, révocation/flag/grant/opt-in/policy pendant succès **et rejet** ; aucun fallback de facture ou de profil suisse. Comparer intégralement le tuple attendu au fence.
3. Vraies projections/handlers/kernel : devis source à E, F périmé, client corrigé ensuite mais destinataire PDF ancien ; resave explicite du devis adopte ensuite le client corrigé. S nouveau change l'émetteur exporté sans réécrire le devis ni une facture émise. F/L/B/événements/reçus/numéros et completion bancaire inchangés par tous les exports/refus. Pièces émises conservent seller/client historiques.
4. PostgreSQL sérialisé : la recette exports historique est encore32migrations (`us-financial-pilot-exports.postgres.test.ts:267`) ; ajouter les deux migrations déjà livrées invoice_dto1/bank_test_v1 dans la chaîne cumulative34, sans modifier leurs SQL. Livre mixte customer-edit/émission/achats/compta/banque, vrai profil vendeur et country revision, deux exports avant/après correction, fermeture/réouverture NodeFS. Conserver les anciennes recettes/aliases et preuves, nouveau label quote-pdf distinct.
5. Transport avec vraie session : pending paiement/commerce/invoice/achats/compta/banque refuse avant GET ; write/HEAD F nouveau en vol annule avant adoption/download, B externe seul conserve ; stop/denial/tenant/unmount et subscriber réentrant, sélection changée, refus headers pré-reader, flux trop long/lent/hash invalide/forged result. Flight libéré après refus sans bloquer de futurs téléchargements ; aucune dette/pending effacée par export.
6. PDF réel : toutes les lignes/notes/remises, statut et E/C/S, destinataire historique, émetteur actuel, mentions TEST/avant taxe, fonts/glyphes, pagination/débordements, texte extrait+rasters ; cas Unicode supporté et refus explicite non supporté. Recette UI groupée quatre langues/deux thèmes/desktop/mobile, clavier, téléchargement réel, stale/missing/denial, sans nouvelle matrice expansive ni tests React qui copient l'implémentation.
7. Gel puis contrôles ciblés, PG sérialisé, types/lint/marque/build et **régression sélectionnée antérieure conservée**, sans appeler cette sélection couverture totale du produit. Tentatives/logs/hashes séparés de customer-edit/banque. Aucun résultat futur annoncé par cette note.

Rollback : retirer action/route ESTIMATE ou fermer les gates TEST, conserver les anciens exports et toutes les données V5. Aucun retour ERP4, effacement ou annulation financière. Hors périmètre : HTML/CSV devis, envoi/signature/acceptation externe, archive légale/versionnée, logo nouveau, fiscalité calculée, avoir/remboursement, projets/commandes, provisioning, natif, provider/Stripe, hébergement et production. Validation hébergée autorisée/Auth-D1-PG et examen professionnel des documents restent externes ; aucune certification revendiquée. La documentation officielle réseau est volontairement non consultée ici conformément au périmètre de repérage ; aucune API Supabase nouvelle n'est proposée.


## Décisions de la contrelecture

Revue indépendante : `.qa/us-pilot-customer-edit/quote-pdf-plan-review.json`, SHA256 `63fa86762f29332f1dd7535fc8949ab577c64f54dfa6bc603082c54a84384645`. Les cinq précisions ci-dessus (country fermé, callback denial, builder dédié, owner/dette, remise par ligne) sont intégrées avant code. Cette revue statique ne préjuge d’aucun résultat de test futur. Inventaire maintenu à21fichiers. Pas de nouvelle règle fiscale, certification, migration hébergée ni déploiement.
