# Zentra US — achats manuels dans le pilote financier V5

10 octobre 2026. Livraison **locale privée TEST**, sans ouverture en production. Plan préalable : [US-FINANCIAL-PILOT-PURCHASING-PLAN-20261010.md](US-FINANCIAL-PILOT-PURCHASING-PLAN-20261010.md). Base : `e0141dd3d8945946638eca11f64c5eace6c7d614`. Implémentation : `422d081bb84775d5de9b48bf47959ccf7e280a33`.

La [preuve finale JSON](../evidence/us-financial-pilot-purchasing-20261010.json) lie les 21 sources, les résultats réellement exécutés, les recettes et les captures. Arbre validé : **3581 fichiers**, SHA-256 `78ae5ea63b07f1fdfe89301e6bb548cd9203a26fa4cfc4a83b7aeb523faf7509`. Les documents de livraison et l'extension du brief design ajoutés après cet enregistrement sont hors de cette empreinte et de ce commit de code.

## 1. Résumé des modifications

Le parcours fournisseur → facture fournisseur approuvée manuellement → règlement déjà effectué est raccordé au **même livre V5** que les clients, devis, émissions de factures, encaissements et avoirs. Trois intentions fermées sont admises : `save_vendor`, `record_vendor_bill` et `record_vendor_payment`. Le registre, le détail des factures, leur historique de règlements et la lecture directe du fournisseur courant deviennent des projections publiques bornées. Le store cumulatif `createSupabaseUsFinancialPilotStore` est conservé ; l'ancien profil achats seul ne le remplace pas.

Le contrat reste `consumer: financial-pilot`, `schemaVersion: 1`, UUID de demande et révision globale attendue. IDs d'entités et clé privée `pilot:purchasing:<UUID>` sont dérivés côté serveur ; organisation, acteur, comptes, devise et approbation ne sont pas fournis par le navigateur. Les collisions de création et éditions d'un fournisseur inconnu sont refusées. Les anciennes factures gardent leur snapshot fournisseur même après une modification du contact courant.

Net et taxe sont des chaînes de minor units exactes. Une taxe vide est refusée ; zéro doit être explicite. Le serveur calcule le total et estampille acteur, date et `manual_entry`. Le domaine existant porte net + taxe sur `purchases` contre `payables` ; les règlements utilisent `cash`. Ces opérations enregistrent un paiement déjà effectué et ne transfèrent pas d'argent. Le solde tient compte de **tous** les règlements autoritatifs, pas seulement de la page affichée.

Les nouvelles pages restent séparées de l'union fermée des pages antérieures : 25 éléments, curseur lié au type, à la révision et au scope. Le head et l'admission sont renouvelés après les attentes privées et avant toute divulgation. Aucun livre brut, clé d'idempotence, hash, grant, policy ou événement interne n'est transmis au client. Un reçu historique exact prime sur les changements ultérieurs sous autorité actuelle. Une erreur tardive peut suivre un append réussi : la reprise conserve alors le même contenu et UUID.

Dans l'interface, fournisseurs et factures fournisseurs disposent de leur liste, formulaire, revue humaine, détail et historique paginé. Le verrou d'écriture est partagé avec commerce, émission et paiements clients. Le polling silencieux conserve les brouillons, invalide une ancienne revue et demande de relire les données courantes ; il ne réajuste pas automatiquement les montants. Un résultat incertain verrouille les champs et propose uniquement la reprise exacte. La perte d'accès efface le contenu financier et les brouillons, sans projection ERP4 de secours.

Les mêmes composants servent FR/DE/IT/EN, clair/sombre et mobile ; l'USD et les dates documentaires restent en format US indépendamment de la langue. Les champs de date natifs gardent leur présentation contrôlée par le navigateur. Tokens, police et focus de l'espace compte sont conservés, avec actions de 44px et champs de 46px ; le checkbox natif de 20px reste dans un label cliquable de 46px. Aucune nouvelle palette, image ou animation n'est introduite.

## 2. Fichiers créés

**19 sources** :

- `app/api/international/workspaces/[organizationId]/financial-pilot/purchasing/operations/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/vendor-bills/[billId]/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/vendor-bills/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/vendors/[vendorId]/route.ts`
- `components/account/us-financial-pilot-purchasing.css`
- `components/account/us-financial-pilot-purchasing.tsx`
- `lib/international/browser-us-financial-pilot-purchasing-copy.ts`
- `lib/international/browser-us-financial-pilot-purchasing-input.test.ts`
- `lib/international/browser-us-financial-pilot-purchasing-input.ts`
- `lib/international/browser-us-financial-pilot-purchasing.test.ts`
- `lib/international/us-financial-pilot-purchasing-bindings.test.ts`
- `lib/international/us-financial-pilot-purchasing-bindings.ts`
- `lib/international/us-financial-pilot-purchasing-projection.test.ts`
- `lib/international/us-financial-pilot-purchasing-projection.ts`
- `lib/international/us-financial-pilot-purchasing-server.test.ts`
- `lib/international/us-financial-pilot-purchasing-server.ts`
- `lib/international/us-financial-pilot-purchasing.postgres.test.ts`
- `lib/international/us-financial-pilot-purchasing.test.ts`
- `lib/international/us-financial-pilot-purchasing.ts`

