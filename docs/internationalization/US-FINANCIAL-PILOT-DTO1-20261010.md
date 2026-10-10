# Zentra US — pilote financier navigateur DTO1

10 octobre 2026. **Livraison locale privée TEST ; implémentation des 31 sources dans le commit `c7fd6ed`.** Régression finale : **5 434/5 434 tests dans 161 fichiers**, zéro échec, skip ou todo ; **152 fichiers antérieurs conservés**. TypeScript global non incrémental, lint typé, marque et build : quatre codes de sortie 0.

Implémentation : `c7fd6edf9deeb0432e9d9f372910343c51efe488`. La nouvelle preuve enregistrée est [us-financial-pilot-dto1-20261010.json](../evidence/us-financial-pilot-dto1-20261010.json). Elle rattache les sorties réellement exécutées aux 31 sources committées et à l'arbre figé de 3 497 fichiers, SHA256 `2c5050dc915c41c990ed08787e598ba612fbd7b874b1994d3cdfb319f8173fd6`. Aucun test ni détecteur supplémentaire n'a été lancé pour la rédaction.

## 1. Résumé

Le lot ajoute un consommateur navigateur privé `financial-pilot`, DTO version 1, sur le livre financier V5 courant. Il permet de consulter factures, devis, clients, fournisseurs, écritures, périodes et rapports, puis d'enregistrer un encaissement client dans un formulaire intégré au détail de facture. La seule commande exposée au navigateur est `customer_payment`. Ce lot ne livre pas un ERP US complet : création et émission de factures, nouveaux avoirs, mutations commerciales/comptables et clôture de périodes ne deviennent pas des actions navigateur.

Le projecteur serveur valide le livre et produit des objets explicitement autorisés. Les factures distinguent exactement `total = reçu + crédité + restant`, avec des chaînes de minor units USD. Les pages de 25 éléments sont liées à leur révision ; une révision différente impose `409 financial_snapshot_changed`. Le head ne transporte que consommateur, version DTO, organisation et révision. Il lit le curseur financier admis, sans reconstruire le livre ni retourner les soldes à chaque actualisation.

Les rapports réutilisent `accounting/reports.ts` sur le vrai ledger : balance des comptes, résultat, bilan avec résultat non clôturé, trésorerie et grand livre par compte. Leurs dates et leur révision sont explicites. Les créances sont présentées comme la situation courante, sans les faire passer pour une reconstruction historique à la date du bilan. Une classification de trésorerie manquante produit un état indisponible explicite.

Le pilote reste **privé, local et TEST**, désactivé par défaut et soumis à un opt-in PostgreSQL administré. L'interface indique qu'aucun argent n'est transféré. Aucun déploiement, migration hébergée, publication, activation native, appel fournisseur réel ou changement de prix/donnée CH n'est annoncé.

## 2. Fichiers créés

Le manifeste d'implémentation inventorie **31 fichiers**, dont les **29 créations** suivantes. Les fichiers de travail et preuves de recette ignorés sous `.qa/` ne font pas partie de ces 31 sources.

- `.impeccable/surfaces/financial-pilot.md`
- `app/api/international/workspaces/[organizationId]/financial-pilot/head/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/invoices/[invoiceId]/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/invoices/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/lists/[kind]/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/operations/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/reports/route.ts`
- `app/api/international/workspaces/[organizationId]/financial-pilot/snapshot/route.ts`
- `components/account/us-financial-pilot.css`
- `components/account/us-financial-pilot.tsx`
- `lib/international/browser-us-financial-pilot-copy.ts`
- `lib/international/browser-us-financial-pilot-session.test.ts`
- `lib/international/browser-us-financial-pilot-session.ts`
- `lib/international/us-financial-pilot-bindings.test.ts`
- `lib/international/us-financial-pilot-bindings.ts`
- `lib/international/us-financial-pilot-contract.test.ts`
- `lib/international/us-financial-pilot-contract.ts`
- `lib/international/us-financial-pilot-payment.test.ts`
- `lib/international/us-financial-pilot-payment.ts`
- `lib/international/us-financial-pilot-projection.test.ts`
- `lib/international/us-financial-pilot-projection.ts`
- `lib/international/us-financial-pilot-reports.test.ts`
- `lib/international/us-financial-pilot-reports.ts`
- `lib/international/us-financial-pilot-server.test.ts`
- `lib/international/us-financial-pilot-server.ts`
- `lib/international/us-financial-pilot-store.postgres.test.ts`
- `lib/international/us-financial-pilot-store.test.ts`
- `lib/international/us-financial-pilot-store.ts`
- `supabase/migrations/20261010104148_international_us_financial_pilot_dto1.sql`

