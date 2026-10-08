# Zentra US — rapprochement bancaire du pilote

8 octobre 2026. Base web `ce64382ff53600ed13a3d497e05f33f13703787a`. Le site public reste séparé, version355, source `b6e080ba6ad75c825c383ab5ae7282201e7f8a7f`. Aucun déploiement US, migration hébergée, changement de tarif ou donnée client effectué.

## Comportement livré

Un utilisateur US autorisé importe un relevé CSV USD, vérifie ses dates et soldes, sélectionne les mouvements bancaires et les écritures correspondantes, puis approuve leur association. La clôture exige toutes les lignes et mouvements comptabilisés rapprochés ainsi que des soldes exacts. Aucun mouvement, ajustement ou paiement bancaire n'est créé par cet écran.

Les données financières restent dans le livre ERP schema4 existant. Le relevé et ses validations occupent un stockage privé distinct, sans schema5, promotion automatique ou modification du format suisse. Les méthodes cash et accrual conservent leur livre propre ; le rapprochement suit la date de paiement/transaction, distincte de la date comptable. Montants en chaînes d'entiers USD, calculs BigInt/NUMERIC, aucune conversion flottante. CSV explicite `date,amount,reference`, date ISO et montant décimal `100.00` ou `-100.00`, au plus1.000 lignes. Les formats ambigus sont refusés.

Chaque import conserve ses lignes, auteur et horodatage. Une validation ajoute exactement une révision, un reçu, une trace et les associations de journaux. Annuler un import inutilisé exige un motif et ne supprime pas l'historique. Un relevé déjà associé ou clôturé ne peut pas être annulé ni réécrit. Une clôture conserve sa révision comptable d'origine ; après une nouvelle écriture, une note traduite prévient que l'historique validé et les chiffres actuels peuvent différer.

## Autorisation, reprise et intégrité

Le même espace, compte attendu et mode navigateur/appareil sont contrôlés par l'autorité US existante. Owner/admin/accountant, droit Gestion, configuration US/USD et capacité4 réellement capturée sont nécessaires. Les indicateurs sont relus après les attentes, y compris les erreurs et reprises. Un en-tête ou document importé ne peut pas accorder ces droits.

POST conserve une enveloppe immuable et sa clé pour reprendre une réponse perdue. Les sélections sont des ensembles copiés et triés en UTF16 avant le hash ; le CSV conserve son ordre original. SQL utilise le même ordre pour les identifiants Unicode. Le reçu original n'est rendu qu'après comparaison de sa commande canonique, même lorsque le livre a changé depuis. Une nouvelle commande impose les révisions actuelles du livre et du relevé.

L'import identique, même renommé ou annulé auparavant, est détecté sans ses identifiants artificiels. Les périodes actives du même compte ne se chevauchent pas. Un journal ne peut être utilisé dans deux rapprochements, indépendamment d'un identifiant de connexion. Cette règle globale limite encore les futurs cas de transfert entre plusieurs comptes ; le plan comptable du pilote comporte un compte cash.

Les quatre tables privées ont RLS, aucun accès anon/authenticated, et des fonctions INVOKER avec search_path vide. Les commits verrouillent configuration et tête ERP dans la transaction ; ils ne modifient pas cette tête. Les triggers de transition protègent le relevé et les anciennes associations ; les contraintes différées imposent les reçus, audit et claims corrélés ainsi que les montants et journaux source. Le rôle serveur demeure un secret privilégié ; cela ne remplace pas l'autorisation Auth/D1 effectuée par HTTP.

Une réponse incertaine bancaire verrouille les nouveaux changements ERP, vendeur et fiscalité, tandis que sa propre reprise reste accessible. Le rechargement retrouve le livre actuel sans effacer le brouillon à cause d'une révision sans rapport. Les changements de compte/espace/rôle purgent les données privées de l'écran. Les diagnostics du nouveau service contiennent seulement opération, code et statut contrôlés, pas le CSV ni ses références.

## Migration proposée et retour arrière