Documents ajoutés séparément : ce rapport, [notes réglementaires](US-FINANCIAL-PILOT-PURCHASING-REGULATORY-20261010.md) et preuve JSON. Les scripts, rapports bruts et captures sous `.qa/` et `.impeccable/review/` sont des preuves locales ignorées, référencées et empreintées par la preuve finale.

## 3. Fichiers modifiés

- `components/account/us-financial-pilot.tsx` : raccord de l'accès achats au pilote existant.
- `lib/international/browser-us-financial-pilot-session.ts` : intentions, lectures, verrou partagé et reprise dans la session commune.
- `docs/internationalization/STATUS-20261009.md` : actualisation, historique conservé.
- `.impeccable/surfaces/financial-pilot.md` : documentation de cette extension après revue finale, sans réécriture du système visuel.

Les deux premiers fichiers seulement appartiennent à l'inventaire d'implémentation. Aucun fichier métier CH, tarif/Price ID Stripe, package, dépendance, région, déploiement ou binaire natif n'est modifié. `PRODUCT.md`, `DESIGN.md` et `.impeccable/design.json` sont préservés.

## 4. Migration proposée et retour arrière

**Aucune nouvelle migration SQL ; aucune migration hébergée appliquée.** Les 33 migrations existantes ont été exécutées localement. Les wrappers privés conservent l'admission vivante et la délégation au store cumulatif ; leur allowlist admet déjà ces commandes achats et les événements d'émission. Aucun deuxième livre, table, registre, grant ou contexte provider n'est créé.

Admission conservée : cookies et origine admis, utilisateur attendu, marker pilote, Auth en lecture seule, membership/abonnement Gestion D1 effectifs, rôle owner/admin/accountant, US/USD/accrual, flags fermés par défaut, environnement exact TEST, opt-in/grant PostgreSQL versionnés vivants et policy capturée. Credentials natifs et Authorization sont refusés. L'autorité est renouvelée après les attentes, y compris en cas d'erreur privée ; les diagnostics sont bornés à opération/code/statut admis.

Retour arrière : fermer l'admission/les flags en conservant événements, reçus, marqueurs V5 et lecteur compatible. Aucun reset, suppression de queue, migration descendante ou retour ERP4 pour un espace promu n'est exécuté. Tout besoin de persistance nouveau exige un plan révisé avant migration. Les données, abonnements et espaces hébergés existants restent intacts.

## 5. Tests exécutés et résultats

| Contrôle réellement exécuté sur sources figées | Résultat |
| --- | --- |
| Régression finale | **6 136 / 6 136**, 188 fichiers, zéro échec/pending/todo ; les 181 fichiers précédents sont tous conservés. |
| Contrat/projection ciblés | **55/55**, deux fichiers. |
| Backend ciblé | **84/84**, trois fichiers : bindings 26, serveur mémoire 44, PostgreSQL 14. |
| Transport, saisie et session navigateur ciblés | **200/200**, cinq fichiers. |
| TypeScript global | `tsc --noEmit --incremental false`, sortie 0. |
| Lint typé final | `oxlint --type-aware --deny-warnings`, tous les 20 fichiers TS/TSX de l'implémentation, sortie 0. |
| Vérification de marque et build production | Sorties 0. Pas d'affirmation de build sans avertissement hérité. |
| Revue indépendante contrat/backend | PASS local TEST ; les 52 entrées de manifeste backend concordent. |
| Détecteur UI | Une exécution sur les trois cibles modifiées, `[]`, sortie 0. |
| Recette navigateur et revue finale | 11 assertions de comportement vraies ; 38 PNG validés ; **ship** limité aux nouveaux contrôles privés TEST. |
| Enregistrement final | Commit, arbre, sélection, sources et artefacts concordants ; recorder terminé avec succès après commit propre. |

Les suites ciblées recoupent la régression : **ne pas additionner leurs totaux**. Le lint backend ciblé initial était ordinaire ; la vérification finale des 20 sources est bien typée. Les commandes, sorties brutes, empreintes et inventaires sont liés dans la preuve JSON.