Les sept routes restent un protocole séparé ; DTO1 ne signifie pas ERP schema 5 public. Le contrat, les projecteurs et leurs validateurs n'envoient pas au navigateur la baseline, la policy, les grants, les événements/commits, les preuves fiscales ou les empreintes du livre. Les routes limitent les paramètres acceptés et la taille des entrées, utilisent des réponses non mises en cache et ne renvoient que des erreurs publiques bornées.

## 3. Fichiers modifiés

- `app/compte/espaces/us/[organizationId]/page.tsx` sélectionne explicitement le pilote admis, l'ancien parcours pour une entreprise non promue ou un écran fermé lorsqu'une entreprise promue n'est pas admise. Une absence de grant, de schéma ou d'autorité ne doit pas réouvrir une baseline ERP4 gelée.
- `lib/account-workspace-pages.test.ts` couvre cette sélection et les garde-fous de la page, avec maintien des parcours existants.

Les moteurs financiers et rapports existants sont réutilisés. Les sources natives, schémas publics ERP1–4, prix, abonnements CH et anciennes migrations ne sont pas élargis par ce lot. `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json` et les styles globaux sont conservés. La documentation de direction propre au pilote se trouve dans sa surface brief.

## 4. Migration proposée et retour arrière

La migration additive `20261010104148_international_us_financial_pilot_dto1.sql` ajoute la table privée d'opt-in versionné et les RPC de scope, head, lecture, reçu et append. Elle ne crée aucun grant ou opt-in actif, ne promeut aucune entreprise et ne modifie pas l'historique financier. La recette locale l'applique après les **31 migrations antérieures** explicitement inventoriées dans le test PostgreSQL ; aucune application hébergée n'a été exécutée.

L'opt-in appartient à l'administrateur propriétaire de la table. Les mutations administratives doivent avancer sa version exactement d'une unité. Le rôle service dispose des droits nécessaires aux lectures/verrous, mais le trigger refuse son administration directe de l'opt-in ; anon et authenticated n'obtiennent pas de droit privé. Les fonctions sont `security invoker` avec `search_path` vide. Les wrappers vérifient et verrouillent le grant TEST vivant, la policy, la configuration et l'opt-in/version dans la même transaction que la lecture, le reçu ou l'append. Le head utilise ce même contrôle.

L'admission HTTP authentifie le navigateur Zentra, exige le membership et l'abonnement US effectifs dans D1, vérifie le rôle owner/admin/accountant et recontrôle l'identité attendue. Les versions privées proviennent du serveur et de PostgreSQL, jamais du navigateur. Auth/D1 sont des contrôles pré/post distincts ; ce lot ne revendique pas de transaction atomique Auth/D1/PostgreSQL. Tout header `Authorization` natif est refusé sur ce protocole navigateur.

L'activation exige les flags internationaux/core/ERP, le marqueur V5 installé, le flag pilote et l'environnement `TEST`, ainsi que la configuration US/USD/accrual, la promotion, le grant et l'opt-in admis. Aucun provisioning automatique n'est ajouté. Le marqueur d'installation doit rester actif après promotion pour conserver la découverte du statut promu.

Retour arrière prévu : fermer le flag pilote/core/ERP approprié, désactiver l'opt-in avec avancement de version et révoquer les grants pilotes selon leur mécanisme privé. Conserver le marqueur V5 installé, les lecteurs compatibles, événements, reçus, curseurs et historique. Ne pas supprimer les données ou migrations, ne pas réinitialiser le livre et ne pas simuler un retour ERP4 pour une entreprise promue. Une correction ultérieure reste additive.

## 5. Tests réellement exécutés

Résultats observés et inclus dans la preuve finale :

| Exécution existante | Résultat observé | Portée et preuve |
| --- | --- | --- |
| Store RPC synthétique | 32/32, zéro échec | `.qa/us-financial-pilot/unit-final.json` ; admission, versions, head borné, réponses falsifiées/refus, wrappers et statut promu. |
| Verticale SQL/HTTP locale | 17/17, zéro échec | `.qa/us-financial-pilot/postgres-final.json` et `.qa/us-financial-pilot/frozen-proof.json` ; 31 migrations antérieures puis migration pilote, moteur financier réel dans PGlite, transactions, contrôles privés, reprise et fermeture/réouverture propre. |
| Bindings et page workspace | 180/180 dans deux fichiers, zéro échec | `.qa/us-financial-pilot/bindings-pages-readonly-auth-final.json` ; la recette ciblée précédente `bindings-pages-final.json` est également conservée, sans additionner ces deux exécutions. |
| Saisie d'encaissement | 26/26, zéro échec | `.qa/us-financial-pilot/payment-unit-initial.json` ; exécution ciblée antérieure, complétée par la régression finale sur les sources corrigées. |
| TypeScript global non incrémental | Code de sortie 0 | `types-final.log` et `quality-commands.json` ; la chaîne qualité a été réexécutée après correction. |
| Lint typé des sources inventoriées | Code de sortie 0 | `lint-final.log` et `quality-commands.json` ; succès après correction décrite ci-dessous. |
| Marque et build de production | Codes de sortie 0 et 0 | `brand-final.log`, `build-final.log` et `quality-commands.json` ; quatre commandes qualité effectivement terminées avec succès. |
| Première régression complète | 5 434/5 434, zéro échec/skip, 161 fichiers | Exécution terminée avant la correction du lint, avec les 152 fichiers antérieurs conservés ; résultat historique distinct de la relance finale. |
| Régression complète finale sur les sources corrigées | **5 434/5 434, zéro échec, skip ou todo, 161 fichiers** | `.qa/us-financial-pilot/regression-final.json`, `regression-final.log`, `regression-command.json` et `selection-final.json` ; les 152 fichiers antérieurs sont conservés. |