`supabase/migrations/20261008184605_international_us_bank_reconciliation.sql` a été générée par Supabase CLI2.120.0 `migration new`, puis implémentée et exécutée seulement dans PostgreSQL PGlite local jetable. Elle ajoute les quatre tables `zentra_us_bank_reconciliations`, `zentra_us_bank_receipts`, `zentra_us_bank_audit`, `zentra_us_bank_entry_claims`, leurs validateurs, RPC et triggers. Aucune ancienne migration n'est réécrite. Le test de création conserve une liste exacte de14 migrations internationales, désormais incluant ce fichier.

Le gate supplémentaire `INTERNATIONAL_US_BANK_RECONCILIATION_ENABLED` est absent/fermé par défaut. Il exige aussi les gates Core, ERP, Purchasing2, Projects3 et Accounting4. L'information d'interface n'est pas une autorisation et chaque RPC privé refait ses contrôles. Un futur déploiement nécessitera la validation explicite de staging/production, la migration avant le nouveau port et une observation des droits réels. Retour arrière non destructif : fermer le gate bancaire, conserver relevés/reçus/audit/claims ; ne supprimer aucune table, ligne ou écriture, ne rétrograder aucun livre.

## Validation et corrections observées

Les résultats exacts et hashes sont consolidés dans `docs/evidence/us-bank-reconciliation-20261008.json`. Les preuves locales détaillées sont sous `.qa/us-bank/`, séparées des preuves fiscales précédentes.

Suite internationale finale :4.306 tests passent,10 sont volontairement sautés,0 échec (102 fichiers réussis,9 fichiers opt-in sautés). Les deux essais bancaires navigateur sautés dans cette commande ont été exécutés séparément dans le lot ciblé23/23 ci-dessous ; les huit autres opt-in historiques n'ont pas été relancés dans ce lot. Les tests ciblés déjà inclus dans la suite ne s'additionnent pas comme de nouvelles validations indépendantes.

- Noyau/CSV et moteur historique :93 tests ciblés, dont11 historiques ; doublons, périodes, sommes exactes, Unicode, CAS, ordre des sélections, chrono et fermeture.
- HTTP :61 tests Request/Response avec autorités et persistance RAM fictives ; refus frais, taille bornée, réponses tardives, replay et délégation.
- Store :181 tests de transport simulé ; plafonds capturés, quatre RPC, own-data sans getter/coercition, reçus exacts et erreurs publiques contrôlées.
- PostgreSQL :35 tests réels locaux ; cash/accrual, HTTP vers SQL avec deux collaborateurs fictifs, isolation CH, RLS/privilèges, reprise exacte, rollback d'historiques falsifiés, associations fausses, devise null/nonUSD et capacité cumulée.
- Bindings :12 tests ; fermeture par défaut et indicateurs exacts, aucun prestataire fiscal installé.
- Navigateur/session :23 tests ciblés, dont deux vrais parcours React/HTTP avec stockage RAM fictif. Import, validation, discordance, reprise après commit, verrous ERP/vendeur/fiscalité, brouillon conservé, révocation et avertissement historique.
-16 variantes visuelles :FR/DE/IT/EN × clair/sombre × desktop1200/mobile320 avec texte200%. Aucun débordement ni erreur JavaScript observé ; police locale chargée. Capture FR sombre390 supplémentaire.

Après la suite internationale, le garde-fou de capacité cumulée a été ajouté et vérifié dans un lot final62/62 :35 PostgreSQL,6 créations avec la chaîne exacte de migrations et21 transports navigateur. Il refuse l'import avant mutation lorsque les relevés dépasseraient2.600.000 octets JSONB,49.000 nœuds ou2.000.000 octets UTF8 de clés/valeurs décodées. Cette dernière limite borne conservativement les caractères UTF16 du lecteur partagé. Profondeur20, tableaux1.000 et chaînes500.000 octets restent bornés. Les essais couvrent références courtes, longues ASCII et emoji, maintien des lectures HTTP, rollback, et frontières structurelles exactes. Les relevés/reçus/audits déjà enregistrés sont préservés et l'explication est traduite. Ces quatre cas supplémentaires ne sont pas inclus dans les4.306 tests de la suite précédente.