La recette PostgreSQL prépare et émet réellement une facture client V5 avant les achats. Deux sessions Request/Response fictives créent et modifient un fournisseur, approuvent 10 000 cents net + 725 cents de taxe, puis enregistrent 725 et 10 000 cents de règlements. Les factures clients restent présentes ; snapshot fournisseur, comptes, règlement complet et replay historique sans changement d'état sont vérifiés. CAS, doublons, collisions, surpaiement, période close, payload changé sous le même UUID, commit entre probe/source, réponse perdue après commit, 409 tardif puis règlement intermédiaire, retrait de grant/opt-in, rôle/tenant/utilisateur et credentials natifs sont testés. Aucune règle inventée `paymentDate >= billDate` n'est ajoutée.

Pour la pagination PostgreSQL, 26 factures et 26 règlements sont issus de vraies commandes ERP avant promotion, puis un règlement V5 vivant est ajouté : pages de factures 25 + 1, règlements 25 + 2, solde issu des 27 règlements et refus de retarget de curseur vers une autre facture. Ce n'est pas une mesure de performance de 52 nouveaux événements V5. Le répertoire NodeFS `C:/Users/alb/AppData/Local/Temp/zentra-financial-pilot-purchasing-b4Qt1u` contient la recette : 33 migrations, révision 14, `cleanCloseReopen: true`. Une nouvelle instance ouvre réellement le même répertoire après fermeture propre et reprend le reçu original sans mutation.

La recette navigateur distincte emploie les vrais handlers HTTP avec kernel mémoire V5 et Auth/D1 synthétiques. Deux clients partageant une identité fictive voient automatiquement une nouvelle facture, puis le solde passer de **108,25 à 58,25 USD**, puis à zéro. Une réponse volontairement perdue après commit est reprise avec le même UUID, sans doublon. Un paiement externe invalide la revue d'un brouillon conservé ; une modification fournisseur garde l'adresse historique de la facture. Les registres et l'historique fonctionnent au-delà de la première page, y compris un fournisseur chargé directement hors page. Le rapport affiché est équilibré à 9 491,25 USD de chaque côté, sans que cette observation UI vaille certification comptable.

Les 38 captures couvrent quatre langues, 1440px clair, 390px sombre, variantes supplémentaires et 320px allemand. Première inspection groupée puis une confirmation : quatre captures prématurées ont été remplacées par des images complètes avec DOM/mesures stabilisés, **sans modification UI/source**. Le reviewer a ouvert chaque PNG et validé décodage, dimensions, hashes, pixels RGB, contenu non vide et largeur des contrôles. Ce sont des conversions PNG de JPEG navigateur, pas des originaux PNG sans perte. Il confirme 33 hashes antérieurs inchangés et une inspection fraîche de la capture italienne restante, sans inventer une comparaison historique absente. Formulaire verrouillé avant revue et répétition de messages de reprise ont été évalués non bloquants au périmètre présent ; aucun autre polissage n'est requis.

Tentatives initiales conservées : code query non admis corrigé ; import/attente de code grant de fixture corrigés ; essai de 52 événements V5 dépassant 60s remplacé par une recette paginée explicitement bornée ; retarget de test visant par erreur la même facture corrigé à la suite de la revue indépendante. Ces tentatives ne sont pas présentées comme réussies. Les octets finaux sont ceux liés aux 84 tests backend et 6 136 tests globaux réussis.

## 6. Risques identifiés

PGlite est sérialisé dans un processus. Sessions synthétiques et interleavings déterministes ne démontrent ni multiconnexion PostgreSQL, charge, hébergement, crash recovery, Realtime hébergé ni SLA. Le close/reopen est propre uniquement. Auth/D1 et observations fiscales sont fictifs ; les contrôles Auth/D1/PostgreSQL ne constituent pas une transaction distribuée. Une erreur postflight peut suivre l'append ; la reprise exacte est donc indispensable. La recette visuelle de deux clients n'est pas une preuve indépendante de deux vrais comptes ou appareils natifs.

La source est une référence manuelle sans vérification ni archivage de l'original. Le coût fixe sur `purchases` n'est pas une imputation universelle pour stocks ou immobilisations, ni une déductibilité automatique. Une taxe d'achat à zéro n'établit ni exemption ni absence de use tax. Pas de TVA suisse récupérable, de calcul exhaustif des taux américains, de certification US GAAP/SOC 2 ou d'étude des cinquante États. Voir les [sources officielles et limites réglementaires](US-FINANCIAL-PILOT-PURCHASING-REGULATORY-20261010.md).

La reprise inconnue reste **en RAM** : fermer ou recharger ne démontre pas une reprise durable intersession. Les champs et focus natifs ont été inspectés dans le navigateur, sans essai indépendant de lecteur d'écran, appareil tactile natif ou audit de contraste complet. Les captures ne remplacent pas les contrôles backend. Les longs formulaires mobiles restent lisibles dans la recette bornée ; la revue ne vaut pas audit de toute l'application.

## 7. Fonctionnalités terminées

