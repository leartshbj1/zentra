# Zentra US — synchronisation collaborative discrète

Jalon commencé le 9 octobre et vérifié le 10 octobre 2026. Base `5ff83ece891f2456b38b45295136694f50ddf69f`, branche isolée `codex/international-runtime`. Le plan a été écrit avant l'implémentation. Cette livraison locale ne termine pas l'objectif Zentra US et n'active aucune fonction hébergée.

## 1. Modifications

Le navigateur consomme désormais les têtes et les deltas ERP existants. Une boucle unique par workbench visible vérifie les changements à un intervalle nominal de trois secondes après la fin du cycle précédent. Elle suspend les vérifications hors ligne ou dans un onglet masqué, rattrape au retour et applique un délai croissant après une panne. Elle n'envoie jamais de commande ni de reprise financière automatiquement.

Une lecture compacte distincte couvre les états qui ne produisent pas d'événement ERP : propositions fournisseur, rapprochements bancaires, profils vendeur/fiscal, équipe et disponibilité d'analyse. Les jetons sont des indices opaques, jamais des droits. Les listes inchangées ne sont pas relues à chaque cycle. L'analyse dispose d'un renouvellement discret à expiration même quand son jeton durable reste stable.

Les lectures de fond ne déclenchent pas le chargement global. Les formulaires, les instances de transport et les reprises exactes restent en place pendant les erreurs transitoires. Les confirmations périmées sont invalidées ; un brouillon vendeur/fiscal conserve sa révision de base et exige une revue explicite des informations enregistrées ailleurs. Une perte confirmée d'accès efface les projections et enveloppes privées, annule les transports et bloque les actions. Le retrait d'Automation ferme les deux canaux fournisseur ; un changement de rôle ou de capacité ne laisse pas une interface périmée continuer à écrire.

## 2. Fichiers créés

- `lib/international/browser-us-background-sync.ts` et son test : ordonnanceur single-flight, visibilité/réseau, délais et arrêt.
- `lib/international/browser-us-workspace-sync-session.ts` et son test : GET compact borné, identité attendue, schéma, erreurs publiques et annulation.
- `lib/international/browser-erp-sync.test.ts` : propagation ERP réelle, pagination, reset, courses et reprises.
- `lib/international/us-workspace-sync-heads.ts`, `-server.ts`, `-store.ts`, `-bindings.ts`, `us-workspace-sync-heads.test.ts`, `us-workspace-sync-heads-bindings.test.ts`, `us-workspace-sync-heads.postgres.test.ts` : contrat, admission, stockage compact et contrôles.
- `app/api/international/workspaces/[organizationId]/sync-heads/route.ts` : nouvelle route US privée en lecture seule.
- `components/account/us-background-channel.ts` : lecteurs de fond stables et message de revue dans quatre langues.
- `lib/international/browser-us-background-workbench.browser.test.ts` : deux workbenches réels, commandes/deltas ERP et états périphériques fictifs.
- `supabase/migrations/20261009215104_international_us_workspace_sync_heads.sql`.
- Plan, livraison et relevé machine de ce jalon.

## 3. Fichiers modifiés

- `lib/international/browser-erp-session.ts` : synchronisation bornée et application privée avant validation finale, sans modifier les commandes CH.
- `components/account/us-erp-workbench.tsx` : coordination, préservation des formulaires, perte d'accès et propagation à l'équipe.
- `components/account/us-erp-bank.tsx`, `us-supplier-proposals.tsx`, `us-supplier-analysis-panel.tsx`, `us-team-panel.tsx`, `us-seller-profile-panel.tsx`, `us-tax-profile-panel.tsx` : lectures discrètes, confirmations et brouillons.
- `app/compte/espaces/us/[organizationId]/page.tsx` : passage explicite de la gate, fermée par défaut.
- `docs/internationalization/STATUS-20261009.md` : état réel et suites.

