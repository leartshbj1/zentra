# Zentra US — consentement, quota et analyse des factures fournisseurs

9 octobre 2026. Base : `fe742ce7f5ab90e237d04e8c6acf46df835d8d17`, branche isolée `codex/international-runtime`. Ce rapport porte sur ce jalon, pas sur l'achèvement de l'ERP international.

## 1. Modifications

Le propriétaire peut consentir au traitement de documents pour son espace US ; propriétaire et administrateur peuvent le mettre en pause. Les paramètres sont privés, versionnés et associés à l'entreprise. Les droits Gestion et Automation sont vérifiés séparément par le serveur, indépendamment des indicateurs de l'interface.

Le quota nécessite une politique serveur explicite correspondant à une offre US vérifiée. Aucun quota, montant USD ou Price ID de production n'est inventé. La clé de consommation est entreprise/environnement/type d'analyse/mois UTC ; changer de formule, abonnement ou preuve de paiement ne remet pas le compteur à zéro. Un quota réduit sous la consommation existante laisse zéro analyse disponible. Cette cadence commerciale n'est pas une période comptable.

Une réservation précède l'appel fournisseur. Un seul accusé de dispatch initial peut autoriser une seule émission HTTP, sans retry fournisseur implicite. Une réponse perdue ou un résultat ambigu ne permet pas un second appel. Une réservation non envoyée peut être reprise après expiration ; un dispatch consommé reste consommé. L'absence d'idempotence fournisseur confirmée peut donc conduire à consommer un quota sans résultat récupérable.

Le modèle retourné doit être exactement celui demandé, et l'ensemble de la requête/lecture possède une échéance. Un texte trop court est refusé avant réservation. Le résultat canonique et la proposition fournisseur sont conservés atomiquement. La proposition ne crée aucune écriture comptable : l'approbation humaine existante reste obligatoire. Une pause empêche un nouveau dispatch mais peut laisser terminer et conserver un dispatch déjà autorisé sous sa période/version capturée, avec droits frais.

L'interface FR/DE/IT/EN affiche état, quota et consentement, avec expiration informative. Les autres mutations attendent la résolution d'une opération incertaine. Après une erreur de configuration survenant après commit ERP, les panneaux frères et leurs brouillons restent montés ; une réadmission fiscale explicite recharge les faits avant nouvelle modification. La perte réelle d'identité ou d'accès purge toujours les données privées.

## 2. Fichiers créés

- Contrat/politique : `lib/international/us-automation-contract.ts`, `us-automation-policy.ts`, `us-automation-policy.test.ts`.
- Validation/persistance : `us-automation-validation.ts`, `us-automation-validation.test.ts`, `us-automation-store.ts`, `us-automation-store.test.ts`, `us-automation.postgres.test.ts`.
- Fournisseur/orchestration : `us-analysis-provider.ts`, `us-analysis-provider.test.ts`, `us-supplier-analysis.ts`, `us-supplier-analysis.test.ts`.
- HTTP/binding : `us-supplier-analysis-server.ts`, `us-supplier-analysis-server.test.ts`, `us-supplier-analysis-bindings.ts`, `app/api/international/workspaces/[organizationId]/supplier-analysis-settings/route.ts`.
- Interface/copie/transport : `components/account/us-supplier-analysis-panel.tsx`, `us-supplier-analysis-panel.css`, `lib/international/browser-us-analysis-copy.ts`, `browser-us-analysis-session.ts`, `browser-us-analysis-session.test.ts`, `browser-us-analysis.workbench.browser.test.ts`.
- Migration : `supabase/migrations/20261008210008_international_us_automation_analysis.sql`.
- Documentation : `US-AUTOMATION-ADMISSION-PLAN-20261008.md`, ce rapport et `docs/evidence/us-automation-admission-20261009.json`.

## 3. Fichiers modifiés

- `lib/international/saas-authority.ts`, `saas-authority-d1.ts`, `saas-authority.test.ts`, `saas-authority.workerd.test.ts` : nouvelle provenance privée US Gestion + Automation ; sorties existantes et catalogue CH inchangés.
- `lib/automation/provider.ts` : options facultatives de retry et modèle exact. Les valeurs par défaut CH sont conservées et testées.
- `lib/international/us-supplier-bindings.ts`, `us-supplier-server.ts`, `us-supplier-extraction.ts` : raccordement dormant, port durable, rejet explicite de source trop courte, projections publiques bornées et distinction quota/session.
- `lib/international/browser-us-supplier-session.ts`, `browser-us-supplier-copy.ts` : refus d'analyse explicites sans effacer une approbation financière incertaine ni confondre quota et perte de Gestion.
- `components/account/us-erp-workbench.tsx` : intégration des paramètres, verrous réciproques des six canaux, conservation de brouillons après commit ambigu.
- `lib/international/workspace-creation.integration.test.ts` : ajout exact de la nouvelle migration à la chaîne, sans réécrire l'historique.

## 4. Migration et retour arrière