Création/édition fournisseur, facture fournisseur approuvée humainement avec taxe reçue explicite, règlements partiels/finals déjà effectués, snapshot historique, registres/détails/historique paginés et solde autoritatif sont raccordés au consommateur privé V5. Admission fraîche, révisions, CAS, reprise exacte, verrou partagé, brouillons conservés, relecture courante, effacement sur perte d'accès et actualisation silencieuse locale sont vérifiés. Contrat, backend, navigateur, régression, qualité, revue indépendante et recorder sont terminés **au périmètre local TEST**.

## 8. Expérimental et prochaine phase

L'ERP US complet reste en développement. Originaux/Support/Automation, stock/immobilisations, avoirs fournisseurs, use tax/détermination fiscale, cash basis, devises étrangères, banque, provisioning/admission hébergés, sandbox fiscal réel, multiconnexion/charge/crash et admission/distribution natives restent ouverts. Aucun prix, provider ou accès public nouveau n'est créé implicitement. L'objectif international demeure actif.

**Prochaine verticale recommandée : journaux manuels, contrepassations et périodes dans le même pilote navigateur privé TEST.** C'est le raccord de quatre commandes existantes, pas la réécriture du plan ancien de montée ERP4 vers v4. `runtime-types.ts`, `accounting/us-journal.ts` et `us-financial-kernel-erp.ts` possèdent `post_manual_journal`, `reverse_manual_journal`, `open_period`, `close_period`. `isUsFinancialInvoicingCommandV5` les inclut et l'append cumulatif SQL les autorise. Les listes actuelles montrent journaux/périodes sans formulaire de mutation. Le prochain plan doit confirmer l'absence de besoin SQL nouveau et conserver le store cumulatif, pas l'ancien profil accounting.

Critères d'acceptation à fixer avant développement :

1. Contrat de présentation fermé, IDs/clé serveur pour journal/contrepassation/nouvelle période, fermeture ciblant une période existante ; révision globale et reçu lié à demande/action/entité. Aucun actor, policy, ledger ou fingerprint client. Détail public avec lignes/dates/source déclarée/acteur/date et liens de contrepassation ; sélecteur des seuls comptes autorisés du livre courant, sans création implicite de compte.
2. Saisie puis revue humaine : montants canoniques exacts, au moins deux lignes, débits = crédits, total non nul, comptes connus, exclusion de `receivables`, `payables`, `tax-payable`, `deposits`. Classification operating/investing/financing si cash l'exige, dates transaction/comptabilité distinctes et référence déclarée. Borne publique de lignes/textes explicite ; ne pas inventer de borne du total absente du domaine.
3. Contrepassation d'un seul journal manuel existant non déjà contrepassé : le serveur retrouve la source et inverse exactement ses lignes/catégorie cash ; aucune ligne de contrepassation client. Original intact, refus des factures/paiements/achats et autres sous-registres comme source. Reçu historique prioritaire après événements ultérieurs.
4. Ouverture après toutes les fins existantes, ID unique, dates calendaires et maximum actuel 100 périodes. Clôture de la plus ancienne ouverte après revue explicite ; pas de réouverture, clôture fiscale certifiée ou résultat automatiquement soldé. La clôture refuse les nouvelles écritures sans invalider le replay des anciennes.
5. Même admission fraîche, store, verrou partagé et reprise exacte que commerce/facturation/achats. Brouillon conservé lorsque le head avance, confirmation invalidée, relecture comptes/source/période ; aucun auto-rebase des montants. Effacement sur perte d'autorité. Append réel puis réponse perdue/409 et retry du même UUID après clôture ultérieure sans doublon.
6. PostgreSQL local, 33 migrations existantes : livre mixte invoice/avoirs/encaissements/achats → journal → contrepassation → clôture → ouverture suivante → achats/règlements dans la nouvelle période. Révisions métier/ledger/audit distinctes, rapports/exports concordants, compteurs documentaires inchangés ; refus déséquilibre/compte interdit ou inconnu/mauvaise période/double contrepassation/acteur/tenant/rôle/grant/opt-in et close/reopen. Aucune prétention multiconnexion/crash.
7. Pages/détails au-delà de 25, révision/scope et confidentialité ; source hors première page. Tests de saisie, brouillon après collaboration, période fermée avant confirmation, retry incertain et second client local actualisé. Régression conservée, TypeScript global, lint typé, marque/build, FR/DE/IT/EN clair/sombre/mobile/320 px sur sources figées et revue indépendante.

Cette proposition n'ajoute aucune banque, fiscalité provider, réconciliation, mutation de sous-registre ou mise en production. Le rapprochement ultérieur pourra s'appuyer sur capital/frais manuels approuvés, mais restera une verticale distincte avec identité durable des relevés et unicité des correspondances entre relevés. Ces fonctions ne sont pas revendiquées comme développées ici.
