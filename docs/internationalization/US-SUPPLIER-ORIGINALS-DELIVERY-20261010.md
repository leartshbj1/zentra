# Originaux fournisseurs US — livraison locale

Relevé du **10 octobre 2026**, base `3965ae7a7b80d786e091de9cde1f18b922f5091c`, checkout international isolé. Référence de périmètre : [plan de la verticale](US-SUPPLIER-ORIGINALS-PLAN-20261010.md).

Commit d'implémentation vérifié : `9cbed497a674264bcb0143f81249da5196185e83`. Inventaires et preuves : [manifeste local](../evidence/us-supplier-originals-20261010.json).

Ce document décrit le code présent et les preuves locales consolidées. Le manifeste associé conserve les commandes, compteurs et empreintes des rapports. Aucun appel fournisseur réel, mutation hébergée, déploiement ou modification native n'est livré par cette phase.

## 1. Modifications fonctionnelles

Gestion US permet d'importer et de retrouver un original **PDF, PNG, JPEG ou texte UTF-8**, dans un livre US/USD v4 initialisé. L'import et la lecture exigent une identité et un rôle financier US courants (`owner`, `admin`, `accountant`) ainsi que Gestion. Ils ne consomment pas une analyse et ne donnent pas Automation. L'analyse demande séparément Automation, le consentement versionné et le budget privé existants.

La nouvelle gate `INTERNATIONAL_US_SUPPLIER_DOCUMENTS_ENABLED` reste fermée par défaut. Elle dépend aussi de Core/ERP et de la capacité comptable v4 effective, avec les étapes Purchasing v2 et Projects v3 requises par le résolveur existant. L'analyse conserve ses gates Supplier/Analysis existantes ; ouvrir l'archive ne les ouvre pas.

Les routes par entreprise sont :

| Méthode et chemin relatif à `/api/international/workspaces/{organizationId}` | Effet |
|---|---|
| `GET /supplier-documents` | Liste des métadonnées publiques autorisées. |
| `PUT /supplier-documents/{id}` | Import binaire borné, avec identité d'opération stable. |
| `GET /supplier-documents/{id}/content` | Téléchargement privé de l'original vérifié. |
| `POST /supplier-documents/{id}/analyze` | Préparation textuelle puis liaison à une proposition, après consentement explicite. |

Les octets sont conservés via le binding R2 `FILES`, dans un préfixe US séparé par entreprise, identifiant et empreinte. Le serveur écrit conditionnellement sans remplacement, relit l'objet et vérifie taille et SHA256 avant de confirmer le reçu PostgreSQL. Aucune clé d'objet ni URL publique n'entre dans les DTO. Le téléchargement utilise `no-store`, `nosniff`, une disposition `attachment` et une CSP restrictive.

L'empreinte binaire `contentSha256` est distincte de `textSha256`. Le registre d'analyse existant continue d'identifier le texte UTF-8 ; il ne reçoit pas le SHA du PDF à sa place. Une reprise exacte conserve le premier original, auteur, nom, date et extraction. Une empreinte binaire déjà connue renvoie le document canonique. Deux originaux différents produisant le même texte ne peuvent pas prendre silencieusement la même liaison vers une proposition. Une première liaison vers une proposition déjà enregistrée est refusée ; un lien créé avant enregistrement reste consultable ensuite.

Le panneau Achats propose import, liste, téléchargement, consentement d'analyse et accès à la revue existante. Les reprises incertaines gardent l'identifiant et le corps exacts en mémoire. Changer d'identité/espace ou perdre l'accès purge la session et ses buffers. La perte du seul droit Automation sur une analyse est distinguée de la perte de Gestion ; elle ne transforme pas le coffre en module Automation. L'import texte historique est masqué lorsque ce panneau d'originaux est présent.

## 2. Fichiers créés

Inventaire de livraison, **30 fichiers nouveaux**, manifeste compris, sans compter les preuves ignorées sous `.qa` :

Routes :

- `app/api/international/workspaces/[organizationId]/supplier-documents/route.ts`
- `app/api/international/workspaces/[organizationId]/supplier-documents/[id]/route.ts`
- `app/api/international/workspaces/[organizationId]/supplier-documents/[id]/content/route.ts`
- `app/api/international/workspaces/[organizationId]/supplier-documents/[id]/analyze/route.ts`

