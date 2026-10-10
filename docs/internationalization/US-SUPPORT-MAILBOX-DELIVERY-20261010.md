# Livraison US Support — H2a, 10 octobre 2026

## 1. Résumé

H2a raccorde une boîte Infomaniak à chaque registre Support US H1, avec connexion, remplacement, déconnexion et lecture explicite des métadonnées de messages. Les propriétaires et administrateurs gèrent la connexion et lisent les messages ; les autres membres voient seulement les métadonnées de connexion.

L'entreprise doit être prête, membre courant et admise à Gestion **et** Support sur la même facture et période SaaS courantes. La gate `INTERNATIONAL_US_SUPPORT_MAILBOX_ENABLED` reste fermée par défaut, avec les gates H1, Core et ERP. Aucune gate n'a été activée et aucune migration hébergée appliquée.

Implémentation enregistrée localement dans `b6dc6da4a373b4cf2d071378c546c0eda7497945`, à partir de `feb318f`, sans push. Le périmètre ne comprend aucun import, classement, worker, accusé de lecture, envoi ou écriture financière.

## 2. Fichiers créés

| Fichiers | Rôle |
| --- | --- |
| `lib/international/us-support-mailbox-contract.ts` | Commandes et DTO fermés, empreinte matérielle, projection publique et contexte de chiffrement. |
| `lib/international/us-support-mailbox-d1.ts` | Révision attendue, reçus, reprise exacte, stockage chiffré et purge. |
| `lib/international/us-support-mailbox-server.ts` | Handlers HTTP, autorité fraîche, erreurs publiques et reprise avant nouvel effet. |
| `lib/international/us-support-mailbox-bindings.ts` | Gates, registre H1 réel, D1, clé serveur et limites par entreprise/utilisateur. |
| `lib/international/us-support-mailbox-provider.ts` | Transport Infomaniak partagé, origine fixe et lectures bornées. |
| `lib/international/us-support-mailbox-messages.ts` | Validation des métadonnées et de la pagination. |
| `lib/international/browser-us-support-mailbox-session.ts` | Session de navigateur, commande exacte en mémoire et refus des réponses périmées. |
| `components/account/us-support-mailbox-panel.tsx` | Panneau FR/DE/IT/EN, thèmes clair/sombre et confirmation de déconnexion. |
| `app/api/international/workspaces/[organizationId]/support-mailbox/route.ts` | GET des métadonnées de connexion et POST de gestion. |
| `app/api/international/workspaces/[organizationId]/support-mailbox/messages/route.ts` | GET explicite des métadonnées de messages. |
| `lib/international/us-support-mailbox-{contract,d1,bindings,provider,server,ui}.test.ts` | Six fichiers de tests ciblés. |
| `drizzle/0094_international_us_support_mailbox.sql` | Migration additive proposée. |
| `docs/internationalization/US-SUPPORT-MAILBOX-PLAN-20261010.md` et ce document | Plan et livraison. |
| `docs/evidence/us-support-mailbox-20261010/` | Cinq captures et résultats JSON de disposition/interactions. |
| `docs/evidence/us-support-mailbox-20261010.json` | Manifeste des commandes, résultats, empreintes et limites. |

## 3. Fichiers modifiés

| Fichier | Modification |
| --- | --- |
| `app/compte/espaces/us/[organizationId]/page.tsx` | Calcul de disponibilité H2a et transmission au panneau US. |
| `components/account/us-erp-workbench.tsx` | Intégration du panneau dans l'espace US et invalidation de ses données privées. |
| `components/account/us-support-workspace-panel.tsx` | Affichage H2a lorsque disponible ; maintien de la limitation H1 sinon. |
| `docs/internationalization/STATUS-20261009.md` | État H2a et prochaines verticales H2b/H3. |

Les anciennes migrations, le registre et le store H1, les tables et services Support CH/legacy restent inchangés. Aucun workspace Support legacy, faux propriétaire ou droit CH n'est créé pour une entreprise US.

## 4. Migrations proposées

`0094_international_us_support_mailbox.sql` a été générée localement avec Wrangler 4.92.0, après lecture de l'aide `d1 migrations create`. Elle ajoute une vue d'admission H1 et cinq tables US : tête de révision, reçus, descripteurs de connexion, secrets séparés et marqueurs de transaction.

Les reçus, descripteurs et marqueurs sont immuables. La tête avance par comparaison de révision ; un marqueur final et des clés étrangères différées empêchent de valider un reçu isolé. Déconnexion et remplacement mettent l'ancien chiffré à `NULL` dans la même transaction. Une reprise exacte conserve le premier identifiant et le premier reçu, puis retourne l'état courant sans ressusciter une connexion remplacée.

La migration a été exécutée uniquement en RAM dans la chaîne SQLite réelle 0000–0094. Aucun `apply`, changement D1/Supabase hébergé, changement PostgreSQL ou backfill CH n'a été effectué. Migration absente : indisponibilité explicite, sans recours aux tables legacy. Le rollback prévu ferme la gate et revient au code précédent en conservant les données et tables.

## 5. Tests et résultats