La première chaîne qualité s'était arrêtée au lint sur `eslint(no-control-regex)` dans `lib/international/us-financial-pilot-payment.ts:35:85`. Le motif explicite C0/C1 a été remplacé par la classe Unicode `\p{Cc}`, puis TypeScript, lint typé, marque et build ont été exécutés de nouveau : quatre codes de sortie 0. La régression complète a ensuite également passé sur cette source corrigée. Les succès de la première régression ne sont pas attribués rétroactivement aux nouveaux octets.

Les 17 recettes SQL comprennent les handlers HTTP réels sur un seul livre PostgreSQL local et deux clients HTTP indépendants. Un scénario utilise un vrai socket HTTP local avec deux sessions/cookies sous Auth/D1 synthétiques ; la réponse perdue après commit est reprise sans double paiement. Le répertoire de données conservé est indiqué dans `frozen-proof.json`. PGlite demeure un moteur sérialisé : ces deux clients ne constituent pas une preuve de deux connexions PostgreSQL concurrentes ou de deux navigateurs visuels reliés à PostgreSQL. La persistance testée est un close/reopen propre, sans simulation de crash ni SLA.

La revue visuelle indépendante `.qa/us-financial-pilot/design-finish-review.md` conclut **ship**, uniquement pour le composant du pilote privé TEST. Elle a inspecté les **20 captures requises** : registre desktop 1280px et paiement mobile 390px en FR/DE/IT/EN, clair/sombre, puis rapports, grand livre desktop/mobile et paiement allemand à 320px. `matrix.json` décrit les 16 captures de base ; les quatre complémentaires sont appuyées par leurs PNG et DOM adjacents. Le seul détecteur TSX déjà exécuté retourne `[]` ; il n'a pas été relancé pour la documentation.

Le navigateur de recette rend le composant réel avec le kernel financier mémoire et une autorité synthétique. `browser-flow-proof.json` et les DOM montrent le maintien du brouillon après changement de révision, le verrou de revue du solde, la reprise du même encaissement incertain avec une seule écriture correspondante, l'effacement des données en cas de refus et l'invalidation des rapports après changement de dates. Ces observations restent distinctes de la recette socket/SQL et ne prouvent pas une Auth hébergée. La revue ne couvre pas visuellement tous les états d'erreur, accès, pagination ou le shell complet du compte.

La collecte a détecté que les captures CUA avaient des octets JPEG malgré leur extension `.png`. Les **21 originaux JPEG**, comprenant les 20 captures requises et la capture complémentaire de refus d'accès, ont été archivés dans `.qa/us-financial-pilot/capture-originals/`. Une conversion de codec avec Pillow les a enregistrés au format PNG réel, sans recadrage, redimensionnement, recoloration ou changement d'un seul pixel RGB décodé. `.qa/us-financial-pilot/capture-format-proof.json` conserve les hashes de fichiers et les hashes RGB avant/après, identiques pour les 21 images. La revue portait sur les images d'origine ; les pixels sont les mêmes. Cette normalisation n'est ni une nouvelle capture, ni un nouveau parcours ou une nouvelle revue visuelle.

Les résultats finaux correspondent aux sources corrigées et au commit d'implémentation `c7fd6ed`. Le recorder a effectivement terminé avec sortie 0 après vérification des sources, des quatre contrôles qualité, des 161 fichiers de tests, des 17 scénarios PostgreSQL et des artefacts visuels. La preuve conserve la tentative précédente et son échec lint, sans les additionner aux 5 434 tests finaux. Elle consigne aussi la normalisation des captures et les empreintes des 107 artefacts de travail.

## 6. Risques