La liste exacte et les empreintes des sources figurent dans le relevé machine. Le site public publié, les anciennes migrations, les abonnements CHF et la copie native ne sont pas modifiés.

## 4. Migration et retour arrière

La migration additive crée une petite table de têtes, des triggers et un RPC groupé. Le seed ne modifie pas les sources ni les historiques. Les écritures suivantes avancent les têtes dans la transaction d'origine. Les scopes d'analyse séparent environnement et mois ; un changement PRODUCTION ne modifie pas le quota TEST du même espace. Le RPC utilise un snapshot PostgreSQL et des recherches indexées sans charger les listes métier. Les profils privés restent réservés au propriétaire.

RLS reste active. Tables et fonctions sont refusées à `public`, `anon` et `authenticated` ; seuls les chemins `service_role` admis peuvent lire les têtes privées. Les fonctions restent `SECURITY INVOKER`, sans contournement global. Les têtes D1 d'équipe comprennent les places et invitations encore valides, sans envoyer leurs liens ou coordonnées. L'admission Supabase/D1 est revérifiée avant la réponse, y compris après une attente ou une erreur ; aucune transaction distribuée n'est revendiquée.

Retour arrière logique : fermer `INTERNATIONAL_US_BACKGROUND_SYNC_ENABLED`, revenir au code de base et conserver les nouvelles tables, les données et les reçus. Les gates Core/ERP US restent également nécessaires. Une migration hébergée requiert staging, vérification des données/index et approbation utilisateur explicite. Aucun apply distant, changement Stripe, traitement client ou déplacement régional n'a été réalisé.

## 5. Tests réellement exécutés

Les résultats définitifs, commandes, empreintes et limites sont consignés dans `docs/evidence/us-background-sync-20261010.json`. Les tentatives intermédiaires restent distinctes dans `.qa/us-sync/` lorsqu'elles ont été conservées. Une première tentative navigateur a été remplacée avant sa conservation ; elle n'est pas reconstituée artificiellement. Deux exécutions devenues obsolètes ont été interrompues avant la validation du dernier bundle ; elles ne sont pas comptées comme réussies.

| Contrôle final | Résultat | Portée |
| --- | --- | --- |
| Ordonnanceur et transport compact | 32/32 | Single-flight, réseau/visibilité, backoff, identité, corps bornés, erreurs et annulation |
| ERP navigateur et deltas | 87/87 | Émission/encaissement, pagination, reset, régressions, réponses tardives et opération incertaine |
| Contrat/HTTP/bindings/tête D1 | 37/37 | Admission fraîche, rôles, perte d'Automation, priorité des erreurs, jetons compacts et isolation |
| Compatibilité partagée CH | 87/87 | Auth web, Checkout/contrat/webhook Stripe et fournisseur, avec dépendances TEST |
| PostgreSQL local | 9/9 | Seed, triggers, scopes TEST/PRODUCTION/mois, RLS/privilèges, tenant/CH, rôles et révocation pendant lecture |
| Deux workbenches de navigateur | 1/1 | Propagation de facture/paiement, états indépendants, aucune liste relue à tête stable, brouillons, conflit transitoire, expiration, perte d'accès et aucune reprise automatique |

Les trois rapports finaux sélectionnés totalisent **253 tests distincts réussis, aucun échec et aucun cas non exécuté**. Les titres paramétrés identiques sont distingués par fichier, nom complet et ordinal d'occurrence, dans l'ordre réel des rapports. Les passages répétés ne sont pas additionnés. Ce total est celui de ces essais ciblés, pas de toute la suite du repository.

Les tests PostgreSQL utilisent réellement PGlite/WASM et la chaîne locale de migrations, pas un Supabase hébergé. Le test navigateur monte deux vrais workbenches et passe les commandes et deltas dans les handlers ERP ; Auth, preuve fiscale, têtes et stockage des états périphériques sont fictifs en RAM. Les huit captures couvrent FR/DE/IT/EN, clair/sombre, à 390 px. Ce sont des émulations de navigateur, pas des essais physiques iOS/Android.