| Vérification | Résultat | Preuve locale |
| --- | --- | --- |
| Phase H2a, six fichiers | **192/192** | `.qa/us-support-mailbox/phase-final.json` |
| Dont contrat et chaîne D1 réelle | **65/65**, dont 43 cas D1 | `.qa/us-support-mailbox/d1-first.json` |
| Dont transport/panneau UI | **64/64** | `.qa/us-support-mailbox/ui-final.json` |
| Régression sélectionnée, 90 fichiers | **2 911/2 911** | `.qa/us-support-mailbox/regression-final.json` et `selection-final.json` |
| Suivi server/bindings après corrections de typage | **39/39** | `.qa/us-support-mailbox/typed-followup.json` |
| TypeScript global, lint typé ciblé, contrôle de marque | Réussis, codes de sortie 0 | `typecheck-final-clean.log`, `lint-final-clean.log`, `brand-final.log` dans le même dossier QA |
| Compilation production | Réussie, code de sortie 0, « Build complete » | `.qa/us-support-mailbox/build-final.log` |

Tous les rapports de tests finaux ci-dessus ont zéro échec, test ignoré, todo ou suite échouée. Les sélections se recouvrent : leurs compteurs ne s'additionnent pas. Les rapports initiaux de diagnostic sont conservés séparément.

SQLite vérifie notamment deux entreprises du même propriétaire, les rôles Team réels, les sessions natives v1–v4, renouvellement/révocation, conflits de révision et de matériel, purge, rollback après purge, perte d'accusé et reprise historique. Les tests HTTP/fournisseur utilisent des réponses simulées ; aucun identifiant ou compte fournisseur réel n'est utilisé.

La revue indépendante a signalé un P2 de reprise navigateur : un rejet fournisseur 422 lors d'un retry ne prouvait pas l'absence d'effet de la tentative antérieure expirée. La commande incertaine reste désormais conservée pour reprise exacte. Aucun P1/P2 backend confirmé ne reste ouvert dans cette revue.

La vérification visuelle sur fixture couvre **24 cas** : quatre langues, deux thèmes et trois largeurs (320/390/1440), sans débordement relevé. Les interactions démontrent deux POST mais un seul commit après perte d'accusé, aucune lecture mail avant clic, purge après rafraîchissement refusé en 403, déconnexion confirmée sans lecture mail et vue membre sans commandes de gestion. Preuves : `layout-results.json`, `interaction-results.json` et captures dans le dossier d'évidence.

## 6. Risques et limites

- La pagination porte sur **20 threads**, avec au plus **100 références de messages** par page. Les références sont lues séquentiellement ; doublons, données invalides et pages excessives sont refusés. L'offset est limité à 0–200, par pas de 20. Chaque opération fournisseur dispose d'un signal d'annulation global de **12 secondes** ; une page lente peut être indisponible.
- La borne inférieure de recherche est fixée à **30 jours avant la vérification de connexion**. Elle ne constitue pas une fenêtre glissante recalculée à chaque lecture. La version observée est une date fournisseur, pas une preuve d'intégrité du contenu.
- Le lecteur partagé recopie l'UID demandé dans son résultat. Comparer les deux UID n'est donc pas une corroboration indépendante de provenance ; H2b devra établir cette preuve avant l'import.
- Seuls UID, version, sujet, expéditeur, date et métadonnées des pièces compatibles sont retournés. Aucun corps/HTML, URL arbitraire, téléchargement ou import n'est activé.
- Auth, catalogue et vérification fournisseur restent des frontières serveur. SQL corrobore les faits H1, l'autorité courante, la session native et la révision. Pour une nouvelle connexion, la fraîcheur de `verifiedAt` est contrôlée à l'INSERT dans la limite de 30 secondes ; le marqueur final contrôle la fraîcheur de `createdAt`. Une reprise durable n'exige pas que l'ancienne vérification soit encore récente.
- La clé API n'est persistée qu'en AES-GCM avec `SUPPORT_ENCRYPTION_KEY`, et l'AAD distinct `us-support-mailbox:${org}:${workspaceId}:${connectionId}:${revision}`. Les projections et reçus publics excluent chiffré, digest de clé et identifiants fournisseur. Les diagnostics contiennent seulement opération/code/statut. Déconnexion/remplacement purgent le chiffré ; fermeture de gate ou révocation d'accès en bloque l'usage tout en conservant les données. Une rotation de clé peut imposer une reconnexion.
- Les erreurs publiques sont fermées : 401 identité/session, 402 abonnement, 403 droits, 404 gate, 409 conflit/prérequis, 422 entrée ou clé refusée, 429 limitation, 503 indisponibilité. Une réponse ambiguë ou perdue ne vaut pas preuve d'absence de commit.
- SQLite local et le navigateur sur fixture ne prouvent pas le comportement D1 distribué, l'authentification en staging, une boîte Infomaniak réelle ou la distribution native. Ces validations n'ont pas été réalisées.

## 7. Terminé

Le raccordement local H2a, ses API, sa persistance révocable, sa reprise exacte et son panneau traduit sont implémentés et vérifiés dans le périmètre décrit. Les contrôles locaux de qualité et la compilation production passent. Aucun déploiement, publication, push, activation de gate ou mutation hébergée n'a été effectué.

## 8. Expérimental

H2a reste expérimental et fermé par défaut. La prochaine verticale d'intake devra établir la provenance durable d'une pièce et composer les vérifications H2 avec l'upload/archive du coffre fournisseur US. Import financier, classement, délégation par boîte, quotas de classification et workers restent hors de cette livraison. Toute validation réelle en staging ou activation fera l'objet d'une séquence distincte ; cette livraison ne les déclare pas acquises.