La régression finale et les quatre contrôles qualité ont passé localement sur les sources de cette livraison. Leur réussite demeure limitée au périmètre testé ; les recettes ciblées et le verdict visuel ne constituent pas une certification d'hébergement ou d'exploitation.

Les pages et rapports peuvent reconstruire le livre borné ; le head léger évite ce coût toutes les trois secondes, sans démontrer charge, latence garantie ou fonctionnement sur un grand historique. Les pages et résultats liés à une ancienne révision doivent être relus explicitement.

Le build réussit avec un avertissement non bloquant concernant des bundles supérieurs à 500 kB. Ce succès n'est pas une preuve d'optimisation des performances, de temps de chargement garanti ou de SLA.

La reprise d'une réponse incertaine conserve la même requête uniquement dans la mémoire de la session courante. Changement de compte, refus d'accès et arrêt de session la purgent. Le formulaire ne doit pas autoriser un deuxième encaissement tant que le résultat reste incertain ; un redémarrage ne vaut pas preuve de récupération automatique d'un brouillon ou d'une requête pending.

La mutation navigateur est limitée aux encaissements, mais le wrapper PostgreSQL privé réutilise le profil cumulatif d'émission TEST déjà gardé indépendamment. Il ne faut pas décrire la capacité SQL sous-jacente comme une allowlist uniquement `customer_payment`. Les créations de facture, avoirs, journaux et périodes utilisées dans les recettes privées ne deviennent pas pour autant des fonctions livrées dans l'interface.

L'autorité distribuée, la configuration et les sidecars restent des limites explicites. Les fixtures fiscales ne sont pas des observations fournisseur réelles ; une calculation n'est pas une Tax Transaction, une déclaration ou un reversal. Aucun effet marchand ou bancaire réel n'est déclenché. La conformité comptable/fiscale, la charge, la concurrence multiconnexion et la récupération après crash ne sont pas certifiées.

## 7. Fini dans ce lot

L'implémentation locale contient le contrat DTO1 fermé, les projections du livre courant, les listes/détails paginés à révision, les rapports du ledger, les routes et bindings d'admission, le store/RPC privé versionné, la session navigateur et l'interface de consultation avec saisie d'encaissement. La sélection de page garde le parcours des entreprises non promues et ferme l'accès aux entreprises promues non admises.

L'interface conserve l'identité verte et les préférences clair/sombre du compte. Les commandes restent explicites et les champs/action tactiles respectent le plancher 44px ; les formulaires et documents s'empilent sur mobile. FR/DE/IT/EN partagent le même composant. Les montants USD et dates de document suivent `en-US` indépendamment de la langue d'interface ; les contrôles date natifs gardent leur valeur ISO avec la présentation du navigateur. Les données saisies, références, adresses et retours à la ligne des notes sont préservés.

Le head est actualisé silencieusement toutes les trois secondes quand la page est visible et en ligne, sans empiler les refreshs ni remplacer le workspace par un panneau de chargement. Le brouillon reste en place lors de la synchronisation ; une nouvelle révision impose la revue du solde. Les rapports affichés doivent correspondre à leur révision, plage de dates et compte sélectionné. Le détail respecte le mouvement réduit et l'accès refusé efface le contenu financier.

Les recettes ciblées, la régression complète finale, les quatre contrôles qualité et la revue de finition sont terminés à leur portée. **La tranche du consommateur navigateur privé TEST est terminée localement dans `c7fd6ed`.**

## 8. Encore expérimental et restant

La livraison et sa preuve sont enregistrées localement. Le plan de la prochaine tranche est [US-FINANCIAL-PILOT-EXPORTS-PLAN-20261010.md](US-FINANCIAL-PILOT-EXPORTS-PLAN-20261010.md) : PDF de facture et PDF/CSV des rapports sur le livre V5 exact, sans réutiliser la sémantique erronée des anciens exports. Ce plan n'annonce aucun export déjà développé.

Restent hors de cette tranche : émission/création de facture et d'avoir dans le navigateur, mutations clients/fournisseurs/devis, achats, journaux et périodes, exports pilotes complets, provisioning et configuration courants, convergence des sidecars promus, effets fiscaux/marchands réels et outbox nécessaire. Les anciens exports qui assimilent réduction de créance et paiement ne doivent pas être réutilisés implicitement pour V5.

Restent à exécuter séparément : vraie admission Auth/D1 hébergée, staging et migration hébergée autorisés, recette de deux navigateurs sur HTTP/PostgreSQL avec identité réelle, tests PostgreSQL multiconnexion/charge/crash, admission et distribution natives, sandbox fournisseur réel et revue professionnelle comptable/fiscale. Le verdict du pilote privé ne vaut ni lancement public, ni approbation de production ou réglementaire. **L'objectif d'ERP US complet demeure actif.**