Interface et transport :

- `components/account/us-supplier-documents.tsx`
- `components/account/us-supplier-documents.css`
- `lib/international/browser-us-supplier-documents-copy.ts`
- `lib/international/browser-us-supplier-documents-session.ts`
- `lib/international/browser-us-supplier-documents-session.test.ts`

Contrat, stockage et serveur :

- `lib/international/us-supplier-document-contract.ts`
- `lib/international/us-supplier-document-contract.test.ts`
- `lib/international/us-supplier-document-store.ts`
- `lib/international/us-supplier-document-store.test.ts`
- `lib/international/us-supplier-document-archive.ts`
- `lib/international/us-supplier-document-archive.test.ts`
- `lib/international/us-supplier-document-bytes.ts`
- `lib/international/us-supplier-document-bytes.test.ts`
- `lib/international/us-supplier-document-timeout.test.ts`
- `lib/international/us-supplier-document-server.ts`
- `lib/international/us-supplier-document-server.test.ts`
- `lib/international/us-supplier-document-bindings.ts`
- `lib/international/us-supplier-document-bindings.test.ts`
- `lib/international/us-supplier-document.postgres.test.ts`

Migration, fixtures et documentation :

- `supabase/migrations/20261010005300_international_us_supplier_originals.sql`
- `tests/us-supplier-documents-preview-server.mjs`
- `tests/us-supplier-documents-preview.html`
- `tests/us-supplier-documents-preview.tsx`
- `docs/internationalization/US-SUPPLIER-ORIGINALS-PLAN-20261010.md`
- `docs/internationalization/US-SUPPLIER-ORIGINALS-DELIVERY-20261010.md`
- `docs/evidence/us-supplier-originals-20261010.json`

## 3. Fichiers existants modifiés

L'inventaire de livraison contient six fichiers existants modifiés :

| Fichier | Modification |
|---|---|
| `app/compte/espaces/us/[organizationId]/page.tsx` | Disponibilité du panneau sous gate US et Gestion ; Automation reste indépendante. |
| `components/account/us-erp-workbench.tsx` | Montage Achats, coordination busy/pending, invalidation des buffers et actualisation des propositions après préparation. |
| `components/account/us-supplier-proposals.tsx` | Option masquant l'ancien import texte lorsque l'import d'originaux est présent. |
| `lib/international/international-staging-chain.postgres.test.ts` | Borne explicite du snapshot historique des19 migrations ; la nouvelle suite vérifie séparément la chaîne complète des20 migrations. |
| `lib/international/runtime-response-guards.test.ts` | Remplacement d'un compteur Auth fragile par une preuve de gate relue après résolution de l'autorité postcommit. |
| `docs/internationalization/STATUS-20261009.md` | État de cette verticale locale et prochaines étapes non livrées. |

`runtime-server.ts` est inchangé par rapport à la base. Aucun fichier Support mail, captureur CH, droit CHF, native ou migration historique n'est modifié par cette verticale.

## 4. Migration et frontières de données

La migration additive `20261010005300_international_us_supplier_originals.sql` crée trois tables privées : descripteurs d'originaux, reçus de stockage et liens vers propositions. Les RPC fixes de liste, lecture, réservation, confirmation et liaison utilisent `SECURITY INVOKER` avec `search_path` vide. RLS est activé sans policy client ; `anon` et `authenticated` n'obtiennent ni accès aux tables ni exécution des fonctions. Le rôle serveur reçoit les droits nécessaires de lecture/insertion, sans mutation de l'historique.

Les triggers refusent `UPDATE`, `DELETE` et `TRUNCATE`. Le scope US/USD/v4 et l'ordre de verrouillage workspace → pays → ERP sont communs avec l'approbation financière. La liaison initiale verrouille une proposition encore en revue et exige son snapshot courant ainsi que le texte/empreinte du document stocké. Les contraintes imposent une liaison unique par original et par proposition.

La suite PostgreSQL ciblée charge **20 migrations internationales ordonnées**, configuration pays comprise, sur une baseline legacy locale conforme. Elle vérifie aussi la conservation de données CH fictives. Une attestation SQL ne vérifie pas R2 : le serveur reste responsable de la relecture effective des octets avant le reçu.