Les huit captures ont été régénérées pendant l'essai navigateur final, après les derniers correctifs fonctionnels de purge et de reprise. Leurs dates sont comprises entre le début et la fin de ce rapport. L'inspection visuelle FR clair, DE sombre et EN clair portait sur le passage précédent avec la même mise en page ; aucun style n'a changé ensuite. Les quatre langues et deux thèmes sont contrôlés automatiquement contre le débordement à 390 px. Cela ne constitue pas une revue visuelle exhaustive de chaque écran.

TypeScript global, lint syntaxique des 24 fichiers TS/TSX du jalon, vérification de marque et build de production Vinext passent. Le build a utilisé un heap Node de 1 024 Mo et signale des temps de plugins, sans échec. Les 25 sources TS/TSX/SQL sont restées identiques après les contrôles. `git diff --check` passe avec la normalisation Git configurée dans ce repository Windows. Une première commande du harnais avait forcé `core.autocrlf=false` et signalé les fins CRLF comme espaces superflus ; cette tentative est conservée séparément, puis le contrôle a été relancé avec la configuration correcte, sans modification des sources ni relance inutile du build.

La suite internationale globale de l'ancien jalon reste une preuve séparée en échec (`workerd spawn UNKNOWN` sous Windows). Elle n'a pas été relancée intégralement ici et les nouveaux essais ciblés ne la transforment pas en réussite globale. De même, un lint syntaxique n'est pas un lint global avec types. La recette QR/TVA native, les paiements live et la charge de 150 entreprises ne sont pas prouvés par ce jalon.

## 6. Risques identifiés

- Intervalle nominal, pas garantie de propagation en trois secondes sous toute charge. Une application iPhone fermée ne continue pas cette boucle.
- L'endpoint compact évite les listes complètes mais conserve les vérifications d'identité/droits. Le rate limiter partagé effectue encore cleanup, écriture et lecture ; une mesure de charge et une optimisation isolée restent nécessaires avant activation commerciale.
- Les effets bancaires/fournisseur liés à la révision ERP et le coordinateur peuvent demander une deuxième relecture suivant l'ordonnancement React ; les gardes coalescent les opérations en cours, sans preuve générale d'une seule requête dans tous les cas.
- Le réglage Équipe autonome hors du workbench conserve son lecteur manuel ; ce jalon coordonne la vue Équipe intégrée au workbench.
- Le premier passage compact peut relire une fois les états déjà chargés au montage afin de fixer leur tête admise. Il n'y a ensuite pas de relecture complète à tête inchangée, hors renouvellement à expiration.
- Les reprises exactes sont en RAM : perte d'accès confirmée ou rechargement les efface. Aucun nouveau POST n'est déduit d'une réponse perdue.

## 7. Terminé dans ce jalon

Transport ERP incrémental, têtes compactes privées, synchronisation de fond sans chargement global, protection des brouillons et confirmations, renouvellement des vérifications temporaires, reprise visibilité/réseau, refus des réponses tardives et arrêt après perte d'accès. L'interface conserve les quatre langues et les thèmes. L'isolation CH/US et les privilèges des nouvelles têtes sont testés localement.

## 8. Expérimental et suite

La gate reste fermée par défaut et aucune publication native ou hébergée n'est annoncée. Restent : staging à deux identités/appareils réels, migrations approuvées, charge/latence et suivi opérationnel, fournisseur fiscal TEST fiable puis raccord du binding actuellement null, parcours commercial USD et renouvellement, messagerie/originaux Support US, commandes/avoirs/récurrence/acompte et revue professionnelle des rapports. L'émission fiscale de la page conserve `invoiceIssuanceAvailable={false}`. Aucun taux US, Price ID live ou certification n'a été inventé.