Les premiers échecs ont été conservés : préparation SQL qui sautait l'admission durable, ordre des sélections incompatible avec le hash SQL, protection insuffisante d'UPDATE direct, liste de migrations devenue incomplète, fixtures TypeScript et affectation de ref en rendu. La revue finale a identifié que la borne d'octets seule ne couvrait pas le compteur de nœuds du lecteur. Elle a été complétée, puis la fixture de frontière a été corrigée pour contenir exactement49.000 nœuds (la première en contenait49.001). Les corrections ont été vérifiées sans remplacer les assertions par une réussite artificielle. Le contrôle USD SQL a aussi été renforcé contre JSON null, distinct de la devise de l'en-tête.

## Périmètre encore expérimental et risques

Livré dans le pilote web US uniquement. Pas de nouveau binaire Windows/macOS/IPA/APK, pas de banque connectée, ACH, transfert, connexion Stripe ni scan bancaire. Les deux collaborateurs du test sont des autorités fictives sur une même instance PostgreSQL RAM sérialisée : aucune preuve de charge, connexions indépendantes, redémarrage, PostgREST hébergé, appareils physiques ou production. Les validations navigateur utilisent un stockage fictif, distinct des tests SQL.

La mise à jour des autres écrans bancaires se fait actuellement par lecture/rechargement et changement de tête ERP ; un flux de changements bancaires dédié reste à ajouter pour une propagation automatique sans manuel entre deux sessions. L'archive du fichier bancaire brut n'est pas stockée : seules les lignes canoniques immuables le sont. Un amendement d'un rapprochement historique déjà clôturé n'est pas implémenté ; ses validations ne sont jamais modifiées silencieusement. Les limites de100 relevés,1.000 lignes par relevé et les budgets cumulés maintiennent les lectures sous les limites du lecteur privé et HTTP2,5MiB ; leur pagination durable est à concevoir avant un grand volume réel.

Le lint syntaxique et TypeScript/build ne remplacent pas le lint typé tsgolint, toujours refusé par Windows. Les tests Rust compilés et essais natifs ne sont pas revendiqués pour ce lot.

La banque ne détermine ni taxe, nexus, conformité US GAAP ni choix de méthode fiscale. Les distinctions cash/accrual ont été rapprochées de [IRS Publication538, édition janvier2022](https://www.irs.gov/publications/p538) et le rôle des justificatifs/relevés de [IRS Recordkeeping](https://www.irs.gov/businesses/small-businesses-self-employed/recordkeeping). Ces sources ne constituent pas une validation professionnelle de Zentra. Aucun taux US, seuil ou durée de conservation universelle n'a été inventé.

Le runtime fiscal demeure `taxProvider:null`, sans issuer/evaluator raccordé. L'incident temporaire TEST Stripe de la phase antérieure et sa révocation en attente restent documentés séparément ; aucune clé ni URL de claim n'est reprise ici et aucune nouvelle opération Stripe exécutée. Les abonnements CHF, permissions suisses et données existantes sont préservés.

## Fichiers

Créés : `us-bank-contract.ts`, `us-bank-reconciliation.ts/.test.ts`, `us-bank-csv.ts/.test.ts`, `us-bank-store.ts/.test.ts`, `us-bank-server.ts/.test.ts`, `us-bank-bindings.ts/.test.ts`, `us-bank.postgres.test.ts`, `browser-bank-session.ts/.test.ts`, `browser-bank-copy.ts`, `browser-bank.browser.test.ts`, le composant/styles `components/account/us-erp-bank.tsx/.css`, la route `app/api/international/workspaces/[organizationId]/bank-reconciliations/route.ts`, la migration, le plan, ce rapport et la preuve consolidée.

Modifiés : `components/account/us-erp-accounting.tsx` (onglet), `components/account/us-erp-workbench.tsx` (verrous et fraîcheur communs), `app/compte/espaces/us/[organizationId]/page.tsx` (readiness fermé), `lib/international/workspace-creation.integration.test.ts` (liste exacte de migrations). Aucun moteur CH partagé, ancien SQL, projet natif ou source du menu public modifié.

Prochaine phase utile : intake anglais Support → proposition fournisseur US persistée → approbation humaine → facture fournisseur/journal réellement partagés. Les importeurs historiques CHF/Europe-Zurich ne doivent pas être raccordés silencieusement à US. Les traitements fiscaux, paiements US, crédits/récurrences et automatisations restent des étapes distinctes du rapprochement manuel livré.