**Aucune migration hébergée exécutée et aucune nouvelle migration D1.** La validation locale ne vaut pas approbation d'appliquer cette chaîne à un projet existant. Fermer la gate arrête le parcours sans effacer les originaux, reçus, liens, propositions ou écritures.

Retour arrière proposé : fermer d'abord la gate dédiée, revenir au code précédent si nécessaire et conserver les tables/objets privés. Ne pas retirer les tables immuables ni nettoyer les objets comme effet secondaire. Une correction de schéma doit passer par une migration additive ultérieure ; la réconciliation et la restauration hébergées restent à vérifier avant activation.

## 5. Tests et preuves disponibles

| Vérification | Résultat acquis au relevé | Preuve |
|---|---|---|
| Régression locale hors suites PostgreSQL opt-in finales | **1 520/1 520**, 45 fichiers, aucun échec ni skip | `.qa/us-supplier-originals/regression-final-verified.json` |
| Nouvelle suite PostgreSQL originaux | **11/11**, un fichier, aucun échec ni skip | `.qa/us-supplier-originals/backend-postgres-first.json` |
| Garde HTTP ERP ciblée après réparation du test | **23/23**, aucun échec ni skip ; oxlint ciblé passé | `.qa/us-supplier-originals/runtime-response-guards-final.json` |
| Régression PostgreSQL finale agrégée | **41/41**, trois fichiers, aucun échec ni skip | `.qa/us-supplier-originals/postgres-regression-final.json` |
| TypeScript global final | **Passé**, `tsc --noEmit`, exit0 | `.qa/us-supplier-originals/quality-final.json`, `typecheck-final-verified.log` |
| Lint des28 fichiers TS/TSX créés ou modifiés | **Passé**, oxlint, exit0 | `.qa/us-supplier-originals/quality-final.json`, `lint-final-verified.log`, `lint-selection.json` |
| Assets de marque et build production | **Passés**, exit0, profil `production` conservé | `.qa/us-supplier-originals/brand-final.log`, `build-final.log`, `build-profile-final.json` |
| Inspection navigateur | **8 combinaisons langue/thème à320px sans débordement**, aperçu desktop1280px ; reprise import/analyse, refus Automation seul et révocation vérifiés | `.qa/us-supplier-originals/browser-layout.json`, `browser-behavior.json`, `desktop-light.jpg` |

Les nombres ne s'additionnent pas : les suites ciblées peuvent recouper la régression. Les échecs intermédiaires restent conservés, notamment `regression-first.json` et `runtime-response-guards-before.json`. La correction du test ERP ne change aucun comportement du runtime.

Les41 tests PostgreSQL de régression et les11 nouveaux tests PostgreSQL sont distincts :52 tests, quatre fichiers au total. Les suites applicatives suisses sélectionnées couvrent notamment TVA encaissements, Auth, contrat Stripe, Support et langues. Aucun nouveau PDF QR natif, installateur, paiement marchand ni connexion client réelle n'est testé par cette phase. Le build ne publie rien.

La couverture présente comprend : PDF réel et source inchangée, média/octet incohérents, UTF-8 invalide et limites de texte, tâches PDF suspendues et résultat tardif, absence d'OCR, original R2 manquant/corrompu/trop long, PUT et confirmation dont la réponse est perdue, reprise stable et déduplication binaire, droits Gestion distincts d'Automation, perte d'identité/rôle/droit/configuration/gate/capacité pendant attente, refus d'un tenant étranger, collision entre originaux de même texte, historique SQL immuable, grants/RLS et chaîne analyse fictive → liaison → approbation → facture/journal uniques.

Les tests PostgreSQL utilisent une base jetable PGlite et un port d'archive fictif. PGlite sérialise les transactions ; ces tests ne prouvent pas le comportement concurrent d'un PostgreSQL hébergé, ni Auth/D1/R2 distribués. Les tests d'analyse et les previews utilisent des données et réponses fictives, sans facture cliente ni appel d'inférence réel.