Migration additive générée localement par Supabase CLI 2.120.0 et testée avec la chaîne complète. Paramètres, reçus, jobs et audit privés ; RLS activée, RPC INVOKER à search_path vide, aucun accès anon/authenticated. Les contraintes corrèlent source, état, génération, période, consommation, résultat canonique et audit immuable. Les clés de reprise conservent le corps exact, y compris les champs d'une pause.

**Aucune migration hébergée exécutée.** Le rollback prévu désactive `INTERNATIONAL_US_SUPPLIER_ANALYSIS_ENABLED` ; les propositions et preuves privées sont conservées. Le module de revue fournisseur possède son flag distinct. Pas de suppression de données comptables, comptes ou historique. Les paramètres de budget utilisent `INTERNATIONAL_US_AUTOMATION_BUDGET_POLICY_JSON`, avec schéma documenté dans le plan et le type ; aucune valeur de production n'a été installée.

## 5. Vérifications

La preuve versionnée consolidée répertorie les commandes, résultats finaux, empreintes et limites. Les baselines rouges sont conservées séparément des résultats corrigés. Les essais de fournisseur utilisent uniquement des réponses fictives, jamais une clé ou un appel TypeSafe réel.

Résultats exécutés sur les sources finales : TypeScript global, lint syntaxique des 33 fichiers TypeScript concernés, contrôle des assets, diff et build Vinext réussis. Les régressions CH et fournisseur partagé passent : 87 tests (52 CH, 35 fournisseur). Le panneau passe 44 tests, et le vrai workbench passe son test navigateur après la dernière correction de son callback de disponibilité.

La suite internationale globale v3 contient 5 044 tests passés, deux échecs de lancement workerd et 24 tests non exécutés. Les trois suites workerd inchangées sont relancées seules : 22/22 passent, sans skip. La consolidation vérifie les mêmes identités de tests et remplace leur preuve ; elle ne cumule pas les comptes. Elle couvre 5 056 cas passés et 14 parcours navigateur opt-in non exécutés dans la commande globale, sur 129 fichiers. Le rapport global v3 reste enregistré comme échec, et aucune réussite d'un unique run complet v4 n'est revendiquée. Les deux parcours navigateur explicitement sélectionnés ont leurs propres résultats ci-dessus.

Les tests locaux PostgreSQL couvrent la chaîne de migrations, isolement, rôles, consentement, quota stable, reprise, leases, ancien worker, résultats canoniques avec exposants, limites, audit et parcours HTTP → analyse fictive → proposition → approbation humaine → une facture, un journal équilibré et un delta. La concurrence PostgreSQL est sérialisée dans une instance WASM ; ce n'est pas une preuve de charge hébergée multiconnexion.

Les tests navigateur du panneau comprennent quatre langues, clair/sombre, ordinateur et mobile 320 px avec texte 200 % ; 16 variantes ont été capturées sans débordement. Le vrai workbench vérifie six reprises identiques, les verrous dans les deux sens, expiration, pause, brouillons et absence de boucle GET. Auth, quota, stockage et prestataire y sont fictifs ; le moteur ERP est réel.

La première suite globale a échoué avant exécution complète par saturation native de mémoire du PC. Son rapport partiel ne constitue pas une réussite. La relance utilise un seul worker. Le lint typé reste indisponible sur Windows (`tsgolint.exe UNKNOWN/-4094`) ; TypeScript et lint syntaxique ne sont pas présentés comme sa réussite.

## 6. Risques et limites

- Source texte uniquement, 16 Ko ; aucun PDF/OCR, archive d'original ou intake de messagerie US livré.
- Bornes de ce pilote : 50 sources par espace et 2 Mo cumulés ; elles doivent évoluer avec pagination, archivage privé et contrôle opérationnel avant une offre commerciale de grande capacité.
- Binding fournisseur dormant par défaut : flags, quota vérifié, consentement et clé serveur sont nécessaires. Aucun appel payant, prix USD réel ou mailbox activé.
- Auth/D1 et PostgreSQL sont des autorités distinctes. Les revalidations encadrent les attentes ; elles ne constituent pas une transaction distribuée de révocation.
- La preuve démontre des transports et invariants locaux, pas l'exactitude réelle d'extraction, la capacité 150 entreprises, un appareil physique, un client Stripe live ni une conformité réglementaire.
- Aucune détermination automatique de sales tax/use tax, déduction, paiement bancaire ou certification US GAAP. La taxe imprimée reste un coût d'achat soumis à revue.

## 7. Terminé dans ce jalon

Admission US explicite, consentement par entreprise, budget mensuel stable, réservation et dispatch durable, résultat/proposition atomiques, contrôle du fournisseur, autorisations fraîches, reprise exacte et interface intégrée. La version suisse, ses tarifs, clients, données et binaires n'ont pas été déployés ni migrés par ce jalon.

## 8. Expérimental et suite de l'objectif

L'ERP US complet reste à terminer et valider : intake Support US avec délégation/provenance/archives, propagation collaborative des propositions, limites du registre, renouvellements et changements d'offres US, prestataire fiscal, paiements clients, natives et pilote hébergé. Les examens comptables et juridiques, contrats de traitement et tests fournisseur réels précèdent l'activation réglementaire. Toute modification de production reste soumise à l'approbation explicite demandée par l'utilisateur.