La recette navigateur utilise les vrais composants et transports React avec un fetch fictif en mémoire. Le choix de fichier et la reprise d'un PUT interrompu ont été exercés via l'interface. Le faux PDF de cette preview ne teste pas le parseur : le PDF réel est généré et extrait dans la suite unitaire. Pas d'essai sur appareil physique, zoom200%, service R2 réel ou navigateur natif. Le build a réussi avec son avertissement existant sur `middleware` et la classification statique partielle des routes vinext ; ces avertissements ne sont pas déclarés corrigés.

## 6. Risques et limites

- **Capacité du pilote :** 6 MiB maximum par original, 50 descripteurs et 100 MiB cumulés par entreprise, y compris les réservations conservées. Aucun mécanisme de suppression, purge ou récupération de capacité n'est ajouté.
- **Lecture du contenu :** PDF texte limité à 12 pages, délai de 8 secondes avec annulation de la tâche, texte UTF-8 entier de 16 384 octets maximum. Aucun préfixe tronqué n'est analysé. Images, PDF scannés, chiffrés, malformés ou hors limites restent non lisibles lorsqu'ils sont acceptés comme originaux. Le texte brut invalide, vide ou hors limites est refusé.
- **Autorités distribuées :** Auth/D1, PostgreSQL et R2 n'ont pas de transaction commune. Les contrôles frais entourent les attentes et les erreurs ; une réponse retenue après perte d'accès peut correspondre à une opération durable déjà confirmée. La reprise exacte sert à la retrouver.
- **Conservation :** pas de politique légale de rétention, de purge universelle, de gel juridique ni de preuve de restauration hébergée. Un objet écrit avant un échec de confirmation peut rester privé sans reçu ; aucune suppression automatique ne tente de le deviner abandonné.
- **Analyse :** les faits proposés, la confiance et le PDF ne constituent ni détermination fiscale ni approbation financière. Le budget et le dispatch durable existants ne prouvent pas la précision réelle du fournisseur. La confirmation humaine conserve la commande ERP actuelle.
- **Disponibilité collaborative :** la liste dispose d'un rechargement explicite. Aucun nouveau canal de notification des originaux entre collaborateurs n'est ajouté dans cette phase.

Les références primaires du plan restent pertinentes pour examiner les justificatifs et leur conservation : [IRS — Recordkeeping](https://www.irs.gov/businesses/small-businesses-self-employed/recordkeeping) et [IRS — Supporting documents](https://www.irs.gov/businesses/small-businesses-self-employed/what-kind-of-records-should-i-keep). Cette implémentation ne démontre pas une conformité IRS complète ni une durée de conservation unique. L'API utilisée pour le stockage conditionnel, les checksums et la lecture est documentée par [Cloudflare R2 — Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## 7. Terminé dans le checkout

Le raccord local original privé → extraction textuelle bornée → analyse US existante → proposition liée → revue humaine est implémenté. Les frontières Gestion/Automation, empreintes binaire/texte, reprise exacte, provenance et refus de liaison rétroactive sont présentes. L'interface et les copies ont été contrôlées en français, anglais, allemand et italien, clair/sombre à320px.

La revue indépendante des sources a vérifié les corrections du timeout PDF, de la reprise UI bloquée par son propre état pending et de la distinction du seul refus Automation402 sur `analyze`. Aucun défaut P1/P2 restant n'a été relevé dans les sources relues. Les validations locales de ce jalon sont consolidées dans le tableau et le manifeste ; elles ne valent pas recette hébergée ou commerciale.

## 8. Expérimental et non livré

Cette verticale reste un pilote fermé par défaut. **Support → factures fournisseurs US automatique n'est pas livré** : pas de délégation de boîte US, de capture mail US, de curseur/reçu mail US ni de modification du captureur historique CH. Aucun droit Support/CHF ne sert d'autorité au nouveau parcours.

Ne sont pas livrés : OCR, paiement fournisseur, autopost, détermination automatique de taxe, politique de conservation légale, nettoyage R2, migration ou activation hébergée, validation d'un compte fournisseur réel, changement de région, déploiement et adaptation native. Aucun engagement de conformité, précision ou capacité de production n'est déduit des tests locaux. La recette hébergée nécessite encore un environnement distinct et l'approbation explicite de son application. L'objectif ERP US reste actif.
